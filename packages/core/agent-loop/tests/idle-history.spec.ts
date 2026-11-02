/**
 * Idle formal-history maintenance against the real driver: the true idle
 * phases a plugin reaches, the reader round-trip of what it records, and every
 * refusal that must leave the surface untouched.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { AgentHandle, Agent } from '@deepseek-ai/dsh-agent'
import AgentRegistry, { IdleHistoryError } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { MessageId, createSystemMessage, createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, GenerateOptions, Message, UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockAdapter, textResponse } from './mock-adapter.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Formal history recorded by a plugin from the idle phase. */
    'idle-history-test': { kind: 'idle-history-test' } & ContextFormed
  }
}

const SESSION_ID = SessionId('idle-history')
const PERSONA = 'persona: idle history'

interface Services {
  readonly ctx: Context
  readonly adapter: MockAdapter
  readonly root: string
}

interface Harness extends Services {
  readonly handle: AgentHandle
  readonly agent: Agent
  readonly session: Agent['session']
}

const roots: string[] = []
const contexts: Context[] = []

/** Mount the full loop plus the JSONL backend on one storage root. */
async function mountServices(
  script: ConstructorParameters<typeof MockAdapter>[0] = [],
  root?: string,
): Promise<Services> {
  const storage = root ?? await mkdtemp(join(tmpdir(), 'dsh-idle-history-'))
  if (root === undefined) roots.push(storage)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: PERSONA })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: storage, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, adapter, root: storage }
}

/** Mount the services and create the one agent under test. */
async function mount(
  script: ConstructorParameters<typeof MockAdapter>[0] = [],
  root?: string,
): Promise<Harness> {
  const services = await mountServices(script, root)
  const handle = await services.ctx.agents.create({
    sessionId: SESSION_ID,
    agentOptions: { provider: 'mock', model: 'model' },
  })
  return { ...services, handle, agent: handle.agent, session: handle.agent.session }
}

/** Mount the loop services on an existing storage root without creating an agent. */
async function mountReader(root: string): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  return ctx
}

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** One identified formal user message, the way a recording plugin produces it. */
function formalMessage(text: string): UserMessage {
  return freezeMessage<UserMessage>({
    id: MessageId(`idle-info-${text}`),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'idle-history-test' },
  })
}

/** Count each committed session event and each agent notification that would show work. */
function observe(ctx: Context): { readonly count: (type: string) => number; readonly reset: () => void } {
  const counts = new Map<string, number>()
  const bump = (type: string): void => { counts.set(type, (counts.get(type) ?? 0) + 1) }
  ctx.on('session/event', (_session, event) => { bump(event.type) })
  ctx.on('agent/inbox/claimed', () => { bump('agent/inbox/claimed') })
  ctx.on('agent/status', () => { bump('agent/status') })
  return {
    count: type => counts.get(type) ?? 0,
    reset: () => { counts.clear() },
  }
}

/** The rendered system prompt a request carried as its leading system-role message. */
function systemText(request: GenerateOptions): string | undefined {
  const [first] = request.messages
  if (first?.role !== 'system' || first.content.length !== 1) return undefined
  const [block] = first.content
  return block?.type === 'text' ? block.text : undefined
}

/** Run one ordinary turn and resolve when the driver converges to idle. */
function sendAndSettle(ctx: Context, agent: Agent, text: string): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', (payload) => {
      if (payload.agent !== agent || payload.status !== 'idle') return
      dispose()
      resolve()
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  })
}

/** The system prompt text a derived message carries. */
function promptText(message: Message | undefined): string | undefined {
  return message?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

/** Open the committed current generation file under one storage root. */
async function generationLog(root: string): Promise<string> {
  const walk = async (directory: string): Promise<string | undefined> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isFile() && entry.name === `session.v${SESSION_FORMAT_VERSION}.jsonl`) return path
      if (!entry.isDirectory()) continue
      const found = await walk(path)
      if (found !== undefined) return found
    }
    return undefined
  }
  const found = await walk(root)
  if (found === undefined) throw new Error('the session committed no current generation log')
  return found
}

