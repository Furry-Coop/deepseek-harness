import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionLogOffset, SessionSeq, type Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionTitleService, {
  SessionTitleProviderId,
  foldSessionTitle,
  selectSessionTitleInputRefs,
} from '@deepseek-ai/dsh-session-title'
import type {
  SessionTitleInputRef,
  SessionTitleProviderRequest,
  SessionTitleProviderResult,
} from '@deepseek-ai/dsh-session-title'
import { describe, expect, it } from 'vitest'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Test-only host rewrite that keeps the prompt request id. */
    'test-nodes-handoff': { kind: 'test-nodes-handoff'; rpcId: string }
  }
}

const CONFIG = { fallbackMaxWords: 8, fallbackMaxBytes: 64, maxTitleBytes: 256 }
let nextSession = 0

interface Harness {
  readonly ctx: Context
  readonly session: Session
  readonly requests: SessionTitleProviderRequest[]
}

async function harness(provider = true): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionTitleService, CONFIG)
  const requests: SessionTitleProviderRequest[] = []
  if (provider) {
    ctx.sessionTitle.register({
      id: SessionTitleProviderId('test-title-provider'),
      automatic: 'first-prompt',
      generate: async (request): Promise<SessionTitleProviderResult> => {
        requests.push(request)
        return {
          title: 'Handoff title',
          messageSeqs: request.messages.map(message => message.seq),
        }
      },
    })
  }
  const session = ctx.sessions.create(SessionId(`rewritten-${String(++nextSession)}`), { meta: { cwd: '/workspace' } })
  return { ctx, session, requests }
}

/** Append the real Host order for one rewritten human prompt, returning the original message. */
function appendRewrittenPrompt(
  session: Session,
  options: {
    readonly text: string
    readonly effective: string
    readonly rpcId: string
    readonly admittedRpcId?: string
  },
): UserMessage {
  const original = createUserMessage({
    content: [{ type: 'text', text: options.text }],
    source: { kind: 'user', rpcId: options.rpcId },
  })
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [original] })
  session.append('turn/start', { turn: 1 })
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', freezeMessage({
    ...original,
    content: [{ type: 'text', text: options.effective }],
    source: { kind: 'test-nodes-handoff', rpcId: options.admittedRpcId ?? options.rpcId },
  }), { surfaceOp: 'append' })
  return original
}

