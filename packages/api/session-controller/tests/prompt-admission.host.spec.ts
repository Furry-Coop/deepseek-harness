import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import { createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  applyPromptAdmission,
  PromptAdmissionReader,
  promptAdmissionProjectionDefinition,
  type PromptAdmissionState,
} from '../src/prompt-admission.ts'
import type { SessionRequestId } from '../src/types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Test-only human occurrence that may carry a prompt correlation. */
    'admission-test-human': { kind: 'user'; rpcId?: string }
    /** Test-only host rewrite that may carry the original correlation. */
    'admission-test-rewrite': { kind: 'rewrite'; rpcId?: string }
  }
}

const SESSION = SessionId('prompt-admission-session')
const HEADER = { id: SESSION, version: SESSION_FORMAT_VERSION, createdAt: 0, isSeeded: false } as const

function human(rpcId?: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: 'original' }],
    source: rpcId === undefined ? { kind: 'user' } : { kind: 'user', rpcId },
  })
}

function rewriteOf(origin: UserMessage, rpcId?: string): UserMessage {
  return freezeMessage({
    ...origin,
    content: [{ type: 'text', text: 'rewritten' }],
    source: rpcId === undefined ? { kind: 'rewrite' } : { kind: 'rewrite', rpcId },
  })
}

function spliceEvent(seq: number, data: Extract<SessionEvent, { type: 'agent/inbox/spliced' }>['data']): SessionEvent {
  return { type: 'agent/inbox/spliced', seq: SessionSeq(seq), time: 0, data }
}

function userEvent(seq: number, message: UserMessage): SessionEvent {
  return { type: 'user/message', seq: SessionSeq(seq), time: 0, data: message, surfaceOp: 'append' }
}

function turnStart(seq: number, turn = 1): SessionEvent {
  return { type: 'turn/start', seq: SessionSeq(seq), time: 0, data: { turn } }
}

function stepStart(seq: number, turn = 1): SessionEvent {
  return { type: 'step/start', seq: SessionSeq(seq), time: 0, data: { turn, step: 1 } }
}

function stepEnd(seq: number, turn = 1): SessionEvent {
  return { type: 'step/end', seq: SessionSeq(seq), time: 0, data: { turn, step: 1 } }
}

function turnEnd(seq: number, turn = 1): SessionEvent {
  return { type: 'turn/end', seq: SessionSeq(seq), time: 0, data: { turn, reason: { kind: 'completed' } } }
}

function endSeed(seq: number): SessionEvent {
  return { type: 'session/end-seed', seq: SessionSeq(seq), time: 0, data: {} }
}

function fold(events: readonly SessionEvent[]): PromptAdmissionState {
  return events.reduce(applyPromptAdmission, promptAdmissionProjectionDefinition.init(HEADER, SessionLogOffset(0)))
}

function requestIds(state: PromptAdmissionState): string[] {
  return [...state.admitted]
}

