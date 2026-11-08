/**
 * The idle-history admission reads the surface owner's current fold state: the
 * protected head position and the first current carrier of one message
 * identity, compared against its exact recorded payload. These cases prove the
 * state is maintained across append, replacement, projection, and replay.
 */

import { describe, expect, it } from 'vitest'
import {
  SESSION_IDLE_HISTORY_ADMISSION,
  Session,
  SessionId,
  SessionSeq,
  deriveEventMessage,
} from '@deepseek-ai/dsh-session'
import type { SessionMessageProjection } from '@deepseek-ai/dsh-session'
import {
  MessageId,
  createSystemMessage,
  freezeMessage,
} from '@deepseek-ai/dsh-llm'
import type { Message, UserMessage } from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'test/idle-admission-project': { seq: SessionSeq; text: string }
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'test/idle-admission-numbered': { kind: 'test/idle-admission-numbered'; count: number }
    'test/idle-admission-meta': { kind: 'test/idle-admission-meta'; meta: object }
  }
}

const projection: SessionMessageProjection<'test/idle-admission-project'> = {
  type: 'test/idle-admission-project',
  project(event, context) {
    const source = context.events[event.data.seq - context.baseSeq]
    if (source === undefined) throw new Error('projection source is outside the loaded window')
    const original = deriveEventMessage(source, context.messages)
    if (original === null) throw new Error('projection source derives no message')
    return new Map([[source.seq, deepFreeze({
      ...original,
      content: [{ type: 'text' as const, text: event.data.text }],
    })]])
  },
}

/** Create one detached session, optionally with the test projection registered. */
function session(id: string, projections?: readonly SessionMessageProjection[]): Session {
  return Session.create(SessionId(id), undefined, undefined, undefined, projections)
}

/** Build one identified user message with a caller-chosen identity. */
function userMessage(id: string, text: string): UserMessage {
  return freezeMessage<UserMessage>({
    id: MessageId(id),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

/** Build one identified message whose source carries a number a retry can make non-lossless. */
function numberedMessage(id: string, count: number): UserMessage {
  return freezeMessage<UserMessage>({
    id: MessageId(id),
    role: 'user',
    content: [{ type: 'text', text: 'numbered' }],
    source: { kind: 'test/idle-admission-numbered', count },
  })
}

/** Build one identified message whose source carries an object-valued payload. */
function metaMessage(id: string, meta: object): UserMessage {
  return freezeMessage<UserMessage>({
    id: MessageId(id),
    role: 'user',
    content: [{ type: 'text', text: 'meta' }],
    source: { kind: 'test/idle-admission-meta', meta },
  })
}

/** Read the host-internal admission through the package-root symbol. */
function admission(subject: Session, message: Message) {
  return subject[SESSION_IDLE_HISTORY_ADMISSION](message)
}

describe('idle-history surface admission', () => {
  it('reports an empty surface, a protected empty head, and a foreign first node', () => {
    const empty = session('admission-empty')
    expect(admission(empty, userMessage('probe', 'probe'))).toEqual({ headSeq: null, carried: undefined })

    const headed = session('admission-empty-head')
    const head = headed.append(
      'system/message',
      { maintenance: true, message: createSystemMessage('') },
      { surfaceOp: 'append' },
    )
    expect(admission(headed, userMessage('probe', 'probe'))).toEqual({ headSeq: head.seq, carried: undefined })

    const foreign = session('admission-foreign')
    foreign.append('user/message', userMessage('first', 'first'), { surfaceOp: 'append' })
    expect(admission(foreign, userMessage('probe', 'probe'))).toEqual({ headSeq: null, carried: undefined })
  })

  it('compares the recorded message rather than a projected one', () => {
    const subject = session('admission-projection', [projection])
    const recorded = userMessage('projected-id', 'recorded text')
    const appended = subject.append('user/message', recorded, { surfaceOp: 'append' })
    subject.append('test/idle-admission-project', { seq: appended.seq, text: 'derived text' })
    expect(subject.deriveMessages()[0]?.content).toEqual([{ type: 'text', text: 'derived text' }])
    expect(admission(subject, recorded)).toEqual({
      headSeq: null,
      carried: { seq: appended.seq, same: true },
    })
    expect(admission(subject, userMessage('projected-id', 'derived text'))).toEqual({
      headSeq: null,
      carried: { seq: appended.seq, same: false },
    })
  })

  it('follows replacements and excludes shadowed carriers', () => {
    const subject = session('admission-replace')
    const first = subject.append('user/message', userMessage('first-id', 'first'), { surfaceOp: 'append' })
    const second = subject.append('user/message', userMessage('second-id', 'second'), { surfaceOp: 'append' })
    const replacement = subject.append('user/message', userMessage('replacement-id', 'replacement'), {
      surfaceOp: { op: 'replace', startSeq: first.seq, endSeq: first.seq },
      sourceEventSeqs: [first.seq],
    })
    expect(admission(subject, userMessage('first-id', 'first'))).toEqual({ headSeq: null, carried: undefined })
    expect(admission(subject, userMessage('second-id', 'second'))).toEqual({
      headSeq: null,
      carried: { seq: second.seq, same: true },
    })
    expect(admission(subject, userMessage('replacement-id', 'replacement'))).toEqual({
      headSeq: null,
      carried: { seq: replacement.seq, same: true },
    })
  })

  it('chooses the first current carrier for a duplicate identity', () => {
    const subject = session('admission-duplicate')
    const first = subject.append('user/message', userMessage('duplicate-id', 'same'), { surfaceOp: 'append' })
    subject.append('user/message', userMessage('duplicate-id', 'same'), { surfaceOp: 'append' })
    expect(admission(subject, userMessage('duplicate-id', 'same'))).toEqual({
      headSeq: null,
      carried: { seq: first.seq, same: true },
    })
  })

  it('treats a same-id submission the append boundary would reject as different content', () => {
    const subject = session('admission-invalid-retry')
    const numbered = numberedMessage('numbered-id', 0)
    const numberedSeq = subject.append('user/message', numbered, { surfaceOp: 'append' }).seq
    expect(admission(subject, numbered)).toEqual({
      headSeq: null,
      carried: { seq: numberedSeq, same: true },
    })
    expect(admission(subject, numberedMessage('numbered-id', -0))).toEqual({
      headSeq: null,
      carried: { seq: numberedSeq, same: false },
    })

    const meta = metaMessage('meta-id', {})
    const metaSeq = subject.append('user/message', meta, { surfaceOp: 'append' }).seq
    expect(admission(subject, meta)).toEqual({
      headSeq: null,
      carried: { seq: metaSeq, same: true },
    })
    for (const invalid of [new Date(), new Map(), new Set()]) {
      expect(admission(subject, metaMessage('meta-id', invalid))).toEqual({
        headSeq: null,
        carried: { seq: metaSeq, same: false },
      })
    }
  })

  it('reconstructs the same admission by replaying the committed log', () => {
    const subject = session('admission-replay')
    const head = subject.append(
      'system/message',
      { maintenance: true, message: createSystemMessage('prompt') },
      { surfaceOp: 'append' },
    )
    const message = userMessage('replay-id', 'replay text')
    subject.append('user/message', message, { surfaceOp: 'append' })
    const replayed = Session.create(subject.id, subject.snapshotEvents())
    expect(admission(replayed, message)).toEqual({
      headSeq: head.seq,
      carried: { seq: SessionSeq(1), same: true },
    })
  })
})