describe('idle formal-history maintenance', () => {
  it('records a rendered head and formal history after a first turn cancelled before any step', async () => {
    const h = await mount([textResponse('never asked')])
    const events = observe(h.ctx)
    // Cancel synchronously after the wake: the turn opens and closes aborted
    // before its first step, leaving no surface head.
    h.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'do it' }], source: { kind: 'user' } }))
    h.agent.cancel({ kind: 'user' })
    await h.agent.whenIdle()
    expect(h.session.surface.nodes).toEqual([])
    expect(h.adapter.requests).toEqual([])
    events.reset()

    const result = await h.agent.maintainIdleHistory!({ message: formalMessage('cancelled-info') })

    expect(result.systemHeadSeq).not.toBeNull()
    expect(result.messageSeq).not.toBeNull()
    expect(result.checkpointed).toBe(true)
    expect(h.session.surface.nodes).toEqual([result.systemHeadSeq, result.messageSeq])
    expect(h.session.surface.nodes.map(seq => h.session.eventAt(seq)?.type)).toEqual(['system/message', 'user/message'])

    const derived = h.session.deriveMessages()
    expect(derived.map(message => message.role)).toEqual(['system', 'user'])
    expect(derived[0]).toMatchObject({ role: 'system', source: { kind: 'system-prompt' } })
    const headText = promptText(derived[0])
    expect(headText).toContain('DeepSeek Harness')
    expect(headText).toContain(PERSONA)
    expect(derived[1]).toMatchObject({ role: 'user', source: { kind: 'idle-history-test' } })

    // The maintenance itself opened no model request, turn, step, or inbox claim,
    // and left the public status alone.
    expect(h.adapter.requests).toEqual([])
    expect(events.count('turn/start')).toBe(0)
    expect(events.count('step/start')).toBe(0)
    expect(events.count('agent/inbox/claimed')).toBe(0)
    expect(events.count('request/header')).toBe(0)
    expect(h.agent.status).toBe('idle')
    expect(h.agent.inbox.nextTurn).toEqual([])
    expect(h.agent.inbox.nextStep).toEqual([])
    expect(events.count('agent/status')).toBe(0)

    // Positive control: the same listeners do observe a real wake and request,
    // so the zeroes above mean the maintenance started no work.
    events.reset()
    await sendAndSettle(h.ctx, h.agent, 'after maintenance')
    expect(events.count('agent/status')).toBeGreaterThan(0)
    expect(events.count('turn/start')).toBe(1)
    expect(h.adapter.requests).toHaveLength(1)
    expect(systemText(h.adapter.requests[0]!)).toBe(headText)
    // The maintenance consumed no turn number: the cancelled turn was 1 and the
    // next native turn is 2, with the recorded history ahead of its own input.
    const turns = h.session.snapshotEvents().flatMap(event => event.type === 'turn/start' ? [event.data.turn] : [])
    expect(turns).toEqual([1, 2])
    const request = h.adapter.requests[0]!
    expect(request.messages.map(message => message.role)).toEqual(['system', 'user', 'user'])
    expect(request.messages[1]?.content).toEqual([{ type: 'text', text: 'cancelled-info' }])
    expect(request.messages[2]?.content).toEqual([{ type: 'text', text: 'after maintenance' }])
  })

  it('records formal history after a rejected pre-step that opened no step', async () => {
    const h = await mount([textResponse('never asked')])
    const disposer = h.ctx.on('agent/pre-step', () => Promise.resolve({ kind: 'reject' as const }))
    h.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'rejected' }], source: { kind: 'user' } }))
    await h.agent.whenIdle()
    disposer()
    expect(h.session.surface.nodes).toEqual([])
    expect(h.adapter.requests).toEqual([])

    const result = await h.agent.maintainIdleHistory!({ message: formalMessage('rejected-info') })

    expect(h.session.surface.nodes).toEqual([result.systemHeadSeq, result.messageSeq])
    expect(h.session.deriveMessages().map(message => message.role)).toEqual(['system', 'user'])
    expect(result.checkpointed).toBe(true)
  })

  it('keeps the single existing head when it records history after a completed turn', async () => {
    const h = await mount([textResponse('done')])
    await sendAndSettle(h.ctx, h.agent, 'first')
    const surfaceBefore = h.session.surface.nodes
    expect(surfaceBefore.map(seq => h.session.eventAt(seq)?.type)).toEqual(['system/message', 'user/message', 'assistant/message'])

    const result = await h.agent.maintainIdleHistory!({ message: formalMessage('completed-info') })

    expect(result.systemHeadSeq).toBeNull()
    expect(result.messageSeq).not.toBeNull()
    expect(h.session.surface.nodes.slice(0, surfaceBefore.length)).toEqual(surfaceBefore)
    expect(h.session.surface.nodes.at(-1)).toBe(result.messageSeq)
    expect(h.session.deriveMessages().map(message => message.role)).toEqual(['system', 'user', 'assistant', 'user'])
  })

  it('reopens the JSONL generation and lets a later turn assemble the recorded history in order', async () => {
    const h = await mount([textResponse('done')])
    h.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'do it' }], source: { kind: 'user' } }))
    h.agent.cancel({ kind: 'user' })
    await h.agent.whenIdle()
    const recorded = await h.agent.maintainIdleHistory!({ message: formalMessage('reopen-info') })
    const headText = promptText(h.session.deriveMessages()[0])
    const root = h.root
    await h.handle.dispose()
    await h.ctx.fiber.dispose()

    // The committed generation carries the maintenance head as a required row.
    const log = await readFile(await generationLog(root), 'utf8')
    const rows = log.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    const headRow = rows.find(row => row['type'] === 'system/message')
    expect(headRow).toBeDefined()
    expect(headRow?.['surfaceOp']).toBe('append')
    const headData = headRow?.['data'] as { maintenance?: unknown; message?: { content?: readonly { type?: string; text?: string }[] } }
    expect(headData.maintenance).toBe(true)
    expect(Object.hasOwn(headData, 'turn')).toBe(false)
    expect(Object.hasOwn(headData, 'step')).toBe(false)
    expect(headData.message?.content?.flatMap(block => block.type === 'text' && block.text !== undefined ? [block.text] : []).join('')).toBe(headText)
    expect(rows.filter(row => row['type'] === 'system/message')).toHaveLength(1)

    // An independent reader accepts the generation without the writer.
    const reader = await mountReader(root)
    const readHandle = await reader.sessionPersistence.open(SESSION_ID, 'read')
    try {
      const cold = await readHandle.read(0, undefined)
      expect(cold.events.filter(event => event.type === 'system/message')).toHaveLength(1)
      expect(cold.events.some(event => event.type === 'user/message'
        && event.data.source.kind === 'idle-history-test')).toBe(true)
    } finally {
      await readHandle.close()
    }
    await reader.fiber.dispose()

    // Resume the same session: the next real turn carries the recorded head and
    // message ahead of its own input, with no duplicate system head.
    const resumedHost = await mountServices([], root)
    const resumed = await resumedHost.ctx.agents.resume({
      resumeSessionId: SESSION_ID,
      agentOptions: { provider: 'mock', model: 'model' },
    })
    const agent = resumed.agent
    expect(agent.session.surface.nodes.filter(seq => agent.session.eventAt(seq)?.type === 'system/message')).toHaveLength(1)
    await sendAndSettle(resumedHost.ctx, agent, 'after resume')
    const request = resumedHost.adapter.requests.at(-1)
    expect(request).toBeDefined()
    expect(request!.messages.map(message => message.role)).toEqual(['system', 'user', 'user'])
    expect(systemText(request!)).toBe(headText)
    expect(request!.messages[1]?.content).toEqual([{ type: 'text', text: 'reopen-info' }])
    expect(request!.messages[2]?.content).toEqual([{ type: 'text', text: 'after resume' }])
    expect(agent.session.surface.nodes.filter(seq => agent.session.eventAt(seq)?.type === 'system/message')).toHaveLength(1)
    expect(recorded.messageSeq).not.toBeNull()
    await resumed.dispose()
  })

  it('refuses while a turn or another maintenance task owns the agent', async () => {
    const h = await mount([textResponse('never asked')])
    const inside = Promise.withResolvers<unknown>()
    const disposer = h.ctx.on('agent/pre-step', async () => {
      inside.resolve(await h.agent.maintainIdleHistory!({ message: formalMessage('during-turn') })
        .catch((error: unknown) => error))
      return { kind: 'reject' as const }
    })
    h.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hold' }], source: { kind: 'user' } }))
    const turnRefusal = await inside.promise
    disposer()
    await h.agent.whenIdle()
    expect(turnRefusal).toBeInstanceOf(IdleHistoryError)
    expect((turnRefusal as IdleHistoryError).failure).toBe('not-idle')
    expect(h.session.surface.nodes).toEqual([])

    let release!: () => void
    const maintenance = h.agent.runMaintenance(() => new Promise<void>((resolve) => { release = resolve }))
    const nested = await h.agent.maintainIdleHistory!({ message: formalMessage('nested') })
      .catch((error: unknown) => error)
    expect(nested).toBeInstanceOf(IdleHistoryError)
    expect((nested as IdleHistoryError).failure).toBe('not-idle')
    release()
    await maintenance
    expect(h.session.surface.nodes).toEqual([])
  })

  it('refuses when another writer takes the surface head while the prompt is assembled', async () => {
    const h = await mount()
    const intruder = createUserMessage({ content: [{ type: 'text', text: 'someone else' }], source: { kind: 'user' } })
    const disposer = h.ctx.systemPrompt.section({
      name: 'test:intruder',
      order: 1,
      text: (context) => {
        const session = context.agent?.session
        if (session !== undefined && session.surface.nodes.length === 0) {
          session.append('user/message', intruder, { surfaceOp: 'append' })
        }
        return ''
      },
    })
    const failure = await h.agent.maintainIdleHistory!({ message: formalMessage('conflicted') })
      .catch((error: unknown) => error)
    disposer()
    expect(failure).toBeInstanceOf(IdleHistoryError)
    expect((failure as IdleHistoryError).failure).toBe('history-conflict')
    expect(h.session.surface.nodes).toHaveLength(1)
    expect(h.session.deriveMessages()).toHaveLength(1)
    expect(h.session.deriveMessages()[0]?.content).toEqual([{ type: 'text', text: 'someone else' }])
  })

  it('refuses when the maintenance is cancelled while the prompt is assembled', async () => {
    const h = await mount()
    const disposer = h.ctx.systemPrompt.section({
      name: 'test:cancel',
      order: 1,
      text: (context) => {
        const agent = context.agent
        if (agent !== undefined && agent.session.surface.nodes.length === 0) agent.cancel({ kind: 'user' })
        return ''
      },
    })
    const failure = await h.agent.maintainIdleHistory!({ message: formalMessage('aborted') })
      .catch((error: unknown) => error)
    disposer()
    expect(failure).toBeInstanceOf(IdleHistoryError)
    expect((failure as IdleHistoryError).failure).toBe('aborted')
    expect(h.session.surface.nodes).toEqual([])
  })

  it('reports a failed checkpoint without duplicating the recorded message on retry', async () => {
    const h = await mount()
    const flushFailure = h.ctx.on('session/flush', () => {
      throw new Error('disk full')
    })
    const message = formalMessage('checkpoint-info')
    const failure = await h.agent.maintainIdleHistory!({ message }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(IdleHistoryError)
    const error = failure as IdleHistoryError
    expect(error.failure).toBe('checkpoint')
    expect(error.append?.messageSeq).not.toBeNull()
    expect(error.append?.systemHeadSeq).not.toBeNull()
    expect(String(error.cause)).toContain('disk full')
    expect(h.session.surface.nodes).toHaveLength(2)

    // The append committed; a retry with the same identity must not record it twice.
    await expect(h.agent.maintainIdleHistory!({ message })).rejects.toMatchObject({ failure: 'checkpoint' })
    expect(h.session.surface.nodes).toHaveLength(2)

    flushFailure()
    const retried = await h.agent.maintainIdleHistory!({ message })
    expect(retried).toMatchObject({
      systemHeadSeq: null,
      messageSeq: error.append?.messageSeq,
      appended: false,
      checkpointed: true,
    })
    expect(h.session.surface.nodes).toHaveLength(2)
  })

  it('refuses the same identity with different content instead of treating it as a retry', async () => {
    const h = await mount()
    const first = formalMessage('original')
    const recorded = await h.agent.maintainIdleHistory!({ message: first })
    expect(recorded.appended).toBe(true)

    const sameIdentity: UserMessage = freezeMessage<UserMessage>({
      id: first.id,
      role: 'user',
      content: [{ type: 'text', text: 'different content' }],
      source: { kind: 'idle-history-test' },
    })
    const contentConflict = await h.agent.maintainIdleHistory!({ message: sameIdentity })
      .catch((error: unknown) => error)
    expect(contentConflict).toBeInstanceOf(IdleHistoryError)
    expect((contentConflict as IdleHistoryError).failure).toBe('history-conflict')
    expect(String(contentConflict)).toContain('with different content')

    const otherSource: UserMessage = freezeMessage<UserMessage>({
      id: first.id,
      role: 'user',
      content: first.content,
      source: { kind: 'user' },
    })
    const sourceConflict = await h.agent.maintainIdleHistory!({ message: otherSource })
      .catch((error: unknown) => error)
    expect((sourceConflict as IdleHistoryError).failure).toBe('history-conflict')

    // A genuine retry of the exact same message stays idempotent.
    const retried = await h.agent.maintainIdleHistory!({ message: formalMessage('original') })
    expect(retried).toMatchObject({ appended: false, messageSeq: recorded.messageSeq, systemHeadSeq: null })
    expect(h.session.surface.nodes).toHaveLength(2)
  })

  it('records the message as it was when the call started, not later mutation', async () => {
    const h = await mount()
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const disposer = h.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      started.resolve(undefined)
      await release.promise
      return next()
    })
    const mutable = {
      id: MessageId('mutated'),
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'before' }],
      source: { kind: 'idle-history-test' as const },
    }
    const pending = h.agent.maintainIdleHistory!({ message: mutable as unknown as UserMessage })
    await started.promise
    mutable.content = [{ type: 'text', text: 'after' }]
    mutable.source = { kind: 'user' } as never
    release.resolve(undefined)
    const result = await pending
    disposer()
    const recorded = h.session.surfaceMessage(MessageId('mutated'))
    expect(recorded?.seq).toBe(result.messageSeq)
    expect(recorded?.message.content).toEqual([{ type: 'text', text: 'before' }])
    expect(recorded?.message.source).toEqual({ kind: 'idle-history-test' })
  })

  it('refuses a non-empty surface whose first node is not a protected system head', async () => {
    const h = await mount()
    h.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'foreign writer' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const surfaceBefore = h.session.surface.nodes
    const failure = await h.agent.maintainIdleHistory!({ message: formalMessage('unplaceable') })
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(IdleHistoryError)
    expect((failure as IdleHistoryError).failure).toBe('history-conflict')
    expect(h.session.surface.nodes).toEqual(surfaceBefore)
    expect(h.session.deriveMessages()).toHaveLength(1)
  })

  it('accepts a legally recorded empty system head and appends no second head', async () => {
    const h = await mount()
    h.session.append('system/message', { maintenance: true, message: createSystemMessage('') }, { surfaceOp: 'append' })
    const result = await h.agent.maintainIdleHistory!({ message: formalMessage('after-empty-head') })
    expect(result).toMatchObject({ systemHeadSeq: null, appended: true })
    expect(h.session.surface.nodes).toHaveLength(2)
    expect(h.session.snapshotEvents().filter(event => event.type === 'system/message')).toHaveLength(1)
    expect(h.session.deriveMessages().map(message => message.role)).toEqual(['user'])
  })

  it('assembles the current prompt registry rather than a cached rendering', async () => {
    const h = await mount()
    const first = h.ctx.systemPrompt.section({ name: 'test:dynamic', order: 1, text: 'first prompt version' })
    first()
    const second = h.ctx.systemPrompt.section({ name: 'test:dynamic', order: 1, text: 'second prompt version' })
    const result = await h.agent.maintainIdleHistory!({ message: formalMessage('dynamic') })
    second()
    expect(result.systemHeadSeq).not.toBeNull()
    const headText = promptText(h.session.deriveMessages()[0])
    expect(headText).toContain('second prompt version')
    expect(headText).not.toContain('first prompt version')
  })

  it('reopens a partial head prefix and continues by appending only the message', async () => {
    const h = await mount()
    const partialHead = h.session.append(
      'system/message',
      { maintenance: true, message: createSystemMessage('partial head') },
      { surfaceOp: 'append' },
    )
    await h.ctx.sessions.flush(h.session)
    const root = h.root
    await h.handle.dispose()
    await h.ctx.fiber.dispose()

    const host = await mountServices([], root)
    const resumed = await host.ctx.agents.resume({
      resumeSessionId: SESSION_ID,
      agentOptions: { provider: 'mock', model: 'model' },
    })
    const agent = resumed.agent
    expect(agent.session.systemHeadSeq()).toBe(partialHead.seq)
    const result = await agent.maintainIdleHistory!({ message: formalMessage('after-prefix') })
    expect(result).toMatchObject({ systemHeadSeq: null, appended: true })
    expect(agent.session.surface.nodes).toEqual([partialHead.seq, result.messageSeq])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'system/message')).toHaveLength(1)
    // The next native turn reconciles the partial head through ordinary prompt
    // admission: one system node on the surface, replaced in place.
    await sendAndSettle(host.ctx, agent, 'continue')
    const systemNodes = agent.session.surface.nodes
      .filter(seq => agent.session.eventAt(seq)?.type === 'system/message')
    expect(systemNodes).toHaveLength(1)
    expect(systemNodes[0]).not.toBe(partialHead.seq)
    const request = host.adapter.requests.at(-1)!
    expect(request.messages.map(message => message.role)).toEqual(['system', 'user', 'user'])
    expect(request.messages[1]?.content).toEqual([{ type: 'text', text: 'after-prefix' }])
    await resumed.dispose()
  })

  it('refuses after this agent stopped being the live agent for its session', async () => {
    const h = await mount()
    await h.handle.dispose()
    const failure = await h.agent.maintainIdleHistory!({ message: formalMessage('stale') })
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(IdleHistoryError)
    expect((failure as IdleHistoryError).failure).toBe('agent-changed')
  })

  it('records nothing when prompt assembly fails', async () => {
    const h = await mount()
    const disposer = h.ctx.systemPrompt.section({
      name: 'test:broken',
      order: 1,
      text: () => { throw new Error('assembly failed') },
    })
    const failure = await h.agent.maintainIdleHistory!({ message: formalMessage('never') })
      .catch((error: unknown) => error)
    disposer()
    expect(String(failure)).toContain('assembly failed')
    expect(h.session.surface.nodes).toEqual([])
    expect(h.session.deriveMessages()).toEqual([])
  })
})
