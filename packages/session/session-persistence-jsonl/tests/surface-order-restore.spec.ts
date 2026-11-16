/**
 * A recorded surface ordering must survive the real JSONL writer and cold read:
 * after the reorder a multi-node replacement cites the nodes it shadows in the
 * current order, so the reader's format validation has to replay the ordering
 * before it checks replacement coverage.
 */

import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generationLogPath } from '../src/format.ts'

const id = SessionId('surface-order-reopen')

/** One turn whose surface is reordered and then replaced across two permuted positions. */
function orderedSession(): Session {
  const session = Session.create(id)
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const prompt = (text: string) => createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
  const a = session.append('user/message', prompt('a'), { surfaceOp: 'append' })
  const b = session.append('user/message', prompt('b'), { surfaceOp: 'append' })
  const c = session.append('user/message', prompt('c'), { surfaceOp: 'append' })
  const d = session.append('user/message', prompt('d'), { surfaceOp: 'append' })
  // [a, b, c, d] → [a, c, b, d]: c now precedes b.
  session.append('surface/order', { nodes: [a.seq, c.seq, b.seq, d.seq] })
  // The contiguous span in the CURRENT order is [b, d] at positions 2..3.
  session.append('user/message', prompt('merged'), {
    surfaceOp: { op: 'replace', startSeq: b.seq, endSeq: d.seq },
    sourceEventSeqs: [b.seq, d.seq],
  })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session
}

/** Text of each derived message, in model-visible order. */
function texts(session: Session): string[] {
  return session.deriveMessages().flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
}

describe('current reader replays a recorded surface ordering', () => {
  let root: string
  let ctx: Context

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-surface-order-'))
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

  it('reopens a multi-node replacement committed after an ordering', async () => {
    const session = orderedSession()
    const path = await write(session)
    expect(texts(session)).toEqual(['a', 'c', 'merged'])
    expect(await readFile(path, 'utf8')).toContain('"surface/order"')

    const reader = await ctx.sessionPersistence.open(id, 'read')
    const restored = await (async () => {
      try {
        return await reader.read()
      } finally {
        await reader.close()
      }
    })()
    const reopened = Session.create(SessionId('reopened'), restored.events)
    expect(texts(reopened)).toEqual(['a', 'c', 'merged'])
    expect(reopened.snapshotEvents().filter(event => event.type === 'surface/order')).toHaveLength(1)
  })

  it('still refuses a replacement that omits a node it shadows', async () => {
    const session = orderedSession()
    const path = await write(session)
    // Corrupt only the coverage list of the recorded replacement; nothing else
    // about the log changes, so only the completeness rule can refuse it.
    const rows = (await readFile(path, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    const replacement = rows.find(row => (row['surfaceOp'] as { op?: string } | undefined)?.op === 'replace')
    if (replacement === undefined) throw new Error('the fixture wrote no replacement event')
    const sources = replacement['sourceEventSeqs'] as number[]
    replacement['sourceEventSeqs'] = sources.slice(0, -1)
    await writeFile(path, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`)

    // The reader refuses at open: the incomplete coverage list is corruption,
    // not a log this build may quietly reinterpret.
    await expect(ctx.sessionPersistence.open(id, 'read')).rejects
      .toThrow('replacement sourceEventSeqs omit a shadowed surface node')
  })
})