function claimSequence(origin: UserMessage, admitted: UserMessage): SessionEvent[] {
  return [
    spliceEvent(0, { target: 'next-turn', start: 0, inserted: [origin] }),
    turnStart(1),
    spliceEvent(2, { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
    stepStart(3),
    userEvent(4, admitted),
  ]
}

describe('prompt admission projection', () => {
  it('records an admitted human prompt and ignores unrelated request ids', () => {
    const state = fold([userEvent(0, human('req-1'))])
    expect(requestIds(state)).toEqual(['req-1'])
    expect(state.pending).toEqual([])
    expect(state.claimed).toEqual([])
  })

  it('records a same-request human admission over a claimed occurrence once', () => {
    const origin = human('req-1')
    const state = fold([
      ...claimSequence(origin, origin),
      userEvent(5, origin),
    ])
    expect(requestIds(state)).toEqual(['req-1'])
  })

  it('records a claimed same-id rewrite with the same correlation', () => {
    const origin = human('req-1')
    const state = fold(claimSequence(origin, rewriteOf(origin, 'req-1')))
    expect(requestIds(state)).toEqual(['req-1'])
    expect(state.claimed).toEqual([])
  })

  it('refuses a same-id rewrite with another or missing correlation', () => {
    const origin = human('req-1')
    for (const admitted of [rewriteOf(origin, 'req-2'), rewriteOf(origin)]) {
      const state = fold(claimSequence(origin, admitted))
      expect(requestIds(state)).toEqual([])
      expect(state.claimed).toHaveLength(1)
      expect(fold([...claimSequence(origin, admitted), stepEnd(5)]).claimed).toEqual([])
    }
  })

  it('does not admit a claim whose step closed before the copy', () => {
    const origin = human('req-1')
    const state = fold([
      spliceEvent(0, { target: 'next-turn', start: 0, inserted: [origin] }),
      turnStart(1),
      spliceEvent(2, { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
      stepStart(3),
      stepEnd(4),
      userEvent(5, rewriteOf(origin, 'req-1')),
    ])
    expect(requestIds(state)).toEqual([])
  })

  it('closes every claim at turn end and keeps claims across an unrelated step start', () => {
    const origin = human('req-1')
    const claimed = fold([
      spliceEvent(0, { target: 'next-turn', start: 0, inserted: [origin] }),
      turnStart(1),
      spliceEvent(2, { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
      stepStart(3, 2),
      stepStart(4),
    ])
    expect(claimed.claimed[0]?.window.stepStartSeq).toBe(SessionSeq(4))
    expect(fold([
      spliceEvent(0, { target: 'next-turn', start: 0, inserted: [origin] }),
      turnStart(1),
      spliceEvent(2, { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
      turnEnd(3),
    ]).claimed).toEqual([])
  })

  it('claims the original across both Inbox lanes of one batch', () => {
    const origin = human('req-1')
    const state = fold([
      spliceEvent(0, { target: 'next-turn', start: 0, inserted: [origin] }),
      turnStart(1),
      spliceEvent(2, { target: 'next-step', start: 0, inserted: [human('other')] }),
      spliceEvent(3, { target: 'next-step', start: 0, removedCount: 1, inserted: [] }),
      spliceEvent(4, { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
      stepStart(5),
      userEvent(6, rewriteOf(origin, 'req-1')),
    ])
    expect(requestIds(state)).toEqual(['req-1'])
  })

  it('drops a canceled pending occurrence and a claim consumed by reinsertion', () => {
    const origin = human('req-1')
    const canceled = fold([
      spliceEvent(0, { target: 'next-turn', start: 0, inserted: [origin] }),
      turnStart(1),
      spliceEvent(2, { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' }),
      stepStart(3),
      userEvent(4, rewriteOf(origin, 'req-1')),
    ])
    expect(requestIds(canceled)).toEqual([])
    const reinserted = fold([
      spliceEvent(0, { target: 'next-turn', start: 0, inserted: [origin] }),
      turnStart(1),
      spliceEvent(2, { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
      stepStart(3),
      spliceEvent(4, { target: 'next-step', start: 0, inserted: [origin] }),
      userEvent(5, rewriteOf(origin, 'req-1')),
    ])
    expect(requestIds(reinserted)).toEqual([])
  })

  it('claims input outside a Turn without authorizing a later copy', () => {
    const origin = human('req-1')
    const state = fold([
      spliceEvent(0, { target: 'next-turn', start: 0, inserted: [origin] }),
      spliceEvent(1, { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
      stepStart(2),
      userEvent(3, rewriteOf(origin, 'req-1')),
    ])
    expect(requestIds(state)).toEqual([])
    expect(state.claimed).toEqual([])
  })

  it('keeps lane positions across insertions and replacements', () => {
    const first = human('req-1')
    const second = human('req-2')
    const state = fold([
      spliceEvent(0, { target: 'next-turn', start: 0, inserted: [first] }),
      spliceEvent(1, { target: 'next-turn', start: 1, inserted: [second] }),
      spliceEvent(2, { target: 'next-turn', start: 0, removedCount: 1, inserted: [human('req-3')] }),
      turnStart(3),
      spliceEvent(4, { target: 'next-turn', start: 0, removedCount: 2, inserted: [] }),
      stepStart(5),
      userEvent(6, rewriteOf(second, 'req-2')),
    ])
    expect(requestIds(state)).toEqual(['req-2'])
  })

  it('ignores inserted occurrences without a request id and non-human insertions', () => {
    const state = fold([
      spliceEvent(0, {
        target: 'next-turn', start: 0, inserted: [human(), rewriteOf(human('req-9'), 'req-9')],
      }),
    ])
    expect(state.pending).toEqual([])
  })

  it('returns the same state for unrelated events and tracked no-ops', () => {
    const empty = promptAdmissionProjectionDefinition.init(HEADER, SessionLogOffset(0))
    expect(applyPromptAdmission(empty, userEvent(0, human('req-1')))).not.toBe(empty)
    const stable = fold([spliceEvent(0, { target: 'next-turn', start: 0, inserted: [human('req-1')] })])
    expect(applyPromptAdmission(stable, endSeed(1))).toBe(stable)
    expect(applyPromptAdmission(stable, spliceEvent(2, {
      target: 'next-step', start: 0, removedCount: 1, inserted: [],
    }))).toBe(stable)
    expect(applyPromptAdmission(stable, stepStart(3))).toBe(stable)
    expect(applyPromptAdmission(stable, stepEnd(4))).toBe(stable)
    expect(applyPromptAdmission(stable, turnEnd(5))).toBe(stable)
    const open = applyPromptAdmission(stable, turnStart(6))
    expect(applyPromptAdmission(open, turnStart(7, 2))).not.toBe(open)
    expect(applyPromptAdmission(open, turnStart(6))).toBe(open)
  })

  it('rejects invalid persisted splice bounds', () => {
    expect(() => applyPromptAdmission(promptAdmissionProjectionDefinition.init(HEADER, SessionLogOffset(0)), spliceEvent(0, {
      target: 'next-turn', start: 1.5, inserted: [],
    }))).toThrow(/invalid persisted inbox splice/)
    expect(() => applyPromptAdmission(promptAdmissionProjectionDefinition.init(HEADER, SessionLogOffset(0)), spliceEvent(0, {
      target: 'next-turn', start: 0, removedCount: -1, inserted: [],
    }))).toThrow(/invalid persisted inbox splice/)
  })

  it('declares a private host unit', () => {
    expect(promptAdmissionProjectionDefinition.key).toBe('promptAdmission')
    expect(promptAdmissionProjectionDefinition.stateVersion).toBe(1)
    expect('wire' in promptAdmissionProjectionDefinition).toBe(false)
  })
})

describe('prompt admission reader', () => {
  async function harness(): Promise<Context> {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    return ctx
  }

  it('folds an existing log when registration completes after the events', async () => {
    const ctx = await harness()
    const session = ctx.sessions.create(SESSION, { meta: { cwd: '/workspace' } })
    const origin = human('req-1')
    session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [origin] })
    session.append('turn/start', { turn: 1 })
    session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', rewriteOf(origin, 'req-1'), { surfaceOp: 'append' })
    const reader = new PromptAdmissionReader()
    expect(() => reader.admitted(session, 'req-1' as SessionRequestId))
      .toThrow(/not initialized/)
    await reader.initialize(ctx)
    expect(reader.admitted(session, 'req-1' as SessionRequestId)).toBe(true)
    expect(reader.acceptedOrInFlight(session, 'req-1' as SessionRequestId)).toBe(true)
    expect(reader.admitted(session, 'req-2' as SessionRequestId)).toBe(false)
  })

  it('reports a live claim as in flight without admitting it permanently', async () => {
    const ctx = await harness()
    const session = ctx.sessions.create(SessionId('prompt-admission-claim'), { meta: { cwd: '/workspace' } })
    const origin = human('req-1')
    session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [origin] })
    session.append('turn/start', { turn: 1 })
    session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
    const reader = new PromptAdmissionReader()
    await reader.initialize(ctx)
    expect(reader.acceptedOrInFlight(session, 'req-1' as SessionRequestId)).toBe(true)
    expect(reader.admitted(session, 'req-1' as SessionRequestId)).toBe(false)
    session.append('step/start', { turn: 1, step: 1 })
    session.append('step/end', { turn: 1, step: 1 })
    expect(reader.acceptedOrInFlight(session, 'req-1' as SessionRequestId)).toBe(false)
  })
})
