/**
 * Real AgentLoop and JSONL evidence for the durable cancellation record.
 *
 * A cancellation that clears the queue records `cause` and `entrySeq` on each
 * `agent/inbox/spliced` it commits; an empty-queue cancellation leaves one
 * intent splice. `keepInbox` and ordinary edits stay unchanged. Each case
 * drains the writer and reads the same events back from a cold open.
 * @module dsh-agent-loop/tests/cancel-persistence
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { appendPluginRecord, SessionId, type SessionEvent, type SessionLogOffset, type UserMessage } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { MockAdapter, textResponse } from './mock-adapter.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** Test-only probe publication: one ignorable record outside any turn. */
    'plugin:test/probe': { readonly value: number }
  }
}

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })

/** One recorded cancellation splice with the facts this module verifies. */
interface RecordedCancellation {
  seq: number
  cause: 'user' | 'disposed' | undefined
  entrySeq: SessionLogOffset | undefined
  removedCount: number | undefined
}

/**
 * List durable cancellation splices in log order.
 * @param events - logged events.
 * @returns each cancellation record's own seq and carried facts.
 */
function cancellations(events: readonly SessionEvent[]): RecordedCancellation[] {
  return events.flatMap(event => event.type === 'agent/inbox/spliced' && event.data.outcome === 'canceled'
    ? [{ seq: event.seq, cause: event.data.cause, entrySeq: event.data.entrySeq, removedCount: event.data.removedCount }]
    : [])
}

/**
 * List only the empty-queue cancellation intents in log order.
 * @param events - logged events.
 * @returns each intent's own seq and recorded entry cut.
 */
function intents(events: readonly SessionEvent[]): { seq: number; entrySeq: SessionLogOffset | undefined }[] {
  return events.flatMap(event => event.type === 'agent/inbox/spliced'
    && event.data.cause === 'user' && event.data.removedCount === undefined
    ? [{ seq: event.seq, entrySeq: event.data.entrySeq }]
    : [])
}

