import { describe, expect, it } from 'vitest'
import { recoverRewrittenCallerInputs } from '../src/rewritten-input.ts'

const REWRITE_SOURCE = 'snapshot-prompt-rewrite'
const ORIGINAL = 'the human caller prompt'
const EFFECTIVE = 'the effective pre-step prompt'

type Row = Record<string, unknown>

const HEADER: Row = {
  type: 'session', version: 4, id: 'session-1', createdAt: 0, cwd: '/work', isSeeded: false, delegationDepth: 0,
}

function render(rows: readonly Row[]): string {
  return rows.map(row => JSON.stringify(row)).join('\n') + '\n'
}

function log(...events: Row[]): string {
  return render([HEADER, ...events])
}

function message(id: string, text: string, source: Row = { kind: 'user' }): Row {
  return { id, role: 'user', content: [{ type: 'text', text }], source }
}

function rewritten(id: string, text: string, source: Row = { kind: REWRITE_SOURCE }): Row {
  return message(id, text, source)
}

function admitted(id: string, text: string, source: Row = { kind: REWRITE_SOURCE }): Row {
  return { type: 'user/message', data: rewritten(id, text, source), surfaceOp: 'append' }
}

function splice(target: 'next-turn' | 'next-step', start: number, inserted: Row[], extra: Row = {}): Row {
  return { type: 'agent/inbox/spliced', data: { target, start, inserted, ...extra } }
}

function claim(target: 'next-turn' | 'next-step', start: number, removedCount: number): Row {
  return splice(target, start, [], { removedCount })
}

const turnStart = (turn: number): Row => ({ type: 'turn/start', data: { turn } })
const turnEnd = (turn: number): Row => ({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
const stepStart = (turn: number, step: number): Row => ({ type: 'step/start', data: { turn, step } })
const stepEnd = (turn: number, step: number): Row => ({ type: 'step/end', data: { turn, step } })

describe('rewritten caller input recovery', () => {
  it('recovers a caller source with no request id, matching an admission that also carries none', () => {
    const recovered = recoverRewrittenCallerInputs(log(
      splice('next-turn', 0, [message('m1', ORIGINAL)]),
      turnStart(1),
      claim('next-turn', 0, 1),
      stepStart(1, 1),
      admitted('m1', EFFECTIVE),
    ))

    expect(recovered).toEqual([{ turn: 1, content: [{ type: 'text', text: ORIGINAL }] }])
  })

  it('matches identical request correlations and keeps lane coordinates beside another producer', () => {
    const recovered = recoverRewrittenCallerInputs(log(
      splice('next-turn', 0, [message('ctx', 'runtime context', {
        kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'working-directory:current', text: 'cwd' }],
      })]),
      splice('next-turn', 1, [message('m1', ORIGINAL, { kind: 'user', rpcId: 'req-1' })]),
      turnStart(1),
      claim('next-turn', 1, 1),
      stepStart(1, 1),
      admitted('m1', EFFECTIVE, { kind: REWRITE_SOURCE, rpcId: 'req-1' }),
    ))

    expect(recovered).toEqual([{ turn: 1, content: [{ type: 'text', text: ORIGINAL }] }])
  })

  it('recovers one caller input per rewritten turn across turns', () => {
    const recovered = recoverRewrittenCallerInputs(log(
      splice('next-turn', 0, [message('m1', 'first original')]),
      turnStart(1),
      claim('next-turn', 0, 1),
      stepStart(1, 1),
      admitted('m1', 'first effective'),
      stepEnd(1, 1),
      turnEnd(1),
      splice('next-turn', 0, [message('m2', 'second original', { kind: 'user', rpcId: 'req-2' })]),
      turnStart(2),
      claim('next-turn', 0, 1),
      stepStart(2, 1),
      admitted('m2', 'second effective', { kind: REWRITE_SOURCE, rpcId: 'req-2' }),
    ))

    expect(recovered).toEqual([
      { turn: 1, content: [{ type: 'text', text: 'first original' }] },
      { turn: 2, content: [{ type: 'text', text: 'second original' }] },
    ])
  })

  it('ignores a canceled occurrence instead of treating its removal as a claim', () => {
    const recovered = recoverRewrittenCallerInputs(log(
      splice('next-turn', 0, [message('m1', ORIGINAL)]),
      turnStart(1),
      splice('next-turn', 0, [], { removedCount: 1, outcome: 'canceled', cause: 'user' }),
      stepStart(1, 1),
      admitted('m1', EFFECTIVE),
    ))

    expect(recovered).toEqual([])
  })

  it('refuses an admission under a claimed identity without the entered-step evidence', () => {
    expect(() => recoverRewrittenCallerInputs(log(
      splice('next-turn', 0, [message('m1', ORIGINAL)]),
      turnStart(1),
      claim('next-turn', 0, 1),
      admitted('m1', EFFECTIVE),
      stepStart(1, 1),
    ))).toThrow('without the claim, entered-step, and correlation evidence')
  })

  it('refuses an admission whose request correlation differs from the claimed occurrence', () => {
    expect(() => recoverRewrittenCallerInputs(log(
      splice('next-turn', 0, [message('m1', ORIGINAL, { kind: 'user', rpcId: 'req-1' })]),
      turnStart(1),
      claim('next-turn', 0, 1),
      stepStart(1, 1),
      admitted('m1', EFFECTIVE, { kind: REWRITE_SOURCE, rpcId: 'req-other' }),
    ))).toThrow('without the claim, entered-step, and correlation evidence')
  })

  it('refuses an admission that adds a request id the claimed occurrence never carried', () => {
    expect(() => recoverRewrittenCallerInputs(log(
      splice('next-turn', 0, [message('m1', ORIGINAL)]),
      turnStart(1),
      claim('next-turn', 0, 1),
      stepStart(1, 1),
      admitted('m1', EFFECTIVE, { kind: REWRITE_SOURCE, rpcId: 'req-1' }),
    ))).toThrow('without the claim, entered-step, and correlation evidence')
  })

  it('refuses a second rewritten caller input in one turn', () => {
    expect(() => recoverRewrittenCallerInputs(log(
      splice('next-turn', 0, [message('m1', 'first')]),
      splice('next-turn', 1, [message('m2', 'second')]),
      turnStart(1),
      claim('next-turn', 0, 2),
      stepStart(1, 1),
      admitted('m1', EFFECTIVE),
      admitted('m2', EFFECTIVE),
    ))).toThrow('admitted more than one rewritten caller input')
  })

  it('does not treat another producer or an uncorrelated human insertion as the caller', () => {
    expect(recoverRewrittenCallerInputs(log(
      splice('next-turn', 0, [message('m1', ORIGINAL, {
        kind: 'runtime-context', form: 'notice', summary: 'not a caller',
      })]),
      turnStart(1),
      claim('next-turn', 0, 1),
      stepStart(1, 1),
      admitted('m1', EFFECTIVE),
    ))).toEqual([])
  })

  it('does not recover after step/end spent the claim window', () => {
    const recovered = recoverRewrittenCallerInputs(log(
      splice('next-turn', 0, [message('m1', ORIGINAL)]),
      turnStart(1),
      claim('next-turn', 0, 1),
      stepStart(1, 1),
      stepEnd(1, 1),
      stepStart(1, 2),
      admitted('m1', EFFECTIVE),
    ))

    expect(recovered).toEqual([])
  })

  it('requires the projected Session header row', () => {
    expect(() => recoverRewrittenCallerInputs(render([turnStart(1)])))
      .toThrow('session snapshot line 1')
  })
})
