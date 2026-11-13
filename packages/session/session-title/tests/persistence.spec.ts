import { createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SessionStore, { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionTitleService, { foldSessionTitle } from '@deepseek-ai/dsh-session-title'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Test-only handoff rewrite that keeps the prompt request id. */
    'title-persistence-handoff': { kind: 'title-persistence-handoff'; rpcId: string }
    /** Test-only non-human producer occurrence sharing the pending lane. */
    'title-persistence-producer': { kind: 'title-persistence-producer' }
  }
}

const CONFIG = {
  fallbackMaxWords: 5,
  fallbackMaxBytes: 40,
  maxTitleBytes: 80,
} as const

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function appendPersistedTitle(ctx: Context, id: ReturnType<typeof SessionId>): Promise<void> {
  const session = ctx.sessions.create(id)
  const handle = await ctx.sessionPersistence.create(session.header)
  try {
    session.append('turn/start', {
      turn: 1,
    })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Persist this session title' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.sessionTitle.refresh(session)
  } finally {
    await handle.close()
  }
}

async function expectPersistedTitle(ctx: Context, id: ReturnType<typeof SessionId>): Promise<void> {
  const handle = await ctx.sessionPersistence.open(id, 'read')
  try {
    const { events } = await handle.read()
    expect(foldSessionTitle(events)).toMatchObject({
      title: 'Persist this session title',
      messageSeqs: [1],
      source: { kind: 'fallback' },
      eventSeq: 3,
    })
    expect(events.map(event => event.type)).toEqual([
      'turn/start',
      'user/message',
      'turn/end',
      'session/title',
    ])
  } finally {
    await handle.close()
  }
}

async function readStoredEvents(ctx: Context, id: ReturnType<typeof SessionId>): Promise<readonly SessionEvent[]> {
  const handle = await ctx.sessionPersistence.open(id, 'read')
  try {
    return (await handle.read()).events
  } finally {
    await handle.close()
  }
}

async function appendRewrittenOriginTitle(ctx: Context, id: ReturnType<typeof SessionId>): Promise<void> {
  const session = ctx.sessions.create(id)
  const handle = await ctx.sessionPersistence.create(session.header)
  try {
    const original = createUserMessage({
      content: [{ type: 'text', text: '磁盘上的原始真人请求' }],
      source: { kind: 'user', rpcId: 'req-persist' },
    })
    session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [original] })
    session.append('turn/start', { turn: 1 })
    session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', freezeMessage({
      ...original,
      content: [{ type: 'text', text: '磁盘上的有效消息' }],
      source: { kind: 'title-persistence-handoff', rpcId: 'req-persist' },
    }), { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.sessionTitle.refresh(session)
  } finally {
    await handle.close()
  }
}

/**
 * The real mixed lane: producer occurrences share the pending step lane, an
 * intermediate insertion shifts the human occurrence, and a second lane holds
 * an unrelated pending human. Only the claimed rewrite becomes a title input.
 */
async function appendMixedProducerOriginTitle(ctx: Context, id: ReturnType<typeof SessionId>): Promise<void> {
  const session = ctx.sessions.create(id)
  const handle = await ctx.sessionPersistence.create(session.header)
  try {
    const producer = createUserMessage({
      content: [{ type: 'text', text: 'producer occurrence' }],
      source: { kind: 'title-persistence-producer' },
    })
    const original = createUserMessage({
      content: [{ type: 'text', text: '磁盘上的原始真人请求' }],
      source: { kind: 'user', rpcId: 'req-mixed' },
    })
    session.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [producer, original] })
    session.append('agent/inbox/spliced', {
      target: 'next-turn', start: 0,
      inserted: [createUserMessage({ content: [{ type: 'text', text: '另一条待处理真人' }], source: { kind: 'user' } })],
    })
    session.append('agent/inbox/spliced', {
      target: 'next-step', start: 0, removedCount: 0,
      inserted: [createUserMessage({ content: [{ type: 'text', text: 'front producer' }], source: { kind: 'title-persistence-producer' } })],
    })
    session.append('turn/start', { turn: 1 })
    session.append('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 3, inserted: [] })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', freezeMessage({
      ...original,
      content: [{ type: 'text', text: '磁盘上的有效消息' }],
      source: { kind: 'title-persistence-handoff', rpcId: 'req-mixed' },
    }), { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.sessionTitle.refresh(session)
  } finally {
    await handle.close()
  }
}