function message(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

async function persistentHarness(root: string, adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  // The backend mounts before the loop so root teardown unwinds the loop first.
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

/**
 * Read one session's durable log through an independent context.
 * @param root - JSONL persistence root.
 * @param id - session to read.
 * @returns the stored events.
 */
async function readStored(root: string, id: SessionId): Promise<readonly SessionEvent[]> {
  const verify = new Context()
  try {
    await verify.plugin(JsonlSessionPersistence, { root })
    const reader = await verify.sessionPersistence.open(id, 'read')
    try {
      return (await reader.read()).events
    } finally {
      await reader.close()
    }
  } finally {
    await verify.fiber.dispose()
  }
}

it('commits a deferred intent after its trigger and before the aborted turn/end and detach', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cancel-persist-'))
  dirs.push(root)
  const ctx = await persistentHarness(root, new MockAdapter([textResponse('unused')]))
  const handle = await ctx.agents.create({
    sessionId: SessionId('deferred-intent-persisted'),
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  const agent = handle.agent
  try {
    // The step/start publication is open and the claimed queue is already
    // empty, so this cancellation defers its intent to that publication's
    // drain: after the trigger, before the aborted turn/end, before detach.
    let canceled = false
    let attachedDuringIntent: boolean | undefined
    let intentSeq: number | undefined
    const dispose = ctx.on('session/event', (session, event) => {
      if (session !== agent.session) return
      if (event.type === 'step/start' && !canceled) {
        canceled = true
        agent.cancel({ kind: 'user' })
        return
      }
      if (event.type === 'agent/inbox/spliced' && event.data.entrySeq !== undefined) {
        intentSeq = event.seq
        attachedDuringIntent = ctx.sessions.get(agent.id) === agent.session
      }
    })
    agent.followup(message('go'))
    await agent.whenIdle()
    dispose()

    const events = agent.session.snapshotEvents()
    const stepStart = events.find(event => event.type === 'step/start')
    const abortedEnd = events.find(event => event.type === 'turn/end' && event.data.reason.kind === 'aborted')
    if (stepStart === undefined) throw new Error('the step did not start')
    if (abortedEnd === undefined) throw new Error('the cancelled turn did not end aborted')
    const intent = events.find(event => event.type === 'agent/inbox/spliced'
      && event.data.cause === 'user' && event.data.removedCount === undefined)
    if (intent === undefined || intent.type !== 'agent/inbox/spliced') throw new Error('cancellation intent was not appended')
    expect(intent.seq).toBe(stepStart.seq + 1)
    expect(intent.seq).toBe(intentSeq)
    expect(intent.seq).toBeLessThan(abortedEnd.seq)
    expect(attachedDuringIntent).toBe(true)
    expect(intent.data.entrySeq).toBe(stepStart.seq + 1)
    // Teardown drains the writer; the durable log must match the live log.
    await handle.dispose()
    const stored = await readStored(root, agent.id)
    expect(stored).toEqual(events)
    expect(stored.find(event => event.type === 'agent/inbox/spliced'
      && event.data.cause === 'user' && event.data.removedCount === undefined))
      .toMatchObject({ data: { target: 'next-step', outcome: 'canceled', cause: 'user', entrySeq: stepStart.seq + 1 } })
  } finally {
    await ctx.fiber.dispose()
  }
})

it('records cause user for user, parent, and hook clear; disposed for teardown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cancel-persist-'))
  dirs.push(root)
  const ctx = await persistentHarness(root, new MockAdapter([textResponse('unused')]))
  try {
    // A non-disposal clear writes `user` whatever triggered it: the durable
    // cause names the lifecycle intent, not a verified human click.
    for (const cause of [
      { kind: 'user' as const },
      { kind: 'parent' as const },
      { kind: 'hook' as const, reason: 'policy stopped the turn' },
    ]) {
      const handle = await ctx.agents.create({
        sessionId: SessionId(`clear-${cause.kind}`),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      handle.agent.inject(message(`pending ${cause.kind}`))
      const entrySeq = handle.agent.session.seq
      handle.agent.cancel(cause)
      expect(intents(handle.agent.session.snapshotEvents())).toEqual([])
      expect(cancellations(handle.agent.session.snapshotEvents())).toEqual([
        { seq: entrySeq, cause: 'user', entrySeq, removedCount: 1 },
      ])
      expect(handle.agent.inbox.nextStep).toEqual([])
      expect(handle.agent.inbox.nextTurn).toEqual([])
      await handle.dispose()
      expect(await readStored(root, handle.agent.id)).toEqual(handle.agent.session.snapshotEvents())
    }

    // Teardown releases the published queue with the disposal intent.
    const disposed = await ctx.agents.create({
      sessionId: SessionId('clear-disposed'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    disposed.agent.inject(message('pending disposed'))
    const disposedCut = disposed.agent.session.seq
    await disposed.dispose()
    expect(cancellations(disposed.agent.session.snapshotEvents())).toEqual([
      { seq: disposedCut, cause: 'disposed', entrySeq: disposedCut, removedCount: 1 },
    ])
    expect(await readStored(root, disposed.agent.id)).toEqual(disposed.agent.session.snapshotEvents())
  } finally {
    await ctx.fiber.dispose()
  }
})

it('leaves keepInbox and ordinary edits with the released splice fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cancel-persist-'))
  dirs.push(root)
  const ctx = await persistentHarness(root, new MockAdapter([textResponse('unused')]))
  const handle = await ctx.agents.create({
    sessionId: SessionId('keep-inbox-and-edits'),
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  const agent = handle.agent
  try {
    const edited = message('edited input')
    agent.inject(edited)
    expect(agent.inbox.remove(edited.id)).toBe(true)
    const kept = message('kept input')
    agent.inject(kept)
    const beforeKeep = agent.session.snapshotEvents().length
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    expect(agent.inbox.nextStep.map(entry => entry.id)).toEqual([kept.id])

    const after = agent.session.snapshotEvents().slice(beforeKeep)
    // keepInbox records nothing, and the ordinary removal keeps its released
    // shape: an explicit deletion that carries no lifecycle cause or entry cut.
    expect(after).toEqual([])
    const ordinary = agent.session.snapshotEvents().filter(event =>
      event.type === 'agent/inbox/spliced' && event.data.removedCount === 1)
    expect(ordinary).toHaveLength(1)
    expect(ordinary[0]?.type === 'agent/inbox/spliced' && ordinary[0].data).toEqual({
      target: 'next-step', start: 0, removedCount: 1, inserted: [], outcome: 'canceled',
    })
    await handle.dispose()
    expect(await readStored(root, agent.id)).toEqual(agent.session.snapshotEvents())
  } finally {
    await ctx.fiber.dispose()
  }
})

it('keeps input added after the entry cut pending and outside the cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cancel-persist-'))
  dirs.push(root)
  const adapter = new MockAdapter(['hang', textResponse('later')])
  const ctx = await persistentHarness(root, adapter)
  const handle = await ctx.agents.create({
    sessionId: SessionId('later-than-cut'),
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  const agent = handle.agent
  try {
    agent.followup(message('start'))
    await expect.poll(() => adapter.requests.length).toBe(1)
    const captured = message('captured input')
    agent.inject(captured)
    const later = message('later input')
    const signal = adapter.requests[0]?.signal
    if (signal === undefined) throw new Error('model request omitted its turn signal')
    signal.addEventListener('abort', () => { agent.inject(later) }, { once: true })
    const entrySeq = agent.session.seq
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()

    const events = agent.session.snapshotEvents()
    const insertions = events.flatMap(event => event.type === 'agent/inbox/spliced'
      ? event.data.inserted.map(inserted => ({ id: inserted.id, seq: event.seq }))
      : [])
    const laterInsertion = insertions.find(insertion => insertion.id === later.id)
    if (laterInsertion === undefined) throw new Error('the later insertion is missing')
    // The later input lands at or after the recorded cut, so the cancellation
    // does not target it even though the cancellation's own splice comes later.
    expect(laterInsertion.seq).toBeGreaterThanOrEqual(entrySeq)
    expect(cancellations(events)).toEqual([
      { seq: entrySeq + 1, cause: 'user', entrySeq, removedCount: 1 },
    ])
    expect(agent.inbox.nextStep.map(entry => entry.id)).toEqual([later.id])
    const committed = agent.session.snapshotEvents()
    await handle.dispose()
    // Teardown clears the parked input with its own disposed record; the
    // cancellation slice captured before it is unchanged on disk.
    const stored = await readStored(root, agent.id)
    expect(stored.slice(0, committed.length)).toEqual(committed)
  } finally {
    await ctx.fiber.dispose()
  }
})

it('records one intent when a cancellation is raised from its own publication observers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cancel-persist-'))
  dirs.push(root)
  const ctx = await persistentHarness(root, new MockAdapter([textResponse('unused')]))
  const handle = await ctx.agents.create({
    sessionId: SessionId('reentrant-intent-bounded'),
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  const agent = handle.agent
  try {
    let reentered = false
    // The first intent's own publication observers run while the inbox guard
    // still covers the deferred write, so this cancellation must not queue a
    // second record.
    const disposeIntent = ctx.on('session/event', (session, event) => {
      if (session !== agent.session || event.type !== 'agent/inbox/spliced') return
      if (!Object.hasOwn(event.data, 'entrySeq') || reentered) return
      reentered = true
      agent.cancel({ kind: 'user' })
    })
    let deferredCanceled = false
    const disposeProbe = ctx.on('session/event', (session, event) => {
      if (session !== agent.session || (event.type as string) !== 'plugin:test/probe' || deferredCanceled) return
      deferredCanceled = true
      agent.cancel({ kind: 'user' })
    })
    appendPluginRecord(agent.session, 'plugin:test/probe', { value: 1 })
    disposeProbe()
    disposeIntent()
    expect(deferredCanceled).toBe(true)
    expect(reentered).toBe(true)
    expect(intents(agent.session.snapshotEvents())).toHaveLength(1)

    // The drain has returned, so the guard is released and this independent
    // cancellation records its own cut.
    const cut = agent.session.seq
    agent.cancel({ kind: 'user' })
    const events = agent.session.snapshotEvents()
    expect(intents(events)).toEqual([{ seq: 1, entrySeq: 1 }, { seq: cut, entrySeq: cut }])
    await handle.dispose()
    expect(await readStored(root, agent.id)).toEqual(events)
  } finally {
    await ctx.fiber.dispose()
  }
})

it('records a later cancellation after one intent write fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cancel-persist-'))
  dirs.push(root)
  const ctx = await persistentHarness(root, new MockAdapter([textResponse('unused')]))
  const handle = await ctx.agents.create({
    sessionId: SessionId('failed-intent-then-cancel'),
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  const agent = handle.agent
  try {
    const append = agent.session.append.bind(agent.session)
    let failed = false
    const failure = vi.spyOn(agent.session, 'append').mockImplementation(((type: string, ...rest: never[]) => {
      if (!failed && type === 'agent/inbox/spliced') {
        failed = true
        throw new Error('forced intent write failure')
      }
      return (append as (...args: never[]) => unknown)(type as never, ...rest)
    }) as never)
    try {
      expect(() => { agent.cancel({ kind: 'user' }) }).toThrow('forced intent write failure')
    } finally {
      failure.mockRestore()
    }
    expect(intents(agent.session.snapshotEvents())).toEqual([])

    const cut = agent.session.seq
    agent.cancel({ kind: 'user' })

    const events = agent.session.snapshotEvents()
    expect(intents(events)).toEqual([{ seq: cut, entrySeq: cut }])
    await handle.dispose()
    expect(await readStored(root, agent.id)).toEqual(events)
  } finally {
    await ctx.fiber.dispose()
  }
})

it('records both intents when a deferred and a later same-stack cancellation use different entry cuts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cancel-persist-'))
  dirs.push(root)
  const ctx = await persistentHarness(root, new MockAdapter([textResponse('unused')]))
  const handle = await ctx.agents.create({
    sessionId: SessionId('two-entry-cuts'),
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  const agent = handle.agent
  try {
    const cuts: SessionLogOffset[] = []
    let deferredCanceled = false
    const dispose = ctx.on('session/event', (session, event) => {
      // The plugin record is outside SessionEventMap: its phase and payload are
      // plugin-owned, so the probe matches by name.
      if (session !== agent.session || (event.type as string) !== 'plugin:test/probe' || deferredCanceled) return
      // The publication is still open and the queue is empty, so this intent
      // is deferred to that publication's drain.
      deferredCanceled = true
      cuts.push(agent.session.seq)
      agent.cancel({ kind: 'user' })
    })
    appendPluginRecord(agent.session, 'plugin:test/probe', { value: 1 })
    dispose()
    expect(deferredCanceled).toBe(true)

    // The probe publication has fully returned. This cancellation runs in the
    // same synchronous stack and must own its own entry cut.
    cuts.push(agent.session.seq)
    agent.cancel({ kind: 'user' })

    const events = agent.session.snapshotEvents()
    expect(intents(events)).toEqual(cuts.map(cut => ({ seq: cut, entrySeq: cut })))
    // Teardown drains the writer; both records are durable and distinct.
    await handle.dispose()
    expect(await readStored(root, agent.id)).toEqual(events)
  } finally {
    await ctx.fiber.dispose()
  }
})