describe('title input from a claimed Inbox occurrence', () => {
  it('derives the title from the original text and freezes the exact origin refs', async () => {
    const { ctx, session, requests } = await harness()
    const original = appendRewrittenPrompt(session, {
      text: '原始真人请求：修复分页',
      effective: '节点交接后的有效请求',
      rpcId: 'req-1',
    })
    await ctx.sessionTitle.refresh(session)

    expect(requests).toHaveLength(1)
    expect(requests[0]?.messages).toEqual([{ seq: 4, text: '原始真人请求：修复分页' }])
    expect(requests[0]?.inputRefs).toEqual([{
      kind: 'origin',
      originalInboxSeq: 0,
      messageId: original.id,
      claimSeq: 2,
      admittedSeq: 4,
    }])

    const event = session.snapshotEvents().findLast(item =>
      item.type === 'session/title' || item.type === 'session/title-from-input')
    expect(event).toMatchObject({
      type: 'session/title-from-input',
      data: {
        title: 'Handoff title',
        inputRefs: [{
          kind: 'origin',
          originalInboxSeq: 0,
          messageId: original.id,
          claimSeq: 2,
          admittedSeq: 4,
        }],
        source: { kind: 'provider', provider: 'test-title-provider' },
      },
    })
    expect(foldSessionTitle(session.snapshotEvents())).toMatchObject({
      title: 'Handoff title',
      messageSeqs: [],
      inputRefs: [{ kind: 'origin', admittedSeq: 4 }],
    })
    // The original text stays in the log-only occurrence and title audit; the
    // model surface keeps only the effective admitted message.
    const surface = JSON.stringify(session.deriveMessages())
    expect(surface).not.toContain('原始真人请求')
    expect(surface).toContain('节点交接后的有效请求')
  })

  it('rejects a same-id admission with a different request correlation', async () => {
    const { ctx, session, requests } = await harness()
    appendRewrittenPrompt(session, {
      text: '原始请求',
      effective: '外来改写',
      rpcId: 'req-1',
      admittedRpcId: 'req-2',
    })
    await ctx.sessionTitle.refresh(session)
    expect(requests).toHaveLength(0)
    expect(ctx.sessionTitle.get(session)).toBeUndefined()
  })

  it('unifies ordinary and rewritten inputs in admission order', async () => {
    const { ctx, session, requests } = await harness()
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '普通首条' }],
      source: { kind: 'user', rpcId: 'req-0' },
    }), { surfaceOp: 'append' })
    appendRewrittenPrompt(session, {
      text: '被接管的原始请求',
      effective: '有效派生请求',
      rpcId: 'req-1',
    })
    await ctx.sessionTitle.refresh(session)
    expect(requests[0]?.messages.map(message => message.text)).toEqual(['普通首条', '被接管的原始请求'])
    expect(requests[0]?.inputRefs).toEqual([
      { kind: 'message', messageSeq: 0 },
      { kind: 'origin', originalInboxSeq: 1, messageId: expect.any(String), claimSeq: 3, admittedSeq: 5 },
    ])
  })

  it('keeps the service canonical inputs when a provider tries to mutate them', async () => {
    const { ctx, session } = await harness(false)
    let refsFrozen = false
    let messageFrozen = false
    ctx.sessionTitle.register({
      id: SessionTitleProviderId('test-mutating-provider'),
      automatic: 'first-prompt',
      generate: async (request): Promise<SessionTitleProviderResult> => {
        try {
          (request.inputRefs as SessionTitleInputRef[]).push({ kind: 'message', messageSeq: SessionSeq(0) })
        } catch {
          refsFrozen = true
        }
        try {
          (request.messages[0] as { seq: number }).seq = 0
        } catch {
          messageFrozen = true
        }
        return { title: 'Frozen title', messageSeqs: [request.messages[0]!.seq] }
      },
    })
    const original = appendRewrittenPrompt(session, {
      text: '不可篡改原文',
      effective: '有效消息',
      rpcId: 'req-1',
    })
    await ctx.sessionTitle.refresh(session)

    expect(refsFrozen).toBe(true)
    expect(messageFrozen).toBe(true)
    const event = session.snapshotEvents().findLast(item =>
      item.type === 'session/title' || item.type === 'session/title-from-input')
    expect(event?.type).toBe('session/title-from-input')
    expect(event?.type === 'session/title-from-input' ? event.data.inputRefs : undefined).toEqual([{
      kind: 'origin',
      originalInboxSeq: 0,
      messageId: original.id,
      claimSeq: 2,
      admittedSeq: 4,
    }])
  })

  it('reproduces the full title input from a checkpoint plus its suffix and refolds a missing row', async () => {
    const { ctx, session } = await harness(false)
    const original = createUserMessage({
      content: [{ type: 'text', text: '原始真人请求' }],
      source: { kind: 'user', rpcId: 'req-1' },
    })
    session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [original] })
    session.append('turn/start', { turn: 1 })
    session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
    const partial = ctx.sessionProjections.checkpoint(session)
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', freezeMessage({
      ...original,
      content: [{ type: 'text', text: '有效派生请求' }],
      source: { kind: 'test-nodes-handoff', rpcId: 'req-1' },
    }), { surfaceOp: 'append' })
    const full = ctx.sessionProjections.checkpoint(session)
    const events = session.snapshotEvents()
    const restored = ctx.sessionProjections.restore(
      partial, events, SessionLogOffset(0), session.header, session.inheritedEventCount,
    )
    expect(restored.checkpoint.titleInput?.val).toEqual(full.titleInput?.val)
    const rebuilt = ctx.sessionProjections.restore(
      {}, events, SessionLogOffset(0), session.header, session.inheritedEventCount,
    )
    expect(rebuilt.checkpoint.titleInput?.val).toEqual(full.titleInput?.val)
  })
})

describe('selectSessionTitleInputRefs', () => {
  const messageId = createUserMessage({ content: [], source: { kind: 'user' } }).id
  const messages = [
    { seq: SessionSeq(2), text: 'first' },
    { seq: SessionSeq(5), text: 'second' },
  ]
  const inputRefs: SessionTitleInputRef[] = [
    { kind: 'message', messageSeq: SessionSeq(2) },
    { kind: 'origin', originalInboxSeq: SessionSeq(0), messageId, claimSeq: SessionSeq(3), admittedSeq: SessionSeq(5) },
  ]

  it('returns the exact refs in the provider selection order', () => {
    expect(selectSessionTitleInputRefs(messages, inputRefs, [SessionSeq(2), SessionSeq(5)]))
      .toEqual(inputRefs)
    expect(selectSessionTitleInputRefs(messages, inputRefs, [SessionSeq(5)]))
      .toEqual([inputRefs[1]])
  })

  it('rejects an empty selection', () => {
    expect(() => selectSessionTitleInputRefs(messages, inputRefs, []))
      .toThrow(/at least one source message seq/)
  })

  it('rejects a duplicated or descending selection', () => {
    expect(() => selectSessionTitleInputRefs(messages, inputRefs, [SessionSeq(2), SessionSeq(2)]))
      .toThrow(/unique and ordered/)
    expect(() => selectSessionTitleInputRefs(messages, inputRefs, [SessionSeq(5), SessionSeq(2)]))
      .toThrow(/unique and ordered/)
  })

  it('rejects a seq outside the request', () => {
    expect(() => selectSessionTitleInputRefs(messages, inputRefs, [SessionSeq(9)]))
      .toThrow(/outside the request/)
  })

  it('rejects arrays that are not parallel', () => {
    expect(() => selectSessionTitleInputRefs(messages, [inputRefs[0]!], [SessionSeq(2)]))
      .toThrow(/not parallel/)
  })
})
