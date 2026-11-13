import { createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import {
  admitsRewrite,
  advanceAdmissionWindow,
  claimAdmissionWindow,
  inboxCorrelationOf,
  inboxSpliceKind,
  inboxSpliceRemoved,
  isHumanInboxOccurrence,
  NO_ADMISSION_WINDOW,
} from '@deepseek-ai/dsh-agent/inbox-admission'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Test-only human occurrence that may carry a prompt correlation. */
    'test-human': { kind: 'user'; rpcId?: string }
    /** Test-only host rewrite that may carry the original correlation. */
    'test-rewrite': { kind: 'rewrite'; rpcId?: string }
  }
}

/** Build one human source with or without a correlation. */
function human(rpcId?: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: 'original' }],
    source: rpcId === undefined ? { kind: 'user' } : { kind: 'user', rpcId },
  })
}

/** Build one same-id rewrite of the supplied occurrence. */
function rewriteOf(origin: UserMessage, rpcId?: string): UserMessage {
  return freezeMessage({
    ...origin,
    content: [{ type: 'text', text: 'rewritten' }],
    source: rpcId === undefined ? { kind: 'rewrite' } : { kind: 'rewrite', rpcId },
  })
}

/** Build the step boundary events the window policy consumes. */
function stepStart(seq: number, turn = 1): SessionEvent {
  return { type: 'step/start', seq: SessionSeq(seq), time: 0, data: { turn, step: 1 } }
}

function stepEnd(seq: number, turn = 1): SessionEvent {
  return { type: 'step/end', seq: SessionSeq(seq), time: 0, data: { turn, step: 1 } }
}

function turnEnd(seq: number, turn = 1): SessionEvent {
  return { type: 'turn/end', seq: SessionSeq(seq), time: 0, data: { turn, reason: { kind: 'completed' } } }
}

/** One claimed window whose entered step already started. */
function enteredWindow(claimSeq = 2, stepStartSeq = 3) {
  return { claimSeq: SessionSeq(claimSeq), claimTurn: 1, stepStartSeq: SessionSeq(stepStartSeq) }
}

