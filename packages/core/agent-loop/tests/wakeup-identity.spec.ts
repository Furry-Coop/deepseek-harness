/**
 * Native-entry checks for a latched wakeup's single-insertion identity: a
 * wakeup latched on an aborted driver is redeemed only while the exact pending
 * occurrence that produced it still exists.
 * @module dsh-agent-loop/tests/wakeup-identity
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, textResponse } from './mock-adapter.ts'

async function harness(adapter: MockAdapter) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function message(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/**
 * Cancel the first streaming turn and run `duringAbort` once from the turn's
 * own abort listener, where `followup` latches the wake on the aborted driver.
 * @returns a disposer for both listeners.
 */
function cancelOnFirstChunk(ctx: Context, agent: Agent, duringAbort: () => void): () => void {
  let cancelling = false
  const stopRequest = ctx.on('agent/request', ({ signal }, next) => {
    signal.addEventListener('abort', () => {
      duringAbort()
    }, { once: true })
    return next()
  })
  const stopStream = ctx.on('agent/assistant-stream', ({ frame }) => {
    if (cancelling || frame.type !== 'chunk') return
    cancelling = true
    agent.cancel({ kind: 'user' })
  })
  return () => {
    stopStream()
    stopRequest()
  }
}

function userTexts(agent: Agent): string[] {
  return agent.session.snapshotEvents()
    .filter(event => event.type === 'user/message')
    .flatMap(event => event.type === 'user/message' ? event.data.content : [])
    .flatMap(block => block.type === 'text' ? [block.text] : [])
}

describe('latched wakeup identity', () => {
  it('does not redeem a removed latched wake for the passive input it leaves behind', async () => {
    const adapter = new MockAdapter(['hang', textResponse('passive ran')])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('removed-latched-wake'), { provider: 'mock', model: 'mock' })
      const wake = message('wake')
      const passive = message('passive')
      const stop = cancelOnFirstChunk(ctx, agent, () => {
        agent.followup(wake)
        agent.inbox.remove(wake.id)
        agent.inject(passive)
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      stop()

      expect(adapter.requests).toHaveLength(1)
      expect(agent.inbox.nextTurn).toEqual([])
      expect(agent.inbox.nextStep.map(entry => entry.id)).toEqual([passive.id])
      expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not redeem a latched wake reinserted under the same identity as passive input', async () => {
    const adapter = new MockAdapter(['hang', textResponse('reinserted ran')])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('reinserted-latched-wake'), { provider: 'mock', model: 'mock' })
      const wake = message('wake')
      const stop = cancelOnFirstChunk(ctx, agent, () => {
        agent.followup(wake)
        agent.inbox.remove(wake.id)
        agent.inbox.append('next-turn', wake)
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      stop()

      expect(adapter.requests).toHaveLength(1)
      expect(agent.inbox.nextTurn.map(entry => entry.id)).toEqual([wake.id])
      expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('latches no wake for an occurrence removed during its own insertion', async () => {
    const adapter = new MockAdapter(['hang', textResponse('unused')])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('withdrawn-latched-wake'), { provider: 'mock', model: 'mock' })
      const wake = message('wake')
      const stopRemoval = ctx.on('agent/inbox/inserted', ({ message: inserted }) => {
        if (inserted.id === wake.id) agent.inbox.remove(inserted.id)
      })
      const stop = cancelOnFirstChunk(ctx, agent, () => {
        agent.followup(wake)
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      stop()
      stopRemoval()

      expect(adapter.requests).toHaveLength(1)
      expect([...agent.inbox.nextTurn, ...agent.inbox.nextStep]).toEqual([])
      expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('redeems a later real wake that arrives after the latched wake was removed', async () => {
    const adapter = new MockAdapter(['hang', textResponse('late wake ran')])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('later-latched-wake'), { provider: 'mock', model: 'mock' })
      const wake = message('wake')
      const passive = message('passive')
      const late = message('late')
      const stop = cancelOnFirstChunk(ctx, agent, () => {
        agent.followup(wake)
        agent.inbox.remove(wake.id)
        agent.inject(passive)
        agent.followup(late)
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      stop()

      expect(adapter.requests).toHaveLength(2)
      expect(userTexts(agent)).toEqual(['go', 'passive', 'late'])
      expect([...agent.inbox.nextTurn, ...agent.inbox.nextStep]).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('starts no turn for a wake latched while the agent is disposed', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    try {
      const handle = await ctx.agents.create({
        sessionId: SessionId('disposed-latched-wake'),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      const agent = handle.agent
      const oldStep = message('old step')
      const later = message('later')
      agent.inject(oldStep)
      const stop = ctx.on('agent/inbox/discarded', ({ message: discarded }) => {
        if (discarded.id === oldStep.id) agent.followup(later)
      })
      await handle.dispose()
      stop()

      expect(adapter.requests).toHaveLength(0)
      expect(agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
      expect(agent.inbox.nextTurn.map(entry => entry.id)).toEqual([later.id])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not redeem several removed latched wakes for the passive input they leave behind', async () => {
    const adapter = new MockAdapter(['hang', textResponse('passive ran')])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('several-latched-wakes'), { provider: 'mock', model: 'mock' })
      const first = message('first wake')
      const second = message('second wake')
      const passive = message('passive')
      const stop = cancelOnFirstChunk(ctx, agent, () => {
        agent.followup(first)
        agent.followup(second)
        agent.inbox.remove(first.id)
        agent.inbox.remove(second.id)
        agent.inject(passive)
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      stop()

      expect(adapter.requests).toHaveLength(1)
      expect(agent.inbox.nextTurn).toEqual([])
      expect(agent.inbox.nextStep.map(entry => entry.id)).toEqual([passive.id])
      expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not redeem a removed steering wake latched behind maintenance', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('steering-latched-wake'), { provider: 'mock', model: 'mock' })
      const started = Promise.withResolvers<undefined>()
      const finish = Promise.withResolvers<undefined>()
      const maintenance = agent.runMaintenance(async () => {
        started.resolve(undefined)
        await finish.promise
      })
      await started.promise
      const wake = message('steering wake')
      const passive = message('passive')
      agent.steer(wake)
      agent.inbox.remove(wake.id)
      agent.inject(passive)
      finish.resolve(undefined)
      await maintenance
      await agent.whenIdle()

      expect(adapter.requests).toHaveLength(0)
      expect(agent.inbox.nextTurn).toEqual([])
      expect(agent.inbox.nextStep.map(entry => entry.id)).toEqual([passive.id])
      expect(agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
