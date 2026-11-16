/**
 * Per-agent initialization is the maintenance task that creates or resumes an
 * agent. A created listener that establishes its plugin's protected surface head
 * therefore runs inside that task and joins it instead of being refused as
 * not-idle, and the first input after creation reaches exactly one real request
 * with no initialization performed outside the public lifecycle.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, IdleHistoryResult, SurfaceHeadResult } from '@deepseek-ai/dsh-agent'
import AgentRegistry, { IdleHistoryError, SurfaceHeadError } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const SESSION_ID = SessionId('initialization-maintenance')
const PERSONA = 'persona: initialization maintenance'

interface Services {
  readonly ctx: Context
  readonly adapter: MockAdapter
  readonly root: string
}

/** One latch with a release, used to hold a maintenance inside an await. */
interface Gate {
  readonly entered: Promise<void>
  readonly release: () => void
  readonly dispose: () => void
}

const roots: string[] = []
const contexts: Context[] = []

/** Mount the full loop plus the JSONL backend on one storage root. */
async function mountServices(
  script: ConstructorParameters<typeof MockAdapter>[0] = [],
  root?: string,
): Promise<Services> {
  const storage = root ?? await mkdtemp(join(tmpdir(), 'dsh-initialization-maintenance-'))
  if (root === undefined) roots.push(storage)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: PERSONA })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: storage, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, adapter, root: storage }
}

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** One ordinary user prompt. */
function message(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
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

/** The text a request message carries. */
function textOf(message: GenerateOptions['messages'][number] | undefined): string | undefined {
  return message?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

/** The committed protected-head sequences of one session's surface. */
function headNodes(session: Agent['session']): number[] {
  return session.surface.nodes.filter(seq => session.eventAt(seq)?.type === 'system/message')
}

/** The turn endings one session recorded, in order. */
function turnEndings(session: Agent['session']): string[] {
  return session.snapshotEvents().flatMap(event => event.type === 'turn/end' ? [event.data.reason.kind] : [])
}

/** Gate one prompt assembly so a test can act while a maintenance awaits it. */
function assemblyGate(ctx: Context): Gate {
  const entered = Promise.withResolvers<undefined>()
  const released = Promise.withResolvers<undefined>()
  let armed = true
  const dispose = ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    if (armed) {
      armed = false
      entered.resolve(undefined)
      await released.promise
    }
    return await next()
  })
  return { entered: entered.promise, release: () => { released.resolve(undefined) }, dispose }
}

/** Gate one durability checkpoint so a test can release the task while it runs. */
function flushGate(ctx: Context): Gate {
  const entered = Promise.withResolvers<undefined>()
  const released = Promise.withResolvers<undefined>()
  let armed = true
  const dispose = ctx.on('session/flush', async () => {
    if (!armed) return
    armed = false
    entered.resolve(undefined)
    await released.promise
  })
  return { entered: entered.promise, release: () => { released.resolve(undefined) }, dispose }
}

/**
 * Wait for one latch at most `timeoutMs`, reporting whether it was reached, so a
 * regression that never arms the latch fails the expectation instead of hanging
 * the test and its teardown.
 * @param latch - promise that resolves when the awaited step runs.
 * @param timeoutMs - bounded wait; the caller still releases its gates.
 * @returns whether the latch resolved in time.
 */
async function reached(latch: Promise<void>, timeoutMs = 2_000): Promise<boolean> {
  return await Promise.race([
    latch.then(() => true),
    new Promise<boolean>((resolve) => { setTimeout(() => { resolve(false) }, timeoutMs) }),
  ])
}

/**
 * Release every gate and settle the promises a gated test left suspended, so a
 * failing expectation cannot leave a creation listener awaiting an unresolved
 * gate and hang teardown.
 * @param gates - gates armed by the test, released and disposed in order.
 * @param pending - promises the gates suspended, settled after release.
 */
async function releaseAll(
  gates: readonly Gate[],
  pending: readonly (Promise<unknown> | undefined)[],
): Promise<void> {
  for (const gate of gates) {
    gate.release()
    gate.dispose()
  }
  for (const promise of pending) await promise?.then(() => undefined, () => undefined)
}

