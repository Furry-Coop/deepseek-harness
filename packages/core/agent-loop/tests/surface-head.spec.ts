/**
 * Protected surface-head maintenance against the real driver: the head a plugin
 * needs before its own first surface write, the reader round-trip of the log
 * that follows, and every refusal that must leave the surface untouched.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { AgentHandle, Agent } from '@deepseek-ai/dsh-agent'
import AgentRegistry, { SurfaceHeadError } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { MessageId, createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, GenerateOptions, Message, UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockAdapter, textResponse } from './mock-adapter.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A plugin-owned surface message written from `agent/pre-step`. */
    'surface-head-test': { kind: 'surface-head-test' } & ContextFormed
  }
}

const SESSION_ID = SessionId('surface-head')
const PERSONA = 'persona: surface head'

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
  prompt: Record<string, unknown> = { personaPrefix: PERSONA },
): Promise<Services> {
  const storage = root ?? await mkdtemp(join(tmpdir(), 'dsh-surface-head-'))
  if (root === undefined) roots.push(storage)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, prompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
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
  prompt?: Record<string, unknown>,
): Promise<Harness> {
  const services = await mountServices(script, root, prompt)
  const handle = await services.ctx.agents.create({
    sessionId: SESSION_ID,
    agentOptions: { provider: 'mock', model: 'model' },
  })
  return { ...services, handle, agent: handle.agent, session: handle.agent.session }
}

/** Mount only the services a cold reader needs on an existing storage root. */
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