describe('inbox admission policy', () => {
  it('classifies claims separately from cancellation and ordinary mutation', () => {
    expect(inboxSpliceKind({ start: 0, removedCount: 1, inserted: [] })).toBe('claim')
    expect(inboxSpliceKind({
      start: 0, removedCount: 1, inserted: [], outcome: 'canceled',
    })).toBe('cancellation')
    expect(inboxSpliceKind({ start: 1, inserted: [] })).toBe('mutation')
    expect(inboxSpliceKind({ start: 0, inserted: [] })).toBe('mutation')
  })

  it('reads the narrow correlation without owning a request-id brand', () => {
    expect(inboxCorrelationOf(human('req-1'))).toBe('req-1')
    expect(inboxCorrelationOf(human())).toBeUndefined()
    const empty = freezeMessage({
      ...human(),
      source: { kind: 'user', rpcId: '' },
    })
    expect(inboxCorrelationOf(empty)).toBeUndefined()
  })

  it('recognizes only the human source kind as an original occurrence', () => {
    expect(isHumanInboxOccurrence(human())).toBe(true)
    expect(isHumanInboxOccurrence(rewriteOf(human(), 'req-1'))).toBe(false)
  })

  it('returns removed occurrences only for in-bounds persisted splices', () => {
    const lane = [human('a'), human('b')]
    expect(inboxSpliceRemoved(lane, { start: 0, removedCount: 1, inserted: [] }))
      .toEqual([lane[0]])
    expect(inboxSpliceRemoved(lane, { start: 3, inserted: [] })).toBeUndefined()
    expect(inboxSpliceRemoved(lane, { start: -1, inserted: [] })).toBeUndefined()
    expect(inboxSpliceRemoved(lane, { start: 0, removedCount: 3, inserted: [] }))
      .toBeUndefined()
    expect(inboxSpliceRemoved(lane, { start: 0, removedCount: -1, inserted: [] }))
      .toBeUndefined()
  })

  it('opens a claim window only inside an open Turn', () => {
    expect(claimAdmissionWindow(0, SessionSeq(2))).toBe(NO_ADMISSION_WINDOW)
    expect(claimAdmissionWindow(1, SessionSeq(2))).toEqual({
      claimSeq: SessionSeq(2), claimTurn: 1, stepStartSeq: null,
    })
  })

  it('enters the first step after the claim in the same Turn and closes on its end', () => {
    const claimed = claimAdmissionWindow(1, SessionSeq(2))
    const beforeClaim = advanceAdmissionWindow(claimed, stepStart(1))
    expect(beforeClaim).toBe(claimed)
    const otherTurn = advanceAdmissionWindow(claimed, stepStart(3, 2))
    expect(otherTurn).toBe(claimed)
    const entered = advanceAdmissionWindow(claimed, stepStart(3))
    expect(entered).toEqual({ claimSeq: SessionSeq(2), claimTurn: 1, stepStartSeq: SessionSeq(3) })
    expect(advanceAdmissionWindow(entered, stepStart(4))).toBe(entered)
    expect(advanceAdmissionWindow(entered, { type: 'user/message', seq: SessionSeq(4), time: 0, data: human(), surfaceOp: 'append' }))
      .toBe(entered)
    expect(advanceAdmissionWindow(entered, stepEnd(5))).toBe(NO_ADMISSION_WINDOW)
    expect(advanceAdmissionWindow(entered, turnEnd(5))).toBe(NO_ADMISSION_WINDOW)
    expect(advanceAdmissionWindow(NO_ADMISSION_WINDOW, stepStart(3))).toBe(NO_ADMISSION_WINDOW)
  })

  it('matches the same id and same correlation after the entered step', () => {
    const origin = human('req-1')
    expect(admitsRewrite(enteredWindow(), rewriteOf(origin, 'req-1'), SessionSeq(4), {
      messageId: origin.id, correlation: 'req-1',
    })).toBe(true)
  })

  it('refuses a same-id rewrite with another or missing correlation', () => {
    const origin = human('req-1')
    expect(admitsRewrite(enteredWindow(), rewriteOf(origin, 'req-2'), SessionSeq(4), {
      messageId: origin.id, correlation: 'req-1',
    })).toBe(false)
    expect(admitsRewrite(enteredWindow(), rewriteOf(origin), SessionSeq(4), {
      messageId: origin.id, correlation: 'req-1',
    })).toBe(false)
    expect(admitsRewrite(enteredWindow(), rewriteOf(origin, 'req-1'), SessionSeq(4), {
      messageId: origin.id, correlation: null,
    })).toBe(false)
  })

  it('admits an uncorrelated occurrence without inventing a correlation', () => {
    const origin = human()
    expect(admitsRewrite(enteredWindow(), rewriteOf(origin), SessionSeq(4), {
      messageId: origin.id, correlation: null,
    })).toBe(true)
    expect(admitsRewrite(enteredWindow(), rewriteOf(origin, 'req-1'), SessionSeq(4), {
      messageId: origin.id, correlation: null,
    })).toBe(false)
  })

  it('refuses another identity, a human admission, and an unentered step', () => {
    const origin = human('req-1')
    expect(admitsRewrite(enteredWindow(), rewriteOf(human('req-1'), 'req-1'), SessionSeq(4), {
      messageId: origin.id, correlation: 'req-1',
    })).toBe(false)
    expect(admitsRewrite(enteredWindow(), human('req-1'), SessionSeq(4), {
      messageId: origin.id, correlation: 'req-1',
    })).toBe(false)
    expect(admitsRewrite(claimAdmissionWindow(1, SessionSeq(2)), rewriteOf(origin, 'req-1'), SessionSeq(4), {
      messageId: origin.id, correlation: 'req-1',
    })).toBe(false)
    expect(admitsRewrite(enteredWindow(2, 4), rewriteOf(origin, 'req-1'), SessionSeq(4), {
      messageId: origin.id, correlation: 'req-1',
    })).toBe(false)
  })
})