describe('session title persistence round trips', () => {
  it('round-trips a rewritten-origin title and keeps its original text off the surface', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-title-origin-jsonl-'))
    roots.push(root)
    const id = SessionId('title-origin-jsonl')
    const writer = new Context()
    await writer.plugin(SessionStore)
    await writer.plugin(SessionProjectionRegistry)
    await writer.plugin(AgentRegistry)
    await writer.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    await writer.plugin(SessionTitleService, CONFIG)
    await appendRewrittenOriginTitle(writer, id)
    await writer.fiber.dispose()

    const reader = new Context()
    await reader.plugin(SessionStore)
    await reader.plugin(SessionProjectionRegistry)
    await reader.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const handle = await reader.sessionPersistence.open(id, 'read')
    try {
      const { events } = await handle.read()
      expect(events.map(event => event.type)).toEqual([
        'agent/inbox/spliced',
        'turn/start',
        'agent/inbox/spliced',
        'step/start',
        'user/message',
        'step/end',
        'turn/end',
        'session/title-from-input',
      ])
      expect(foldSessionTitle(events)).toMatchObject({
        title: '磁盘上的原始真人请求',
        messageSeqs: [],
        inputRefs: [{
          kind: 'origin',
          originalInboxSeq: 0,
          claimSeq: 2,
          admittedSeq: 4,
        }],
        source: { kind: 'fallback' },
      })
      const surface = JSON.stringify(Session.create(id, events).deriveMessages())
      expect(surface).not.toContain('磁盘上的原始真人请求')
      expect(surface).toContain('磁盘上的有效消息')
    } finally {
      await handle.close()
    }
    await reader.fiber.dispose()
  })

  it('round-trips through a remounted JSONL backend', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-title-jsonl-'))
    roots.push(root)
    const id = SessionId('title-jsonl')
    const writer = new Context()
    await writer.plugin(SessionStore)
    await writer.plugin(SessionProjectionRegistry)
    await writer.plugin(AgentRegistry)
    await writer.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    await writer.plugin(SessionTitleService, CONFIG)
    await appendPersistedTitle(writer, id)
    await writer.fiber.dispose()

    const reader = new Context()
    await reader.plugin(SessionStore)
    await reader.plugin(SessionProjectionRegistry)
    await reader.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    await expectPersistedTitle(reader, id)
    await reader.fiber.dispose()
  })

  it('refuses a forged origin ref on read and write before touching the raw file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-title-corrupt-jsonl-'))
    roots.push(root)
    const id = SessionId('title-corrupt-jsonl')
    const writer = new Context()
    await writer.plugin(SessionStore)
    await writer.plugin(SessionProjectionRegistry)
    await writer.plugin(AgentRegistry)
    await writer.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    await writer.plugin(SessionTitleService, CONFIG)
    await appendRewrittenOriginTitle(writer, id)
    await writer.fiber.dispose()

    const relative = (await readdir(root, { recursive: true }))
      .filter(name => name.endsWith('.jsonl'))
    expect(relative).toHaveLength(1)
    const file = join(root, relative[0]!)
    const lines = (await readFile(file, 'utf8')).trimEnd().split('\n')
    const header = lines[0]!
    const events = lines.slice(1).map(line => JSON.parse(line) as { seq: number; time: number })
    const last = events.at(-1)
    expect(last).toBeDefined()
    // A structurally plausible origin ref that no claim/admission supports: seq
    // 2 is the claim splice, not an admitted `user/message`.
    const forged = {
      type: 'session/title-from-input',
      seq: last!.seq + 1,
      time: last!.time + 1,
      data: {
        title: 'forged title',
        inputRefs: [{ kind: 'origin', originalInboxSeq: 0, messageId: 'missing', claimSeq: 1, admittedSeq: 2 }],
        source: { kind: 'fallback' },
      },
    }
    const corrupted = `${[header, ...lines.slice(1), JSON.stringify(forged)].join('\n')}\n`
    await writeFile(file, corrupted, 'utf8')
    const bytes = await readFile(file)
    const jsonlBefore = (await readdir(root, { recursive: true })).filter(name => name.endsWith('.jsonl')).sort()

    const reader = new Context()
    await reader.plugin(SessionStore)
    await reader.plugin(SessionProjectionRegistry)
    await reader.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    let readFailure: unknown
    try {
      await reader.sessionPersistence.open(id, 'read')
    } catch (error: unknown) {
      readFailure = error
    }
    expect(readFailure).toMatchObject({ name: 'SessionPersistenceCorruptionError' })
    expect((readFailure as Error).message).toContain('is not an admitted rewrite')

    let writeFailure: unknown
    try {
      await reader.sessionPersistence.open(id, 'write')
    } catch (error: unknown) {
      writeFailure = error
    }
    expect(writeFailure).toMatchObject({ name: 'SessionPersistenceCorruptionError' })
    expect((writeFailure as Error).message).toContain('is not an admitted rewrite')

    // Refusal happens before handle publication or any raw rewrite.
    expect(await readFile(file)).toEqual(bytes)
    expect((await readdir(root, { recursive: true })).filter(name => name.endsWith('.jsonl')).sort())
      .toEqual(jsonlBefore)
    await reader.fiber.dispose()
  })

  it('reads a real mixed-producer two-lane log back with its origin title', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-title-mixed-jsonl-'))
    roots.push(root)
    const id = SessionId('title-mixed-jsonl')
    const writer = new Context()
    await writer.plugin(SessionStore)
    await writer.plugin(SessionProjectionRegistry)
    await writer.plugin(AgentRegistry)
    await writer.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    await writer.plugin(SessionTitleService, CONFIG)
    await appendMixedProducerOriginTitle(writer, id)
    await writer.fiber.dispose()

    const reader = new Context()
    await reader.plugin(SessionStore)
    await reader.plugin(SessionProjectionRegistry)
    await reader.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const events = await readStoredEvents(reader, id)
    const claim = events.find(event => event.type === 'agent/inbox/spliced'
      && event.data.removedCount === 3)
    const admitted = events.find(event => event.type === 'user/message')
    expect(claim).toBeDefined()
    expect(admitted).toBeDefined()
    expect(foldSessionTitle(events)).toMatchObject({
      title: '磁盘上的原始真人请求',
      messageSeqs: [],
      inputRefs: [{
        kind: 'origin', originalInboxSeq: 0, claimSeq: claim!.seq, admittedSeq: admitted!.seq,
      }],
      source: { kind: 'fallback' },
    })
    const surface = JSON.stringify(Session.create(id, events).deriveMessages())
    expect(surface).not.toContain('磁盘上的原始真人请求')
    expect(surface).toContain('磁盘上的有效消息')
    await reader.fiber.dispose()
  })

  it('reopens fork cuts before and after the origin admission from disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-title-fork-jsonl-'))
    roots.push(root)
    const id = SessionId('title-fork-parent')
    const writer = new Context()
    await writer.plugin(SessionStore)
    await writer.plugin(SessionProjectionRegistry)
    await writer.plugin(AgentRegistry)
    await writer.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    await writer.plugin(SessionTitleService, CONFIG)
    await appendRewrittenOriginTitle(writer, id)
    const parent = writer.sessions.get(id)
    expect(parent).toBeDefined()
    // Before admission: the copied claim/entered-step prefix is closed by the
    // fork seed, so no admitted input or title exists in the child.
    const before = writer.sessions.fork(parent!, SessionSeq(3), SessionId('title-fork-before'))
    // After admission: the copied prefix contains the admitted rewrite and the
    // title that cites it.
    const after = writer.sessions.fork(parent!, SessionSeq(7), SessionId('title-fork-after'))
    for (const child of [before, after]) {
      const handle = await writer.sessionPersistence.create(child.header, {
        inheritedEventCount: child.inheritedEventCount,
      })
      try {
        await handle.append(child.snapshotEvents())
      } finally {
        await handle.close()
      }
    }
    await writer.fiber.dispose()

    const reader = new Context()
    await reader.plugin(SessionStore)
    await reader.plugin(SessionProjectionRegistry)
    await reader.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const beforeEvents = await readStoredEvents(reader, before.id)
    expect(beforeEvents.some(event => event.type === 'user/message')).toBe(false)
    expect(beforeEvents.some(event => event.type === 'session/end-seed')).toBe(true)
    expect(foldSessionTitle(beforeEvents)).toBeUndefined()

    const afterEvents = await readStoredEvents(reader, after.id)
    expect(afterEvents.some(event => event.type === 'user/message')).toBe(true)
    expect(foldSessionTitle(afterEvents)).toMatchObject({
      title: '磁盘上的原始真人请求',
      messageSeqs: [],
      inputRefs: [{ kind: 'origin', originalInboxSeq: 0, claimSeq: 2, admittedSeq: 4 }],
      source: { kind: 'fallback' },
    })
    await reader.fiber.dispose()
  })
})