describe('agent initialization maintenance', () => {
  it('establishes the plugin head from an awaited created listener without starting work', async () => {
    const services = await mountServices([textResponse('answer')])
    const events = observe(services.ctx)
    let head: SurfaceHeadResult | undefined
    const listener = services.ctx.on('agent/created', async ({ agent }) => {
      head = await agent.maintainSurfaceHead!()
    })

    const handle = await services.ctx.agents.create({
      sessionId: SESSION_ID,
      agentOptions: { provider: 'mock', model: 'model' },
    })
    listener()

    expect(head).toMatchObject({ appended: true, checkpointed: true })
    const session = handle.agent.session
    expect(session.surface.nodes).toEqual([head!.headSeq])
    expect(headNodes(session)).toHaveLength(1)
    const headEvent = session.eventAt(head!.headSeq)
    if (headEvent?.type !== 'system/message') throw new Error('the committed head is not a system message')
    expect('maintenance' in headEvent.data && headEvent.data.maintenance).toBe(true)
    expect('turn' in headEvent.data).toBe(false)
    expect('step' in headEvent.data).toBe(false)
    // The initialization maintenance itself opened no request, turn, step, or claim.
    expect(services.adapter.requests).toEqual([])
    expect(events.count('turn/start')).toBe(0)
    expect(events.count('step/start')).toBe(0)
    expect(events.count('agent/inbox/claimed')).toBe(0)
    expect(handle.agent.status).toBe('idle')

    // The first input after creation reaches the model exactly once, behind the head.
    handle.agent.followup(message('first after creation'))
    await handle.agent.whenIdle()
    expect(turnEndings(session)).toEqual(['completed'])
    expect(events.count('turn/start')).toBe(1)
    expect(events.count('user/message')).toBe(1)
    expect(services.adapter.requests).toHaveLength(1)
    const request = services.adapter.requests[0]!
    expect(request.messages.map(entry => entry.role)).toEqual(['system', 'user'])
    expect(request.messages[1]?.content).toEqual([{ type: 'text', text: 'first after creation' }])
    expect(headNodes(session)).toHaveLength(1)
    await handle.dispose()
  })

  it('keeps a wake queued during the created listener and runs it once after publication', async () => {
    const services = await mountServices([textResponse('wake reply')])
    let head: SurfaceHeadResult | undefined
    let initializing: Agent | undefined
    const listener = services.ctx.on('agent/created', async ({ agent }) => {
      // The wake is delivered while initialization still owns the agent.
      agent.followup(message('queued during initialization'))
      head = await agent.maintainSurfaceHead!()
    })

    const handle = await services.ctx.agents.create({
      sessionId: SESSION_ID,
      agentOptions: { provider: 'mock', model: 'model' },
      setup: (_agentCtx, agent) => { initializing = agent },
    })
    listener()

    expect(head?.appended).toBe(true)
    expect(initializing).toBe(handle.agent)
    // Publication released the latched wake as its own turn, exactly once.
    await handle.agent.whenIdle()
    expect(services.adapter.requests).toHaveLength(1)
    const request = services.adapter.requests[0]!
    expect(request.messages.map(entry => entry.role)).toEqual(['system', 'user'])
    expect(textOf(request.messages[1])).toBe('queued during initialization')
    expect(handle.agent.inbox.nextTurn).toEqual([])
    expect(handle.agent.inbox.nextStep).toEqual([])
    expect(headNodes(handle.agent.session)).toHaveLength(1)
    await handle.dispose()
  })

  it('refuses a concurrent call made outside the initialization maintenance', async () => {
    const services = await mountServices()
    const gate = assemblyGate(services.ctx)
    let initializing!: Agent
    const listenerEntered = Promise.withResolvers<undefined>()
    let joinedCall: Promise<SurfaceHeadResult> | undefined
    const listener = services.ctx.on('agent/created', async ({ agent }) => {
      joinedCall = agent.maintainSurfaceHead!()
      // Handle a refusal here so a failing expectation cannot surface as an
      // unhandled rejection before the test awaits the same promise.
      void joinedCall.catch(() => undefined)
      listenerEntered.resolve(undefined)
      await joinedCall
    })

    const creation = services.ctx.agents.create({
      sessionId: SESSION_ID,
      agentOptions: { provider: 'mock', model: 'model' },
      setup: (_agentCtx, agent) => { initializing = agent },
    })
    let handle: AgentHandle | undefined
    try {
      // The created listener joined the initialization maintenance and its prompt
      // assembly is suspended; a caller in another async context must not join it.
      await listenerEntered.promise
      expect(await reached(gate.entered)).toBe(true)
      expect(services.ctx.agents.get(SESSION_ID)).toBe(initializing)
      const unrelated = await initializing.maintainSurfaceHead!().catch((error: unknown) => error)
      expect(unrelated).toBeInstanceOf(SurfaceHeadError)
      expect((unrelated as SurfaceHeadError).failure).toBe('not-idle')

      gate.release()
      handle = await creation
      listener()
      gate.dispose()
      expect((await joinedCall!)?.appended).toBe(true)
      expect(headNodes(handle.agent.session)).toHaveLength(1)
    } finally {
      await releaseAll([gate], [creation, joinedCall])
      await handle?.dispose()
      listener()
    }
  })

  it('cancels a joined head maintenance while its prompt is assembled', async () => {
    const services = await mountServices()
    const gate = assemblyGate(services.ctx)
    let initializing!: Agent
    const listener = services.ctx.on('agent/created', async ({ agent }) => {
      // Propagating the refusal fails creation and rolls the agent back.
      await agent.maintainSurfaceHead!()
    })

    const creation = services.ctx.agents.create({
      sessionId: SESSION_ID,
      agentOptions: { provider: 'mock', model: 'model' },
      setup: (_agentCtx, agent) => { initializing = agent },
    })
    try {
      expect(await reached(gate.entered)).toBe(true)
      initializing.cancel({ kind: 'user' })
      gate.release()
      const failure = await creation.then(() => undefined, (error: unknown) => error)
      listener()
      gate.dispose()

      expect(failure).toBeInstanceOf(SurfaceHeadError)
      expect((failure as SurfaceHeadError).failure).toBe('aborted')
      expect(services.ctx.agents.get(SESSION_ID)).toBeUndefined()
      expect(initializing.session.surface.nodes).toEqual([])
      expect(initializing.session.snapshotEvents().filter(event => event.type === 'system/message')).toEqual([])
      expect(services.adapter.requests).toEqual([])
    } finally {
      await releaseAll([gate], [creation])
      listener()
    }
  })

  it('writes nothing when a joined maintenance outlives the initialization task', async () => {
    const services = await mountServices()
    const gate = assemblyGate(services.ctx)
    let detached: Promise<unknown> | undefined
    const started = Promise.withResolvers<undefined>()
    const listener = services.ctx.on('agent/created', ({ agent }) => {
      // Deliberately unawaited: the joined call must not append after release.
      detached = agent.maintainSurfaceHead!().catch((error: unknown) => error)
      started.resolve(undefined)
      return undefined
    })

    const creation = services.ctx.agents.create({
      sessionId: SESSION_ID,
      agentOptions: { provider: 'mock', model: 'model' },
    })
    let handle: AgentHandle | undefined
    try {
      await started.promise
      expect(await reached(gate.entered)).toBe(true)
      // Creation published, so the initialization maintenance already released the
      // agent before the assembled prompt returns.
      handle = await creation
      listener()
      expect(services.ctx.agents.get(SESSION_ID)).toBe(handle.agent)
      gate.release()
      gate.dispose()
      const failure = await detached!
      expect(failure).toBeInstanceOf(SurfaceHeadError)
      expect((failure as SurfaceHeadError).failure).toBe('aborted')
      expect(handle.agent.session.surface.nodes).toEqual([])
      expect(services.adapter.requests).toEqual([])
    } finally {
      await releaseAll([gate], [creation, detached])
      await handle?.dispose()
    }
  })

  it('refuses a second primitive started from a callback of the claimed body', async () => {
    const services = await mountServices()
    const handle = await services.ctx.agents.create({
      sessionId: SESSION_ID,
      agentOptions: { provider: 'mock', model: 'model' },
    })
    // Give the surface a head so the outer call takes the no-op checkpoint path.
    const established = await handle.agent.maintainSurfaceHead!()
    const nested = Promise.withResolvers<unknown>()
    let armed = true
    const dispose = services.ctx.on('session/flush', async () => {
      if (!armed) return
      armed = false
      // This callback runs inside the claimed body's ownership context; the
      // claimed body still holds the phase, so a second primitive must refuse.
      nested.resolve(await handle.agent.maintainIdleHistory!({ message: message('nested note') })
        .catch((error: unknown) => error))
    })
    try {
      const outer = await handle.agent.maintainSurfaceHead!()
      expect(outer).toMatchObject({ appended: false, headSeq: established.headSeq })
      const failure = await nested.promise
      expect(failure).toBeInstanceOf(IdleHistoryError)
      expect((failure as IdleHistoryError).failure).toBe('not-idle')
      expect(handle.agent.session.snapshotEvents().filter(event => event.type === 'user/message')).toEqual([])
      expect(headNodes(handle.agent.session)).toHaveLength(1)
    } finally {
      dispose()
      await handle.dispose()
    }
  })

  it('keeps one writer per phase without an earlier abandoned body interfering', async () => {
    const services = await mountServices()
    const handle = await services.ctx.agents.create({
      sessionId: SESSION_ID,
      agentOptions: { provider: 'mock', model: 'model' },
    })
    const agent = handle.agent
    const firstGate = assemblyGate(services.ctx)
    const secondGate = flushGate(services.ctx)
    let abandoned: Promise<unknown> | undefined
    let firstJoin: Promise<SurfaceHeadResult> | undefined
    let outcome: {
      readonly firstJoin: SurfaceHeadResult
      readonly abandonedFailure: unknown
      readonly secondJoin: unknown
    } | undefined
    const proceed = Promise.withResolvers<undefined>()
    const phaseA = agent.runMaintenance(async () => {
      abandoned = agent.maintainSurfaceHead!().catch((error: unknown) => error)
      // Bounded: a regression that refuses the joined call before it assembles
      // never enters this gate, and this task must still settle so the test can
      // release both gates from its `finally`.
      expect(await reached(firstGate.entered)).toBe(true)
    })
    const startPhaseB = (): Promise<{
      readonly firstJoin: SurfaceHeadResult
      readonly abandonedFailure: unknown
      readonly secondJoin: unknown
    }> => agent.runMaintenance(async () => {
      firstJoin = agent.maintainSurfaceHead!()
      // Handle a refusal here so a failing expectation cannot surface as an
      // unhandled rejection before the test awaits the same promise.
      void firstJoin.catch(() => undefined)
      await proceed.promise
      firstGate.release()
      const abandonedFailure = await abandoned
      // Phase B's join still holds the slot: the abandoned body's settlement
      // must neither clear it nor let a second body enter this phase.
      const secondJoin = await agent.maintainSurfaceHead!().catch((error: unknown) => error)
      secondGate.release()
      return { firstJoin: await firstJoin, abandonedFailure, secondJoin }
    })
    let phaseB: ReturnType<typeof startPhaseB> | undefined
    try {
      // Bounded for the same reason: a failed expectation must reach `finally`.
      expect(await reached(phaseA.then(() => undefined))).toBe(true)
      // Phase A released while its joined body is still suspended in assembly.
      phaseB = startPhaseB()
      expect(await reached(secondGate.entered)).toBe(true)
      proceed.resolve(undefined)
      expect(await reached(phaseB.then(() => undefined))).toBe(true)
      outcome = await phaseB
      expect(outcome?.firstJoin.appended).toBe(true)
      expect(outcome?.abandonedFailure).toBeInstanceOf(SurfaceHeadError)
      expect((outcome?.abandonedFailure as SurfaceHeadError).failure).toBe('aborted')
      expect(outcome?.secondJoin).toBeInstanceOf(SurfaceHeadError)
      expect((outcome?.secondJoin as SurfaceHeadError).failure).toBe('not-idle')
      expect(headNodes(agent.session)).toHaveLength(1)
    } finally {
      proceed.resolve(undefined)
      await releaseAll([firstGate, secondGate], [abandoned, firstJoin, phaseA, phaseB])
      await handle.dispose()
    }
  })

  it('settles a joined idle history through its checkpoint after the task released', async () => {
    const services = await mountServices()
    const handle = await services.ctx.agents.create({
      sessionId: SESSION_ID,
      agentOptions: { provider: 'mock', model: 'model' },
    })
    const gate = flushGate(services.ctx)
    let recorded: Promise<IdleHistoryResult> | undefined
    const proceed = Promise.withResolvers<undefined>()
    const phase = handle.agent.runMaintenance(async () => {
      recorded = handle.agent.maintainIdleHistory!({ message: message('committed before release') })
      // The test releases the task once the body is inside its checkpoint.
      await proceed.promise
    })
    let result: IdleHistoryResult | undefined
    try {
      expect(await reached(gate.entered)).toBe(true)
      proceed.resolve(undefined)
      await phase
      gate.release()
      result = await recorded!
      // The message append happened while the phase still owned the agent; the
      // remaining checkpoint settles the call, so the committed history is
      // reported instead of a late cancellation.
      expect(result).toMatchObject({ appended: true, checkpointed: true })
      expect(handle.agent.session.surface.nodes).toEqual([result.systemHeadSeq, result.messageSeq])
      expect(handle.agent.session.snapshotEvents().filter(event => event.type === 'user/message')).toHaveLength(1)
      expect(services.adapter.requests).toEqual([])
    } finally {
      proceed.resolve(undefined)
      await releaseAll([gate], [recorded, phase])
      await handle.dispose()
    }
  })

  it('refuses a joined idle history that has not committed when its task released', async () => {
    const services = await mountServices()
    const handle = await services.ctx.agents.create({
      sessionId: SESSION_ID,
      agentOptions: { provider: 'mock', model: 'model' },
    })
    const gate = assemblyGate(services.ctx)
    let abandoned: Promise<unknown> | undefined
    const proceed = Promise.withResolvers<undefined>()
    const phase = handle.agent.runMaintenance(async () => {
      abandoned = handle.agent.maintainIdleHistory!({ message: message('must not be written') })
        .catch((error: unknown) => error)
      await proceed.promise
    })
    try {
      expect(await reached(gate.entered)).toBe(true)
      proceed.resolve(undefined)
      await phase
      gate.release()
      gate.dispose()
      const failure = await abandoned
      expect(failure).toBeInstanceOf(IdleHistoryError)
      expect((failure as IdleHistoryError).failure).toBe('aborted')
      expect((failure as IdleHistoryError).append).toBeUndefined()
      expect(handle.agent.session.snapshotEvents()
        .filter(event => event.type === 'user/message' || event.type === 'system/message')).toEqual([])
    } finally {
      proceed.resolve(undefined)
      await releaseAll([gate], [abandoned, phase])
      await handle.dispose()
    }
  })

  it('resumes a stored session and runs an immediately following input exactly once', async () => {
    const first = await mountServices()
    const created = await first.ctx.agents.create({
      sessionId: SESSION_ID,
      agentOptions: { provider: 'mock', model: 'model' },
    })
    // A turn cancelled before any step stores a session whose surface has no head.
    created.agent.followup(message('cancelled before the first step'))
    created.agent.cancel({ kind: 'user' })
    await created.agent.whenIdle()
    expect(created.agent.session.surface.nodes).toEqual([])
    await created.dispose()
    await first.ctx.fiber.dispose()

    // Cold resume: the created listener establishes the head before resume resolves.
    const services = await mountServices([textResponse('resumed reply')], first.root)
    let head: SurfaceHeadResult | undefined
    const listener = services.ctx.on('agent/created', async ({ agent }) => {
      head = await agent.maintainSurfaceHead!()
    })
    const resumed = await services.ctx.agents.resume({
      resumeSessionId: SESSION_ID,
      agentOptions: { provider: 'mock', model: 'model' },
    })
    listener()
    expect(services.ctx.agents.get(SESSION_ID)).toBe(resumed.agent)
    expect(head).toMatchObject({ appended: true, checkpointed: true })

    // No sleep, idle polling, or second initialization before the first input.
    resumed.agent.followup(message('first input after resume'))
    await resumed.agent.whenIdle()
    // The stored cancelled turn keeps its own ending; the resumed input completed.
    expect(turnEndings(resumed.agent.session)).toEqual(['aborted', 'completed'])
    expect(services.adapter.requests).toHaveLength(1)
    const request = services.adapter.requests[0]!
    expect(request.messages.map(entry => entry.role)).toEqual(['system', 'user'])
    expect(textOf(request.messages[0])).toContain(PERSONA)
    expect(textOf(request.messages[1])).toBe('first input after resume')
    expect(headNodes(resumed.agent.session)).toHaveLength(1)
    await resumed.dispose()
  })

  it('verifies the existing head on resume instead of appending a second one', async () => {
    const first = await mountServices([textResponse('answer')])
    const written = await first.ctx.agents.create({
      sessionId: SESSION_ID,
      agentOptions: { provider: 'mock', model: 'model' },
    })
    const established = await written.agent.maintainSurfaceHead!()
    await written.dispose()
    await first.ctx.fiber.dispose()

    const services = await mountServices([textResponse('resumed reply')], first.root)
    let head: SurfaceHeadResult | undefined
    const listener = services.ctx.on('agent/created', async ({ agent }) => {
      head = await agent.maintainSurfaceHead!()
    })
    const resumed = await services.ctx.agents.resume({
      resumeSessionId: SESSION_ID,
      agentOptions: { provider: 'mock', model: 'model' },
    })
    listener()
    expect(head).toMatchObject({ appended: false, headSeq: established.headSeq, checkpointed: true })
    expect(headNodes(resumed.agent.session)).toEqual([established.headSeq])
    expect(resumed.agent.session.snapshotEvents().filter(event => event.type === 'system/message')).toHaveLength(1)

    resumed.agent.followup(message('after resuming a headed session'))
    await resumed.agent.whenIdle()
    expect(services.adapter.requests).toHaveLength(1)
    expect(headNodes(resumed.agent.session)).toEqual([established.headSeq])
    await resumed.dispose()
  })

  it('records idle history from the created listener through the same joining claim', async () => {
    const services = await mountServices([textResponse('answer')])
    let head: SurfaceHeadResult | undefined
    let recorded: IdleHistoryResult | undefined
    const listener = services.ctx.on('agent/created', async ({ agent }) => {
      head = await agent.maintainSurfaceHead!()
      recorded = await agent.maintainIdleHistory!({ message: message('initialization note') })
    })

    const handle = await services.ctx.agents.create({
      sessionId: SESSION_ID,
      agentOptions: { provider: 'mock', model: 'model' },
    })
    listener()
    expect(recorded?.appended).toBe(true)
    expect(recorded?.systemHeadSeq).toBeNull()
    expect(recorded?.checkpointed).toBe(true)
    expect(head?.appended).toBe(true)
    expect(handle.agent.session.surface.nodes).toEqual([head!.headSeq, recorded!.messageSeq])
    expect(headNodes(handle.agent.session)).toHaveLength(1)

    handle.agent.followup(message('after the note'))
    await handle.agent.whenIdle()
    expect(services.adapter.requests).toHaveLength(1)
    expect(textOf(services.adapter.requests[0]?.messages[1])).toBe('initialization note')
    expect(textOf(services.adapter.requests[0]?.messages[2])).toBe('after the note')
    await handle.dispose()
  })

  it('leaves an ordinary session without a created listener unchanged', async () => {
    const services = await mountServices([textResponse('answer')])
    const events = observe(services.ctx)
    const handle = await services.ctx.agents.create({
      sessionId: SESSION_ID,
      agentOptions: { provider: 'mock', model: 'model' },
    })
    // Creation itself still writes no surface node: the first turn commits it.
    expect(handle.agent.session.surface.nodes).toEqual([])
    expect(handle.agent.session.snapshotEvents().filter(event => event.type === 'system/message')).toEqual([])

    handle.agent.followup(message('ordinary first input'))
    await handle.agent.whenIdle()
    expect(events.count('turn/start')).toBe(1)
    expect(services.adapter.requests).toHaveLength(1)
    const headEvent = handle.agent.session.snapshotEvents().find(event => event.type === 'system/message')
    if (headEvent?.type !== 'system/message') throw new Error('the first turn committed no system message')
    expect('maintenance' in headEvent.data).toBe(false)
    await handle.dispose()
  })
})
