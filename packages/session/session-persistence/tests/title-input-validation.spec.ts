/**
 * Cold-read validation of the two required title-input events: a valid
 * origin/direct/mixed log is accepted, a mismatched reference is refused as
 * corruption before adoption, and older logs keep their read behavior.
 */

import { describe, expect, it } from 'vitest'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  SessionFormatUnsupportedError,
  SessionPersistenceCorruptionError,
  validateStoredEvents,
} from '../src/index.ts'
import { meta } from './contract.ts'

/** A structural stored-event fixture; the cast is a widening to the session envelope. */
interface FixtureEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: object
  readonly surfaceOp?: string
  readonly ignorable?: boolean
}

function event(fixture: FixtureEvent): SessionEvent {
  return fixture as SessionEvent
}

function humanMessage(id: string, text: string, rpcId?: string): Record<string, unknown> {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: rpcId === undefined ? { kind: 'user' } : { kind: 'user', rpcId },
  }
}

function rewrittenMessage(id: string, text: string, rpcId: string): Record<string, unknown> {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'title-persistence-handoff', rpcId },
  }
}

function producerMessage(id: string, text = 'producer occurrence'): Record<string, unknown> {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'title-persistence-producer' },
  }
}

function userMessage(seq: number, data: object): SessionEvent {
  return event({ type: 'user/message', seq, time: seq + 1, data, surfaceOp: 'append' })
}

/**
 * A claimed-and-rewritten occurrence: insert, open the Turn, claim, enter the
 * first step, admit the rewrite, then close the step and turn.
 */
function rewrittenOriginEvents(): SessionEvent[] {
  return [
    event({
      type: 'agent/inbox/spliced',
      seq: 0,
      time: 1,
      data: { target: 'next-turn', start: 0, inserted: [humanMessage('m1', 'original human text', 'req-1')] },
    }),
    event({ type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } }),
    event({
      type: 'agent/inbox/spliced',
      seq: 2,
      time: 3,
      data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] },
    }),
    event({ type: 'step/start', seq: 3, time: 4, data: { turn: 1, step: 1 } }),
    userMessage(4, rewrittenMessage('m1', 'effective human text', 'req-1')),
    event({ type: 'step/end', seq: 5, time: 6, data: { turn: 1, step: 1 } }),
    event({ type: 'turn/end', seq: 6, time: 7, data: { turn: 1, reason: { kind: 'completed' } } }),
  ]
}

const ORIGIN_REF = {
  kind: 'origin',
  originalInboxSeq: 0,
  messageId: 'm1',
  claimSeq: 2,
  admittedSeq: 4,
} as const

function originTitle(seq: number, inputRefs: readonly object[] = [ORIGIN_REF]): SessionEvent {
  return event({
    type: 'session/title-from-input',
    seq,
    time: seq + 1,
    data: { title: 'title', inputRefs, source: { kind: 'fallback' } },
  })
}