/** Count committed session events and agent notifications that would show work. */
function observe(ctx: Context): { readonly count: (type: string) => number; readonly reset: () => void } {
  const counts = new Map<string, number>()
  const bump = (type: string): void => { counts.set(type, (counts.get(type) ?? 0) + 1) }
  ctx.on('session/event', (_session, event) => { bump(event.type) })
  ctx.on('session/flush', () => { bump('session/flush') })
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

/** The text a derived or request message carries, as the model receives it. */
function messageText(message: Message | GenerateOptions['messages'][number] | undefined): string | undefined {
  return message?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
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

/** One plugin-owned surface message, the shape a workdesk block has. */
function blockMessage(text: string): UserMessage {
  return freezeMessage<UserMessage>({
    id: MessageId(`block-${text}`),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'surface-head-test' },
  })
}

/** The committed system nodes of one session, in surface order. */
function systemNodes(session: Agent['session']): number[] {
  return session.surface.nodes.filter(seq => session.eventAt(seq)?.type === 'system/message')
}

describe('protected surface-head maintenance', () => {
  it('establishes the rendered head on an empty surface and starts no work', async () => {
    const h = await mount([textResponse('answer')])
    const events = observe(h.ctx)

    const result = await h.agent.maintainSurfaceHead!()

    expect(result).toMatchObject({ appended: true, checkpointed: true })
    expect(h.session.surface.nodes).toEqual([result.headSeq])
    expect(h.session.eventAt(result.headSeq)?.type).toBe('system/message')
    const headEvent = h.session.eventAt(result.headSeq)
    if (headEvent?.type !== 'system/message') throw new Error('committed head is not a system message')
    expect('maintenance' in headEvent.data && headEvent.data.maintenance).toBe(true)
    expect('turn' in headEvent.data).toBe(false)
    expect('step' in headEvent.data).toBe(false)
    const headText = messageText(h.session.deriveMessages()[0])
    expect(headText).toContain('DeepSeek Harness')
    expect(headText).toContain(PERSONA)

    // No message, turn, step, request, or inbox claim belongs to the maintenance.
    expect(events.count('turn/start')).toBe(0)
    expect(events.count('step/start')).toBe(0)
    expect(events.count('request/header')).toBe(0)
    expect(events.count('agent/inbox/claimed')).toBe(0)
    expect(events.count('session/flush')).toBe(1)
    expect(h.adapter.requests).toEqual([])
    expect(h.agent.status).toBe('idle')
    expect(h.agent.inbox.nextTurn).toEqual([])
    expect(h.agent.inbox.nextStep).toEqual([])
    expect(h.session.snapshotEvents().filter(event => event.type === 'user/message')).toEqual([])

    // Positive control: the next real turn reads the same head as its one system
    // message and reconciles nothing, so the maintenance added no work.
    await sendAndSettle(h.ctx, h.agent, 'after head')
    expect(systemText(h.adapter.requests.at(-1)!)).toBe(headText)
    expect(systemNodes(h.session)).toEqual([result.headSeq])
    expect(h.adapter.requests.at(-1)!.messages.map(message => message.role)).toEqual(['system', 'user'])
  })

  it('lets a plugin pre-step write land after the head and cold-reopen as a valid log', async () => {
    const h = await mount([textResponse('answered')])
    const head = await h.agent.maintainSurfaceHead!()
    const block = blockMessage('workdesk block for this turn')
    const dispose = h.ctx.on('agent/pre-step', async (_payload, next) => {
      // A plugin that only learns about its first surface write at the boundary:
      // the head already exists, so appending before step/start is legal.
      if (systemNodes(h.session).length === 1 && h.session.snapshotEvents().filter(event => event.type === 'step/start').length === 0) {
        h.session.append('user/message', block, { surfaceOp: 'append' })
      }
      return await next()
    })
    await sendAndSettle(h.ctx, h.agent, 'first business question')
    dispose()

    // Surface order: head, plugin message, then the turn's own admitted input.
    expect(h.session.surface.nodes.map(seq => h.session.eventAt(seq)?.type)).toEqual([
      'system/message', 'user/message', 'user/message', 'assistant/message',
    ])
    const stepStart = h.session.snapshotEvents().find(event => event.type === 'step/start')!
    const blockSeq = h.session.surface.nodes[1]!
    expect(blockSeq).toBeLessThan(stepStart.seq)
    expect(head.headSeq).toBeLessThan(blockSeq)
    const request = h.adapter.requests.at(-1)!
    expect(request.messages.map(message => message.role)).toEqual(['system', 'user', 'user'])
    expect(request.messages[1]?.content).toEqual([{ type: 'text', text: 'workdesk block for this turn' }])
    expect(request.messages[2]?.content).toEqual([{ type: 'text', text: 'first business question' }])
    expect(systemText(request)).toBe(messageText(h.session.deriveMessages()[0]))

    // The released reader accepts the generation without the writer.
    const root = h.root
    await h.handle.dispose()
    await h.ctx.fiber.dispose()
    const reader = await mountReader(root)
    const readHandle = await reader.sessionPersistence.open(SESSION_ID, 'read')
    try {
      const cold = await readHandle.read()
      expect(cold.events.filter(event => event.type === 'system/message')).toHaveLength(1)
      expect(cold.events.find(event => event.type === 'system/message')!.seq).toBeLessThan(blockSeq)
      expect(cold.events.some(event => event.type === 'user/message'
        && event.data.source.kind === 'surface-head-test')).toBe(true)
    } finally {
      await readHandle.close()
    }
  })

  it('keeps an existing head, writes nothing, and still confirms durability', async () => {
    const h = await mount([textResponse('done')])
    await sendAndSettle(h.ctx, h.agent, 'first')
    const surfaceBefore = h.session.surface.nodes
    const events = observe(h.ctx)

    const result = await h.agent.maintainSurfaceHead!()

    expect(result).toMatchObject({ appended: false, headSeq: systemNodes(h.session)[0], checkpointed: true })
    expect(events.count('session/flush')).toBe(1)
    expect(h.session.surface.nodes).toEqual(surfaceBefore)
    expect(h.session.snapshotEvents().filter(event => event.type === 'system/message')).toHaveLength(1)
    expect(h.adapter.requests).toHaveLength(1)
  })

  it('reports a failed no-op checkpoint and confirms durability on retry', async () => {
    const h = await mount([textResponse('done')])
    await sendAndSettle(h.ctx, h.agent, 'first')
    const surfaceBefore = h.session.surface.nodes
    const flushFailure = h.ctx.on('session/flush', () => {
      throw new Error('disk full')
    })

    const failure = await h.agent.maintainSurfaceHead!().catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(SurfaceHeadError)
    const error = failure as SurfaceHeadError
    expect(error.failure).toBe('checkpoint')
    expect(error.head).toMatchObject({ headSeq: systemNodes(h.session)[0], appended: false })
    expect(String(error.cause)).toContain('disk full')
    expect(h.session.surface.nodes).toEqual(surfaceBefore)

    await expect(h.agent.maintainSurfaceHead!()).rejects.toMatchObject({ failure: 'checkpoint' })
    expect(h.session.surface.nodes).toEqual(surfaceBefore)
    flushFailure()
    const retried = await h.agent.maintainSurfaceHead!()
    expect(retried).toMatchObject({ appended: false, checkpointed: true, headSeq: systemNodes(h.session)[0] })
    expect(h.session.snapshotEvents().filter(event => event.type === 'system/message')).toHaveLength(1)
  })

  it('reports the committed head when the first checkpoint fails and a retry settles it', async () => {
    const h = await mount()
    const flushFailure = h.ctx.on('session/flush', () => {
      throw new Error('disk full')
    })

    const failure = await h.agent.maintainSurfaceHead!().catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(SurfaceHeadError)
    const error = failure as SurfaceHeadError
    expect(error.failure).toBe('checkpoint')
    expect(error.head?.appended).toBe(true)
    expect(error.head?.headSeq).toBe(h.session.surface.nodes[0])
    expect(String(error.cause)).toContain('disk full')
    expect(systemNodes(h.session)).toEqual([error.head!.headSeq])

    // The committed head is not rolled back and is never duplicated.
    await expect(h.agent.maintainSurfaceHead!()).rejects.toMatchObject({ failure: 'checkpoint' })
    expect(systemNodes(h.session)).toEqual([error.head!.headSeq])
    flushFailure()
    const retried = await h.agent.maintainSurfaceHead!()
    expect(retried).toMatchObject({ appended: false, headSeq: error.head!.headSeq, checkpointed: true })
    expect(systemNodes(h.session)).toEqual([error.head!.headSeq])
    expect(h.session.snapshotEvents().filter(event => event.type === 'system/message')).toHaveLength(1)
  })

  it('keeps the committed head when the publication synchronously cancels the maintenance', async () => {
    const h = await mount()
    const heads: number[] = []
    const dispose = h.ctx.on('session/event', (session, event) => {
      if (session !== h.session || event.type !== 'system/message') return
      heads.push(event.seq)
      h.agent.cancel({ kind: 'user' })
    })
    const failure = await h.agent.maintainSurfaceHead!().catch((error: unknown) => error)
    dispose()

    expect(heads).toHaveLength(1)
    expect(failure).toBeInstanceOf(SurfaceHeadError)
    const error = failure as SurfaceHeadError
    expect(error.failure).toBe('aborted')
    expect(error.head).toMatchObject({ headSeq: heads[0], appended: true })
    expect(h.session.surface.nodes).toEqual([heads[0]])
    expect(h.agent.status).toBe('idle')

    const retried = await h.agent.maintainSurfaceHead!()
    expect(retried).toMatchObject({ appended: false, headSeq: heads[0], checkpointed: true })
    expect(systemNodes(h.session)).toEqual([heads[0]])
  })

  it('refuses a non-empty surface whose first node is not a protected head', async () => {
    const h = await mount()
    h.session.append('user/message', blockMessage('foreign writer'), { surfaceOp: 'append' })
    const seqBefore = h.session.seq

    const failure = await h.agent.maintainSurfaceHead!().catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(SurfaceHeadError)
    expect((failure as SurfaceHeadError).failure).toBe('history-conflict')
    expect(h.session.seq).toBe(seqBefore)
    expect(h.session.surface.nodes).toHaveLength(1)
    expect(systemNodes(h.session)).toEqual([])
  })

  it('refuses while a turn or another maintenance task owns the agent', async () => {
    const h = await mount([textResponse('never asked')])
    const inside = Promise.withResolvers<unknown>()
    const disposer = h.ctx.on('agent/pre-step', async () => {
      inside.resolve(await h.agent.maintainSurfaceHead!().catch((error: unknown) => error))
      return { kind: 'reject' as const }
    })
    h.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hold' }], source: { kind: 'user' } }))
    const turnRefusal = await inside.promise
    disposer()
    await h.agent.whenIdle()
    expect(turnRefusal).toBeInstanceOf(SurfaceHeadError)
    expect((turnRefusal as SurfaceHeadError).failure).toBe('not-idle')
    expect(h.session.surface.nodes).toEqual([])

    let release!: () => void
    const maintenance = h.agent.runMaintenance(() => new Promise<void>((resolve) => { release = resolve }))
    const nested = await h.agent.maintainSurfaceHead!().catch((error: unknown) => error)
    expect(nested).toBeInstanceOf(SurfaceHeadError)
    expect((nested as SurfaceHeadError).failure).toBe('not-idle')
    release()
    await maintenance
    expect(h.session.surface.nodes).toEqual([])
  })

  it('refuses when another writer takes the surface while the prompt is assembled', async () => {
    const h = await mount()
    const disposer = h.ctx.systemPrompt.section({
      name: 'test:intruder',
      order: 1,
      text: (context) => {
        const session = context.agent?.session
        if (session !== undefined && session.surface.nodes.length === 0) {
          session.append('user/message', blockMessage('someone else'), { surfaceOp: 'append' })
        }
        return ''
      },
    })
    const failure = await h.agent.maintainSurfaceHead!().catch((error: unknown) => error)
    disposer()

    expect(failure).toBeInstanceOf(SurfaceHeadError)
    expect((failure as SurfaceHeadError).failure).toBe('history-conflict')
    expect(h.session.surface.nodes).toHaveLength(1)
    expect(systemNodes(h.session)).toEqual([])
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
    const failure = await h.agent.maintainSurfaceHead!().catch((error: unknown) => error)
    disposer()

    expect(failure).toBeInstanceOf(SurfaceHeadError)
    const error = failure as SurfaceHeadError
    expect(error.failure).toBe('aborted')
    expect(error.head).toBeUndefined()
    expect(h.session.surface.nodes).toEqual([])
  })

  it('refuses after this agent stopped being the live agent for its session', async () => {
    const h = await mount()
    await h.handle.dispose()

    const failure = await h.agent.maintainSurfaceHead!().catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(SurfaceHeadError)
    expect((failure as SurfaceHeadError).failure).toBe('agent-changed')
    expect(h.session.surface.nodes).toEqual([])
  })

  it('keeps an empty rendered head as the single head and lets the next turn stay head-free', async () => {
    const h = await mount([textResponse('answer')], undefined, {
      includeHarnessIdentity: false,
      includeRuntimeContext: false,
    })
    const emptyPrompt = await h.agent.maintainSurfaceHead!()
    expect(emptyPrompt).toMatchObject({ appended: true, checkpointed: true })
    expect(h.session.eventAt(emptyPrompt.headSeq)?.type).toBe('system/message')
    expect(h.session.surface.nodes).toEqual([emptyPrompt.headSeq])
    expect(h.session.deriveMessages()).toEqual([])

    const second = await h.agent.maintainSurfaceHead!()
    expect(second).toMatchObject({ appended: false, headSeq: emptyPrompt.headSeq })

    await sendAndSettle(h.ctx, h.agent, 'no prompt')
    expect(systemNodes(h.session)).toEqual([emptyPrompt.headSeq])
    expect(h.adapter.requests.at(-1)!.messages.map(message => message.role)).toEqual(['user'])
  })

  it('reports a cancellation raised during the no-op checkpoint with the verified head', async () => {
    const h = await mount([textResponse('done')])
    await sendAndSettle(h.ctx, h.agent, 'first')
    const head = systemNodes(h.session)[0]!
    let armed = true
    const dispose = h.ctx.on('session/flush', () => {
      if (!armed) return
      armed = false
      // The checkpoint awaits listeners and storage; a cancellation here lands
      // after the verification decision and must not settle as a success.
      h.agent.cancel({ kind: 'user' })
    })

    const failure = await h.agent.maintainSurfaceHead!().catch((error: unknown) => error)
    dispose()

    expect(failure).toBeInstanceOf(SurfaceHeadError)
    const error = failure as SurfaceHeadError
    expect(error.failure).toBe('aborted')
    expect(error.head).toEqual({ headSeq: head, appended: false })
    expect(systemNodes(h.session)).toEqual([head])
    expect(h.agent.status).toBe('idle')
  })

  it('reports a cancellation raised during the first checkpoint with the committed head', async () => {
    const h = await mount()
    let armed = true
    const dispose = h.ctx.on('session/flush', () => {
      if (!armed) return
      armed = false
      h.agent.cancel({ kind: 'user' })
    })

    const failure = await h.agent.maintainSurfaceHead!().catch((error: unknown) => error)
    dispose()

    expect(failure).toBeInstanceOf(SurfaceHeadError)
    const error = failure as SurfaceHeadError
    expect(error.failure).toBe('aborted')
    expect(error.head?.appended).toBe(true)
    expect(systemNodes(h.session)).toEqual([error.head!.headSeq])
    expect(h.session.snapshotEvents().filter(event => event.type === 'user/message')).toEqual([])
  })

  it('serializes concurrent maintenance so exactly one head is written', async () => {
    const h = await mount()

    const results = await Promise.allSettled([h.agent.maintainSurfaceHead!(), h.agent.maintainSurfaceHead!()])

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const [rejected] = results.filter(result => result.status === 'rejected')
    expect(rejected?.reason).toBeInstanceOf(SurfaceHeadError)
    expect((rejected?.reason as SurfaceHeadError).failure).toBe('not-idle')
    expect(systemNodes(h.session)).toHaveLength(1)
    expect(h.session.surface.nodes).toHaveLength(1)
    expect(h.session.snapshotEvents().filter(event => event.type === 'user/message')).toEqual([])
  })

  it('records the head at the settled generation so a cold reader sees the real prompt', async () => {
    const h = await mount()
    const result = await h.agent.maintainSurfaceHead!()
    const root = h.root
    const rows = (await readFile(await generationLog(root), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    const headRow = rows.find(row => row['type'] === 'system/message')
    const headData = headRow?.['data'] as { maintenance?: unknown; turn?: unknown; step?: unknown }
    expect(headData.maintenance).toBe(true)
    expect(headData.turn).toBeUndefined()
    expect(headData.step).toBeUndefined()
    expect(rows.filter(row => row['type'] === 'system/message')).toHaveLength(1)
    await h.handle.dispose()
    await h.ctx.fiber.dispose()
    const reader = await mountReader(root)
    const readHandle = await reader.sessionPersistence.open(SESSION_ID, 'read')
    try {
      const cold = await readHandle.read()
      expect(cold.events.filter(event => event.type === 'system/message').map(event => event.seq)).toEqual([result.headSeq])
      const [projected] = cold.events.flatMap(event => event.type === 'system/message' ? [event.data.message] : [])
      expect(messageText(projected as Message)).toContain(PERSONA)
    } finally {
      await readHandle.close()
    }
  })
})
