/** The two `system/message` commit alternatives enforced at the append and seed boundaries. */

import { describe, expect, it } from 'vitest'
import { Session, SessionId, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'

const id = SessionId('system-message-maintenance')
const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false }

function detached(): Session {
  return Session.create(id, undefined, header)
}

describe('system/message commit alternatives', () => {
  it('appends a maintenance head on the empty surface without turn or step', () => {
    const session = detached()
    const head = session.append(
      'system/message',
      { maintenance: true, message: createSystemMessage('rendered prompt') },
      { surfaceOp: 'append' },
    )
    expect(head.seq).toBe(SessionSeq(0))
    expect(session.surface.nodes).toEqual([SessionSeq(0)])
    expect(session.deriveMessages()).toMatchObject([{ role: 'system', source: { kind: 'system-prompt' } }])
  })

  it('rejects a maintenance head that extends an existing surface', () => {
    const session = detached()
    session.append(
      'system/message',
      { maintenance: true, message: createSystemMessage('head') },
      { surfaceOp: 'append' },
    )
    expect(() => session.append(
      'system/message',
      { maintenance: true, message: createSystemMessage('second head') },
      { surfaceOp: 'append' },
    )).toThrow(/must establish the empty surface head/)
  })

  it('rejects a mixed payload that names a turn or step beside the maintenance marker', () => {
    const session = detached()
    for (const mixed of [{ turn: 1, step: 1 }, { turn: 1 }, { step: 1 }]) {
      expect(() => session.append(
        'system/message',
        { maintenance: true, message: createSystemMessage('head'), ...mixed } as never,
        { surfaceOp: 'append' },
      )).toThrow(/must omit turn and step/)
    }
    expect(session.surface.nodes).toEqual([])
  })

  it('rejects a maintenance marker whose value is not true', () => {
    const session = detached()
    expect(() => session.append(
      'system/message',
      { maintenance: false, message: createSystemMessage('head') } as never,
      { surfaceOp: 'append' },
    )).toThrow(/maintenance marker must be true/)
    expect(session.surface.nodes).toEqual([])
  })

  it('requires positive turn and step on a turn-committed prompt', () => {
    const session = Session.create(id, [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
    ] as SessionEvent[], header)
    expect(() => session.append(
      'system/message',
      { turn: 0, step: 1, message: createSystemMessage('prompt') },
      { surfaceOp: 'append' },
    )).toThrow(/turn must be a positive safe integer/)
    expect(() => session.append(
      'system/message',
      { turn: 1, step: 0, message: createSystemMessage('prompt') },
      { surfaceOp: 'append' },
    )).toThrow(/step must be a positive safe integer/)
    const accepted = session.append(
      'system/message',
      { turn: 1, step: 1, message: createSystemMessage('prompt') },
      { surfaceOp: 'append' },
    )
    expect(session.surface.nodes).toEqual([accepted.seq])
  })
})

describe('restoring a maintenance head', () => {
  const head = (data: Record<string, unknown>): SessionEvent => ({
    type: 'system/message',
    seq: SessionSeq(2),
    time: 3,
    surfaceOp: 'append',
    data: { message: createSystemMessage('rendered prompt'), ...data },
  }) as SessionEvent
  const recorded: SessionEvent = {
    type: 'user/message',
    seq: SessionSeq(3),
    time: 4,
    surfaceOp: 'append',
    data: createUserMessage({ content: [{ type: 'text', text: 'recorded' }], source: { kind: 'user' } }),
  }
  const prefix: SessionEvent[] = [
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  ]

  it('rebuilds the head before the recorded formal history', () => {
    const session = Session.create(id, [...prefix, head({ maintenance: true }), recorded], header)
    expect(session.surface.nodes).toEqual([SessionSeq(2), SessionSeq(3)])
    expect(session.deriveMessages().map(message => message.role)).toEqual(['system', 'user'])
  })

  it('rejects a restored head that also names a turn or step', () => {
    for (const data of [{ maintenance: true, turn: 1 }, { maintenance: true, step: 1 }]) {
      expect(() => Session.create(id, [...prefix, head(data)], header)).toThrow(/must omit turn and step/)
    }
  })
})