describe('validateStoredEvents title-input gate', () => {
  it('accepts a claimed-origin title whose rewrite entered the claim step', () => {
    const events = [...rewrittenOriginEvents(), originTitle(7)]
    expect(validateStoredEvents(meta('origin-title'), events)).toBe(events)
  })

  it('accepts a mixed direct and origin selection in admission order', () => {
    // Insert the direct human message before the turn, then claim a second one.
    const events: SessionEvent[] = [
      event({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }),
      userMessage(1, humanMessage('direct', 'direct human text')),
      event({
        type: 'agent/inbox/spliced',
        seq: 2,
        time: 3,
        data: { target: 'next-turn', start: 0, inserted: [humanMessage('m1', 'original human text', 'req-1')] },
      }),
      event({
        type: 'agent/inbox/spliced',
        seq: 3,
        time: 4,
        data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] },
      }),
      event({ type: 'step/start', seq: 4, time: 5, data: { turn: 1, step: 1 } }),
      userMessage(5, rewrittenMessage('m1', 'effective human text', 'req-1')),
      event({
        type: 'session/title-from-input',
        seq: 6,
        time: 7,
        data: {
          title: 'mixed title',
          inputRefs: [
            { kind: 'message', messageSeq: 1 },
            { kind: 'origin', originalInboxSeq: 2, messageId: 'm1', claimSeq: 3, admittedSeq: 5 },
          ],
          source: { kind: 'provider', provider: 'test-provider', model: { provider: 'mock', model: 'title' } },
        },
      }),
    ]
    expect(validateStoredEvents(meta('mixed-title'), events)).toBe(events)
  })

  it('accepts the exact auxiliary request audit record for the same origin selection', () => {
    const events = [
      ...rewrittenOriginEvents(),
      event({
        type: 'session/title-llm-request-from-input',
        seq: 7,
        time: 8,
        data: {
          titleProvider: 'session-title-first-prompt-llm',
          inputRefs: [ORIGIN_REF],
          route: { provider: 'mock', model: 'title' },
          system: 'Return a title.',
          messages: [{
            id: 'audit-1',
            role: 'user',
            content: [{ type: 'text', text: 'Generate the title.' }],
            source: { kind: 'dsh-session-title-llm' },
          }],
          maxTokens: 24,
        },
      }),
    ]
    expect(validateStoredEvents(meta('audit-title'), events)).toBe(events)
  })

  it('refuses an explicit user source on the generated title', () => {
    const events = [
      ...rewrittenOriginEvents(),
      event({
        type: 'session/title-from-input',
        seq: 7,
        time: 8,
        data: { title: 'title', inputRefs: [ORIGIN_REF], source: { kind: 'user' } },
      }),
    ]
    expect(() => validateStoredEvents(meta('user-source'), events)).toThrow(SessionPersistenceCorruptionError)
    expect(() => validateStoredEvents(meta('user-source'), events)).toThrow(/source must be "fallback" or "provider"/)
  })

  it('refuses an empty, duplicated, or descending selection', () => {
    const base = rewrittenOriginEvents()
    expect(() => validateStoredEvents(meta('empty'), [...base, originTitle(7, [])]))
      .toThrow(/inputRefs must be a non-empty array/)
    expect(() => validateStoredEvents(meta('duplicate'), [...base, originTitle(7, [ORIGIN_REF, ORIGIN_REF])]))
      .toThrow(/inputRefs must be unique and ordered/)
    expect(() => validateStoredEvents(meta('descending'), [...base, originTitle(7, [
      { kind: 'origin', originalInboxSeq: 0, messageId: 'm1', claimSeq: 2, admittedSeq: 4 },
      { kind: 'origin', originalInboxSeq: 0, messageId: 'm1', claimSeq: 2, admittedSeq: 3 },
    ])]))
      .toThrow(/inputRefs must be unique and ordered/)
  })

  it('refuses a selection with no origin reference', () => {
    const events = [
      event({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }),
      userMessage(1, humanMessage('direct', 'direct human text')),
      event({
        type: 'session/title-from-input',
        seq: 2,
        time: 3,
        data: { title: 'title', inputRefs: [{ kind: 'message', messageSeq: 1 }], source: { kind: 'fallback' } },
      }),
    ]
    expect(() => validateStoredEvents(meta('direct-only'), events)).toThrow(/at least one origin input/)
  })

  it('refuses an origin ref whose admitted message is not a rewrite', () => {
    // The same id is admitted with the human source, so no origin evidence exists.
    const events = [
      ...rewrittenOriginEvents(),
    ]
    events[4] = userMessage(4, humanMessage('m1', 'still human', 'req-1'))
    events.push(originTitle(7))
    expect(() => validateStoredEvents(meta('human-admission'), events)).toThrow(SessionPersistenceCorruptionError)
    expect(() => validateStoredEvents(meta('human-admission'), events))
      .toThrow(/does not match its claim and admission/)
  })

  it('refuses a window consumed by step/end before the admission', () => {
    // The step closes before the admitted message; a later admission in the
    // same Turn cannot reuse the claim window.
    const events: SessionEvent[] = [
      event({
        type: 'agent/inbox/spliced',
        seq: 0,
        time: 1,
        data: { target: 'next-turn', start: 0, inserted: [humanMessage('m1', 'original human text', 'req-1')] },
      }),
      event({ type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } }),
      event({
        type: 'agent/inbox/spliced',
        seq: 2,
        time: 3,
        data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] },
      }),
      event({ type: 'step/start', seq: 3, time: 4, data: { turn: 1, step: 1 } }),
      event({ type: 'step/end', seq: 4, time: 5, data: { turn: 1, step: 1 } }),
      userMessage(5, rewrittenMessage('m1', 'effective human text', 'req-1')),
      event({ type: 'turn/end', seq: 6, time: 7, data: { turn: 1, reason: { kind: 'completed' } } }),
      originTitle(7, [{
        kind: 'origin', originalInboxSeq: 0, messageId: 'm1', claimSeq: 2, admittedSeq: 5,
      }]),
    ]
    expect(() => validateStoredEvents(meta('spent-window'), events)).toThrow(/is not an admitted rewrite/)
  })

  it('refuses a correlation mismatch between the occurrence and its rewrite', () => {
    const events = [...rewrittenOriginEvents()]
    events[4] = userMessage(4, rewrittenMessage('m1', 'effective human text', 'req-other'))
    events.push(originTitle(7))
    expect(() => validateStoredEvents(meta('correlation'), events)).toThrow(/is not an admitted rewrite/)
  })

  it('refuses an originalInboxSeq that does not match the claim', () => {
    const events = [...rewrittenOriginEvents(), originTitle(7, [{
      kind: 'origin', originalInboxSeq: 1, messageId: 'm1', claimSeq: 2, admittedSeq: 4,
    }])]
    expect(() => validateStoredEvents(meta('wrong-origin'), events)).toThrow(/does not match its claim/)
  })

  it('refuses a malformed auxiliary request audit record', () => {
    const events = [
      ...rewrittenOriginEvents(),
      event({
        type: 'session/title-llm-request-from-input',
        seq: 7,
        time: 8,
        data: {
          titleProvider: 'session-title-first-prompt-llm',
          inputRefs: [ORIGIN_REF],
          route: { provider: 'mock', model: 'title' },
          system: 'Return a title.',
          messages: [{
            id: 'audit-1',
            role: 'user',
            content: [{ type: 'text', text: 'Generate the title.' }],
            source: { kind: 'user' },
          }],
          maxTokens: 24,
        },
      }),
    ]
    expect(() => validateStoredEvents(meta('audit-source'), events))
      .toThrow(/source.kind must be "dsh-session-title-llm"/)
  })

  it('refuses an auxiliary request with two messages or two text blocks', () => {
    const audit = (messages: unknown[]) => event({
      type: 'session/title-llm-request-from-input',
      seq: 7,
      time: 8,
      data: {
        titleProvider: 'session-title-first-prompt-llm',
        inputRefs: [ORIGIN_REF],
        route: { provider: 'mock', model: 'title' },
        system: 'Return a title.',
        messages,
        maxTokens: 24,
      },
    })
    const oneMessage = {
      id: 'audit-1',
      role: 'user',
      content: [{ type: 'text', text: 'Generate the title.' }],
      source: { kind: 'dsh-session-title-llm' },
    }
    expect(() => validateStoredEvents(meta('two-audit-messages'), [
      ...rewrittenOriginEvents(), audit([oneMessage, { ...oneMessage, id: 'audit-2' }]),
    ])).toThrow(/messages must contain exactly one user message/)
    expect(() => validateStoredEvents(meta('two-text-blocks'), [
      ...rewrittenOriginEvents(), audit([{
        ...oneMessage,
        content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }],
      }]),
    ])).toThrow(/content must contain exactly one text block/)
  })

  it('still refuses an unknown required event as unsupported, never as corruption', () => {
    const unknown = event({ type: 'mystery/event', seq: 8, time: 9, data: {} })
    const validThenUnknown = [...rewrittenOriginEvents(), originTitle(7), unknown]
    expect(() => validateStoredEvents(meta('unknown-after'), validThenUnknown)).toThrow(SessionFormatUnsupportedError)
    const corruptThenUnknown = [
      ...rewrittenOriginEvents(),
      event({
        type: 'session/title-from-input',
        seq: 7,
        time: 8,
        data: { title: 'title', inputRefs: [ORIGIN_REF], source: { kind: 'user' } },
      }),
      unknown,
    ]
    expect(() => validateStoredEvents(meta('unknown-first'), corruptThenUnknown)).toThrow(SessionFormatUnsupportedError)
  })

  it('accepts a claimed human occurrence behind producer entries and lane shifts', () => {
    // Producer-only entries occupy real lane positions and must count for splice
    // bounds and index shifts; only the human occurrence becomes a title input.
    const events: SessionEvent[] = [
      event({
        type: 'agent/inbox/spliced',
        seq: 0,
        time: 1,
        data: {
          target: 'next-step',
          start: 0,
          inserted: [producerMessage('producer-a'), humanMessage('m1', 'original human text', 'req-mixed')],
        },
      }),
      event({
        type: 'agent/inbox/spliced',
        seq: 1,
        time: 2,
        data: { target: 'next-turn', start: 0, inserted: [humanMessage('pending-turn', 'other lane human')] },
      }),
      event({
        type: 'agent/inbox/spliced',
        seq: 2,
        time: 3,
        data: { target: 'next-step', start: 0, removedCount: 0, inserted: [producerMessage('producer-b')] },
      }),
      event({ type: 'turn/start', seq: 3, time: 4, data: { turn: 1 } }),
      event({
        type: 'agent/inbox/spliced',
        seq: 4,
        time: 5,
        data: { target: 'next-step', start: 0, removedCount: 3, inserted: [] },
      }),
      event({ type: 'step/start', seq: 5, time: 6, data: { turn: 1, step: 1 } }),
      userMessage(6, rewrittenMessage('m1', 'effective human text', 'req-mixed')),
      event({ type: 'step/end', seq: 7, time: 8, data: { turn: 1, step: 1 } }),
      event({ type: 'turn/end', seq: 8, time: 9, data: { turn: 1, reason: { kind: 'completed' } } }),
      originTitle(9, [{
        kind: 'origin', originalInboxSeq: 0, messageId: 'm1', claimSeq: 4, admittedSeq: 6,
      }]),
    ]
    expect(validateStoredEvents(meta('mixed-producer'), events)).toBe(events)
  })

  it('keeps a pending human occurrence when an unclaimed producer message repeats its id', () => {
    // A user/message does not mutate the authoritative Inbox; only the later
    // real claim removes the human occurrence it names.
    const events: SessionEvent[] = [
      event({
        type: 'agent/inbox/spliced',
        seq: 0,
        time: 1,
        data: { target: 'next-step', start: 0, inserted: [humanMessage('m1', 'original human text', 'req-1')] },
      }),
      userMessage(1, producerMessage('m1', 'unclaimed producer message')),
      event({ type: 'turn/start', seq: 2, time: 3, data: { turn: 1 } }),
      event({
        type: 'agent/inbox/spliced',
        seq: 3,
        time: 4,
        data: { target: 'next-step', start: 0, removedCount: 1, inserted: [] },
      }),
      event({ type: 'step/start', seq: 4, time: 5, data: { turn: 1, step: 1 } }),
      userMessage(5, rewrittenMessage('m1', 'effective human text', 'req-1')),
      originTitle(6, [{
        kind: 'origin', originalInboxSeq: 0, messageId: 'm1', claimSeq: 3, admittedSeq: 5,
      }]),
    ]
    expect(validateStoredEvents(meta('unclaimed-producer'), events)).toBe(events)
  })

  it('admits claims from both lanes after the same entered step', () => {
    const events: SessionEvent[] = [
      event({
        type: 'agent/inbox/spliced',
        seq: 0,
        time: 1,
        data: { target: 'next-turn', start: 0, inserted: [humanMessage('m1', 'turn human', 'req-a')] },
      }),
      event({
        type: 'agent/inbox/spliced',
        seq: 1,
        time: 2,
        data: { target: 'next-step', start: 0, inserted: [humanMessage('m2', 'step human', 'req-b')] },
      }),
      event({ type: 'turn/start', seq: 2, time: 3, data: { turn: 1 } }),
      event({
        type: 'agent/inbox/spliced',
        seq: 3,
        time: 4,
        data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] },
      }),
      event({
        type: 'agent/inbox/spliced',
        seq: 4,
        time: 5,
        data: { target: 'next-step', start: 0, removedCount: 1, inserted: [] },
      }),
      event({ type: 'step/start', seq: 5, time: 6, data: { turn: 1, step: 1 } }),
      userMessage(6, rewrittenMessage('m1', 'turn effective', 'req-a')),
      userMessage(7, rewrittenMessage('m2', 'step effective', 'req-b')),
      originTitle(8, [
        { kind: 'origin', originalInboxSeq: 0, messageId: 'm1', claimSeq: 3, admittedSeq: 6 },
        { kind: 'origin', originalInboxSeq: 1, messageId: 'm2', claimSeq: 4, admittedSeq: 7 },
      ]),
    ]
    expect(validateStoredEvents(meta('two-lanes'), events)).toBe(events)
  })

  it('refuses an origin whose pending occurrence was canceled instead of claimed', () => {
    const events: SessionEvent[] = [
      event({
        type: 'agent/inbox/spliced',
        seq: 0,
        time: 1,
        data: { target: 'next-step', start: 0, inserted: [humanMessage('m1', 'canceled human', 'req-1')] },
      }),
      event({ type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } }),
      event({
        type: 'agent/inbox/spliced',
        seq: 2,
        time: 3,
        data: { target: 'next-step', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' },
      }),
      event({ type: 'step/start', seq: 3, time: 4, data: { turn: 1, step: 1 } }),
      userMessage(4, rewrittenMessage('m1', 'late rewrite', 'req-1')),
      originTitle(5, [{
        kind: 'origin', originalInboxSeq: 0, messageId: 'm1', claimSeq: 2, admittedSeq: 4,
      }]),
    ]
    expect(() => validateStoredEvents(meta('canceled-claim'), events))
      .toThrow(/is not an admitted rewrite/)
  })

  it('invalidates a preserved claim window and accepts only its later reclaim', () => {
    const preserved: SessionEvent[] = [
      event({
        type: 'agent/inbox/spliced',
        seq: 0,
        time: 1,
        data: { target: 'next-step', start: 0, inserted: [humanMessage('m1', 'original human text', 'req-1')] },
      }),
      event({ type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } }),
      event({
        type: 'agent/inbox/spliced',
        seq: 2,
        time: 3,
        data: { target: 'next-step', start: 0, removedCount: 1, inserted: [] },
      }),
      event({ type: 'step/start', seq: 3, time: 4, data: { turn: 1, step: 1 } }),
      // preserveClaimed returns the occurrence to the pending lane; the old window is spent.
      event({
        type: 'agent/inbox/spliced',
        seq: 4,
        time: 5,
        data: { target: 'next-step', start: 0, removedCount: 0, inserted: [humanMessage('m1', 'original human text', 'req-1')] },
      }),
      userMessage(5, rewrittenMessage('m1', 'effective human text', 'req-1')),
    ]
    expect(() => validateStoredEvents(meta('preserved-claim'), [
      ...preserved,
      originTitle(6, [{
        kind: 'origin', originalInboxSeq: 0, messageId: 'm1', claimSeq: 2, admittedSeq: 5,
      }]),
    ])).toThrow(/is not an admitted rewrite/)

    const reclaimed: SessionEvent[] = [
      ...preserved.slice(0, 5),
      // A second real claim and its first entered step authorize the rewrite.
      event({
        type: 'agent/inbox/spliced',
        seq: 5,
        time: 6,
        data: { target: 'next-step', start: 0, removedCount: 1, inserted: [] },
      }),
      event({ type: 'step/start', seq: 6, time: 7, data: { turn: 1, step: 2 } }),
      userMessage(7, rewrittenMessage('m1', 'effective human text', 'req-1')),
      originTitle(8, [{
        kind: 'origin', originalInboxSeq: 4, messageId: 'm1', claimSeq: 5, admittedSeq: 7,
      }]),
    ]
    expect(validateStoredEvents(meta('reclaimed'), reclaimed)).toBe(reclaimed)
  })

  it('still refuses a splice that removes past the complete lane length', () => {
    // The producer entry makes the lane two long; a claim of three is still invalid.
    const events: SessionEvent[] = [
      event({
        type: 'agent/inbox/spliced',
        seq: 0,
        time: 1,
        data: { target: 'next-step', start: 0, inserted: [producerMessage('producer-a')] },
      }),
      event({
        type: 'agent/inbox/spliced',
        seq: 1,
        time: 2,
        data: { target: 'next-step', start: 0, removedCount: 2, inserted: [] },
      }),
      originTitle(3, [{
        kind: 'origin', originalInboxSeq: 0, messageId: 'm1', claimSeq: 1, admittedSeq: 2,
      }]),
    ]
    expect(() => validateStoredEvents(meta('over-remove'), events))
      .toThrow(/removes past the next-step lane/)
  })

  it('leaves a log without either new event on its existing read path', () => {
    const legacy = [
      event({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }),
      userMessage(1, humanMessage('human', 'human text')),
      event({ type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } }),
      event({
        type: 'session/title',
        seq: 3,
        time: 4,
        data: { title: 'legacy', messageSeqs: [SessionSeq(1)], source: { kind: 'user' } },
      }),
    ]
    expect(validateStoredEvents(meta('legacy-title'), legacy)).toBe(legacy)
  })
})
