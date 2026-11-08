/**
 * Native-entry checks for the Factory's initialization maintenance: a wake
 * latched while `agent/created` is still running may show up as a new turn only
 * after initialization succeeds. A failed initialization keeps the queue for a
 * later wake and releases the write handle without dispatching it.
 * @module dsh-agent-loop/tests/initialization-wake
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })

async function harness(adapter: MockAdapter): Promise<Context> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-initialization-wake-'))
  dirs.push(root)
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  // The backend mounts BEFORE the loop so root teardown unwinds the loop first.
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function message(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** Signal that the serial `agent/created` listener reached its own await point. */
function creationEntry(): { entered: Promise<undefined>; markEntered: () => void } {
  const entry = Promise.withResolvers<undefined>()
  return { entered: entry.promise, markEntered: () => { entry.resolve(undefined) } }
}

function userTexts(agent: Agent): string[] {
  return agent.session.snapshotEvents()
    .filter(event => event.type === 'user/message')
    .flatMap(event => event.type === 'user/message' ? event.data.content : [])
    .flatMap(block => block.type === 'text' ? [block.text] : [])
}

/** Read one stored session's physical validated log through a read handle. */
async function readStoredEvents(ctx: Context, sessionId: SessionId) {
  const handle = await ctx.sessionPersistence.open(sessionId, 'read')
  try {
    return (await handle.read()).events
  } finally {
    await handle.close()
  }
}

describe('Agent initialization wakeup', () => {
  it('keeps a proactive wake pending instead of dispatching it when initialization fails', async () => {
    const adapter = new MockAdapter([textResponse('queued reply'), textResponse('later reply')])
    const ctx = await harness(adapter)
    try {
      const sessionId = SessionId('failed-initialization-wake')
      const wake = message('queued during discovery')
      let initializing!: Agent
      let releaseCreation!: () => void
      const gate = new Promise<void>((resolve) => { releaseCreation = resolve })
      const { entered, markEntered } = creationEntry()
      const creation = ctx.agents.create({
        sessionId,
        agentOptions: { provider: 'mock', model: 'mock' },
        setup: (_inner, agent) => { initializing = agent },
      })
      const listener = ctx.on('agent/created', async () => {
        markEntered()
        await gate
        throw new Error('creation listener rejected')
      })
      // The serial creation listener is suspended; send a real followup and the
      // user's ordinary stop with the queue kept.
      await entered
      initializing.followup(wake)
      initializing.cancel({ kind: 'user' }, { keepInbox: true })
      releaseCreation()
      await expect(creation).rejects.toThrow('creation listener rejected')
      listener()

      // No dispatch, no claim, and the queue is still readable in memory.
      expect(adapter.requests).toEqual([])
      expect(initializing.session.snapshotEvents().filter(event => event.type === 'turn/start')).toEqual([])
      expect(initializing.session.snapshotEvents().filter(event =>
        event.type === 'agent/inbox/spliced' && event.data.removedCount !== undefined)).toEqual([])
      expect(initializing.inbox.nextTurn.map(entry => entry.id)).toEqual([wake.id])
      // Rollback removed the lifecycle.
      expect(ctx.agents.get(sessionId)).toBeUndefined()
      expect(ctx.sessions.get(sessionId)).toBeUndefined()

      // The released write handle left the pending splice in the real JSONL log.
      const stored = await readStoredEvents(ctx, sessionId)
      expect(stored.filter(event => event.type === 'turn/start')).toEqual([])
      expect(stored.flatMap(event => event.type === 'agent/inbox/spliced'
        ? event.data.inserted.map(inserted => inserted.id)
        : [])).toEqual([wake.id])

      // The next cold resume reads that pending input without dispatching it,
      // and a later real wake runs it in queue order.
      const reopened = await ctx.sessionPersistence.open(sessionId, 'write')
      await reopened.close()
      const resumed = await ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      expect(resumed.agent.inbox.nextTurn.map(entry => entry.id)).toEqual([wake.id])
      expect(adapter.requests).toEqual([])
      resumed.agent.followup(message('later wake'))
      await resumed.agent.whenIdle()
      expect(userTexts(resumed.agent)).toEqual(['queued during discovery', 'later wake'])
      expect(adapter.requests).toHaveLength(2)
      expect(resumed.agent.inbox.nextTurn).toEqual([])
      await resumed.dispose()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('runs the proactive wake latched behind a creation listener that publishes', async () => {
    const adapter = new MockAdapter([textResponse('wake reply')])
    const ctx = await harness(adapter)
    try {
      const sessionId = SessionId('published-initialization-wake')
      const wake = message('queued during discovery')
      let initializing!: Agent
      let releaseCreation!: () => void
      const gate = new Promise<void>((resolve) => { releaseCreation = resolve })
      const { entered, markEntered } = creationEntry()
      const creation = ctx.agents.create({
        sessionId,
        agentOptions: { provider: 'mock', model: 'mock' },
        setup: (_inner, agent) => { initializing = agent },
      })
      const listener = ctx.on('agent/created', async () => {
        markEntered()
        await gate
      })
      await entered
      initializing.followup(wake)
      initializing.cancel({ kind: 'user' }, { keepInbox: true })
      releaseCreation()
      const handle = await creation
      listener()

      // Publication succeeded, so the latched wake opens its own turn.
      expect(ctx.agents.get(sessionId)).toBe(handle.agent)
      await handle.agent.whenIdle()
      expect(userTexts(handle.agent)).toEqual(['queued during discovery'])
      expect(adapter.requests).toHaveLength(1)
      expect(handle.agent.inbox.nextTurn).toEqual([])
      await handle.dispose()
      expect(ctx.agents.get(sessionId)).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('leaves an idle cancellation with nothing to clear a no-op for the next prompt', async () => {
    const ctx = await harness(new MockAdapter([textResponse('later reply')]))
    try {
      const agent = await ctx.agentLoop.create(SessionId('idle-cancel-noop'), { provider: 'mock', model: 'mock' })
      agent.cancel({ kind: 'user' })
      expect(agent.session.snapshotEvents().filter(event => event.type === 'agent/inbox/spliced')).toEqual([])
      agent.followup(message('still runs'))
      await agent.whenIdle()
      expect(userTexts(agent)).toEqual(['still runs'])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
