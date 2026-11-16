/**
 * An empty user replacement carrier must survive the real JSONL writer and cold
 * read: its record and surface position persist, it derives no model message,
 * the surrounding non-cleanup material keeps its attachments, and the content
 * it shadowed never revives.
 */

import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { FileBlock, ImageBlock } from '@deepseek-ai/dsh-llm'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generationLogPath } from '../src/format.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'cleanup-carrier': { kind: 'cleanup-carrier' }
  }
}

const id = SessionId('empty-user-carrier-reopen')

const image: ImageBlock = {
  type: 'image',
  attachment: {
    attachmentId: 'att-image' as ImageBlock['attachment']['attachmentId'],
    mediaType: 'image/png',
    bytes: 1,
    width: 1,
    height: 1,
  },
}
const file: FileBlock = {
  type: 'file',
  attachment: {
    attachmentId: 'att-file' as FileBlock['attachment']['attachmentId'],
    name: 'notes.txt',
    bytes: 3,
  },
}

/** Two cleaned question/answer ranges around one user message that keeps its blocks. */
function cleanedSession(): Session {
  const session = Session.create(id)
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const ask = (text: string) => session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const answer = (text: string) => session.append('assistant/message', {
    stream: [],
    turn: 1, step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', ...{ provider: 'mock', model: 'mock' } },
    }),
  }, { surfaceOp: 'append' })
  const cleanup = (startSeq: SessionSeq, endSeq: SessionSeq) => session.append(
    'user/message',
    createUserMessage({ content: [], source: { kind: 'cleanup-carrier' } }),
    { surfaceOp: { op: 'replace', startSeq, endSeq }, sourceEventSeqs: [startSeq, endSeq] },
  )
  const firstQuestion = ask('cleaned question')
  const firstAnswer = answer('cleaned answer')
  session.append('user/message', createUserMessage({
    content: [image, file, { type: 'text', text: 'keep this material' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const secondQuestion = ask('second cleaned question')
  const secondAnswer = answer('second cleaned answer')
  cleanup(firstQuestion.seq, firstAnswer.seq)
  cleanup(secondQuestion.seq, secondAnswer.seq)
  return session
}

describe('empty user carrier survives the JSONL writer and cold read', () => {
  let root: string
  let ctx: Context

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-empty-user-carrier-'))
    ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  })

  afterEach(async () => {
    try {
      await ctx?.fiber.dispose()
    } finally {
      if (root !== undefined) await rm(root, { recursive: true, force: true })
    }
  })

  /** Persist one session through the real writer and close it. */
  async function write(session: Session): Promise<string> {
    const writer = await ctx.sessionPersistence.create(session.header, { inheritedEventCount: session.inheritedEventCount })
    try {
      await writer.append(session.snapshotEvents())
    } finally {
      await writer.close()
    }
    return generationLogPath(root, undefined, id, 4, 'none')
  }

  it('reopens with the carrier positions, no carrier message, and the material intact', async () => {
    const session = cleanedSession()
    const path = await write(session)
    const live = session.deriveMessages()
    expect(live.map(message => message.role)).toEqual(['user'])
    expect(live[0]!.content).toEqual([image, file, { type: 'text', text: 'keep this material' }])
    expect(session.surface.nodes).toHaveLength(3)

    const reader = await ctx.sessionPersistence.open(id, 'read')
    const restored = await (async () => {
      try {
        return await reader.read()
      } finally {
        await reader.close()
      }
    })()
    const reopened = Session.create(SessionId('empty-user-carrier-reopened'), restored.events)
    expect(reopened.surface.nodes).toEqual(session.surface.nodes)
    expect(reopened.deriveMessages()).toEqual(live)
    // An empty user message is a carrier, never a model message.
    expect(reopened.deriveMessages().some(message => message.content.length === 0)).toBe(false)
    // The cleaned questions, answers, and both carriers remain durable records.
    const carriers = reopened.snapshotEvents()
      .filter((event): event is Extract<SessionEvent, { type: 'user/message' }> => event.type === 'user/message'
        && event.data.source.kind === 'cleanup-carrier')
    expect(carriers).toHaveLength(2)
    expect(reopened.snapshotEvents().filter(event => event.type === 'user/message')).toHaveLength(5)
    for (const carrier of carriers) {
      expect(carrier.data.content).toEqual([])
      expect(carrier.surfaceOp).toMatchObject({ op: 'replace' })
    }
    expect(await readFile(path, 'utf8')).toContain('"cleanup-carrier"')
  })
})
