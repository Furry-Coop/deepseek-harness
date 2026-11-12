/**
 * Native-entry checks for input delivered before a turn admits its first step.
 * Such a wake has no boundary left in that turn, so this turn's `turn/end`
 * closing adopts it only when the first batch entered no step, and only while
 * the exact pending occurrence its delivery inserted still exists.
 * @module dsh-agent-loop/tests/first-step-wake
 */

import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent, type UserMessage } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
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
 * Hold the first pre-step of turn 1 open until the test settles it, and let
 * every later pre-step fall through.
 * @returns the entry and decision resolvers of that held pre-step.
 */
function gateFirstPreStep(ctx: Context, agent: Agent) {
  const entered = Promise.withResolvers<undefined>()
  const decision = Promise.withResolvers<PreStepDecision>()
  ctx.on('agent/pre-step', async ({ agent: subject, turn, step }, next) => {
    if (subject !== agent || turn !== 1 || step !== 1) return await next()
    entered.resolve(undefined)
    return await decision.promise
  })
  return { entered, decision }
}

/** Text of the user messages the loop admitted, in log order. */
function admittedTexts(agent: Agent): string[] {
  return agent.session.snapshotEvents()
    .flatMap(event => event.type === 'user/message'
      ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : [])
      : [])
}

/** Reasons of the durable `turn/end` records, in log order. */
function turnEnds(agent: Agent): unknown[] {
  return agent.session.snapshotEvents()
    .flatMap(event => event.type === 'turn/end' ? [event.data.reason] : [])
}

function turnStarts(agent: Agent): number {
  return agent.session.snapshotEvents().filter(event => event.type === 'turn/start').length
}

/** Visible text one recorded model request carried, in message order. */
function requestText(request: GenerateOptions | undefined): string {
  return (request?.messages ?? [])
    .map(entry => entry.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''))
    .join('\n')
}

function pendingTexts(agent: Agent): string[] {
  return [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
    .flatMap(entry => entry.content.flatMap(block => block.type === 'text' ? [block.text] : []))
}

describe('wakes delivered before the first step is admitted', () => {
  it('opens the following turn for a followup delivered while the batch waits to enter', async () => {
    const adapter = new MockAdapter([textResponse('late reply')])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('late-followup'), { provider: 'mock', model: 'mock' })
      const gate = gateFirstPreStep(ctx, agent)

      agent.followup(message('claimed batch'))
      await gate.entered.promise
      agent.followup(message('late followup'))
      gate.decision.resolve({ kind: 'enter', messages: [] })
      await agent.whenIdle()

      expect(adapter.requests).toHaveLength(1)
      expect(requestText(adapter.requests[0])).toContain('late followup')
      expect(requestText(adapter.requests[0])).not.toContain('claimed batch')
      expect(admittedTexts(agent)).toEqual(['late followup'])
      expect(turnStarts(agent)).toBe(2)
      expect(turnEnds(agent)).toEqual([{ kind: 'completed' }, { kind: 'completed' }])
      expect(agent.inbox.nextTurn).toEqual([])
      expect(agent.inbox.nextStep).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('opens the following turn for steering delivered while the batch waits to enter', async () => {
    const adapter = new MockAdapter([textResponse('late reply')])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('late-steering'), { provider: 'mock', model: 'mock' })
      const gate = gateFirstPreStep(ctx, agent)

      agent.followup(message('claimed batch'))
      await gate.entered.promise
      agent.steer(message('late steering'))
      gate.decision.resolve({ kind: 'enter', messages: [] })
      await agent.whenIdle()

      expect(adapter.requests).toHaveLength(1)
      expect(requestText(adapter.requests[0])).toContain('late steering')
      expect(requestText(adapter.requests[0])).not.toContain('claimed batch')
      expect(admittedTexts(agent)).toEqual(['late steering'])
      expect(turnStarts(agent)).toBe(2)
      expect(agent.inbox.nextStep).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('opens one turn per late followup and keeps their order', async () => {
    const adapter = new MockAdapter([textResponse('first reply'), textResponse('second reply')])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('several-late-followups'), { provider: 'mock', model: 'mock' })
      const gate = gateFirstPreStep(ctx, agent)

      agent.followup(message('claimed batch'))
      await gate.entered.promise
      agent.followup(message('late one'))
      agent.followup(message('late two'))
      gate.decision.resolve({ kind: 'enter', messages: [] })
      await agent.whenIdle()

      expect(adapter.requests).toHaveLength(2)
      expect(requestText(adapter.requests[0])).toContain('late one')
      expect(requestText(adapter.requests[0])).not.toContain('late two')
      expect(requestText(adapter.requests[1])).toContain('late two')
      expect(admittedTexts(agent)).toEqual(['late one', 'late two'])
      expect(turnStarts(agent)).toBe(3)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps passive input pending when no wake arrives before the empty close', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('late-passive-only'), { provider: 'mock', model: 'mock' })
      const gate = gateFirstPreStep(ctx, agent)

      agent.followup(message('claimed batch'))
      await gate.entered.promise
      agent.inject(message('late passive'))
      gate.decision.resolve({ kind: 'enter', messages: [] })
      await agent.whenIdle()

      expect(adapter.requests).toEqual([])
      expect(admittedTexts(agent)).toEqual([])
      expect(turnStarts(agent)).toBe(1)
      expect(turnEnds(agent)).toEqual([{ kind: 'completed' }])
      expect(agent.inbox.nextStep.map(entry => entry.content)).toEqual([[{ type: 'text', text: 'late passive' }]])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('carries the passive input that arrived with the waking one', async () => {
    const adapter = new MockAdapter([textResponse('reply')])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('late-wake-with-passive'), { provider: 'mock', model: 'mock' })
      const gate = gateFirstPreStep(ctx, agent)

      agent.followup(message('claimed batch'))
      await gate.entered.promise
      agent.followup(message('late followup'))
      agent.inject(message('late passive'))
      gate.decision.resolve({ kind: 'enter', messages: [] })
      await agent.whenIdle()

      expect(adapter.requests).toHaveLength(1)
      expect(requestText(adapter.requests[0])).toContain('late followup')
      expect(requestText(adapter.requests[0])).toContain('late passive')
      expect(admittedTexts(agent)).toEqual(['late passive', 'late followup'])
      expect(pendingTexts(agent)).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps a rejected batch parked and does not retry it for a late wake', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('rejected-with-late-wake'), { provider: 'mock', model: 'mock' })
      const gate = gateFirstPreStep(ctx, agent)

      agent.followup(message('claimed batch'))
      await gate.entered.promise
      agent.followup(message('late followup'))
      gate.decision.resolve({ kind: 'reject', preserveClaimed: true })
      await agent.whenIdle()

      expect(adapter.requests).toEqual([])
      expect(admittedTexts(agent)).toEqual([])
      expect(turnStarts(agent)).toBe(1)
      expect(turnEnds(agent)).toEqual([{ kind: 'blocked' }])
      expect(agent.inbox.nextStep.map(entry => entry.content)).toEqual([[{ type: 'text', text: 'claimed batch' }]])
      expect(agent.inbox.nextTurn.map(entry => entry.content)).toEqual([[{ type: 'text', text: 'late followup' }]])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not retry a failed pre-step for a late wake', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('failed-pre-step-late-wake'), { provider: 'mock', model: 'mock' })
      const gate = gateFirstPreStep(ctx, agent)

      agent.followup(message('claimed batch'))
      await gate.entered.promise
      agent.followup(message('late followup'))
      gate.decision.reject(new Error('pre-step failed'))
      await agent.whenIdle()

      expect(adapter.requests).toEqual([])
      expect(admittedTexts(agent)).toEqual([])
      expect(turnStarts(agent)).toBe(1)
      expect(turnEnds(agent)).toEqual([{
        kind: 'error',
        error: { message: 'pre-step failed', code: 'UNKNOWN' },
      }])
      expect(agent.inbox.nextTurn.map(entry => entry.content)).toEqual([[{ type: 'text', text: 'late followup' }]])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not redeem a wake removed before the closing', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('removed-first-step-wake'), { provider: 'mock', model: 'mock' })
      const gate = gateFirstPreStep(ctx, agent)
      const wake = message('late followup')

      agent.followup(message('claimed batch'))
      await gate.entered.promise
      agent.followup(wake)
      agent.inbox.remove(wake.id)
      gate.decision.resolve({ kind: 'enter', messages: [] })
      await agent.whenIdle()

      expect(adapter.requests).toEqual([])
      expect(turnStarts(agent)).toBe(1)
      expect(pendingTexts(agent)).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not redeem a wake reinserted under the same identity as passive input', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('reinserted-first-step-wake'), { provider: 'mock', model: 'mock' })
      const gate = gateFirstPreStep(ctx, agent)
      const wake = message('late followup')

      agent.followup(message('claimed batch'))
      await gate.entered.promise
      agent.followup(wake)
      agent.inbox.remove(wake.id)
      agent.inbox.append('next-turn', wake)
      gate.decision.resolve({ kind: 'enter', messages: [] })
      await agent.whenIdle()

      expect(adapter.requests).toEqual([])
      expect(turnStarts(agent)).toBe(1)
      expect(agent.inbox.nextTurn.map(entry => entry.id)).toEqual([wake.id])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('lets a cancellation remove the recorded wake and opens no turn', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('cancelled-first-step-wake'), { provider: 'mock', model: 'mock' })
      const gate = gateFirstPreStep(ctx, agent)

      agent.followup(message('claimed batch'))
      await gate.entered.promise
      agent.followup(message('late followup'))
      agent.cancel({ kind: 'user' })
      gate.decision.resolve({ kind: 'enter', messages: [] })
      await agent.whenIdle()

      expect(adapter.requests).toEqual([])
      expect(turnStarts(agent)).toBe(1)
      expect(turnEnds(agent)).toEqual([{ kind: 'aborted', reason: { kind: 'user' } }])
      expect(pendingTexts(agent)).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('redeems a wake delivered after the closing turn/end', async () => {
    const adapter = new MockAdapter([textResponse('late reply')])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('wake-after-turn-end'), { provider: 'mock', model: 'mock' })
      const gate = gateFirstPreStep(ctx, agent)
      const stop = ctx.on('session/event', (session, event) => {
        if (session !== agent.session || event.type !== 'turn/end' || event.data.turn !== 1) return
        // The log refuses a reentrant append, so a closing observer reacts on
        // the next microtask, still before the driver's convergence.
        queueMicrotask(() => { agent.followup(message('after closing')) })
      })

      agent.followup(message('claimed batch'))
      await gate.entered.promise
      gate.decision.resolve({ kind: 'enter', messages: [] })
      await agent.whenIdle()
      stop()

      expect(adapter.requests).toHaveLength(1)
      expect(requestText(adapter.requests[0])).toContain('after closing')
      expect(requestText(adapter.requests[0])).not.toContain('claimed batch')
      expect(admittedTexts(agent)).toEqual(['after closing'])
      expect(turnStarts(agent)).toBe(2)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps a later step empty batch and the steering it consumed as before', async () => {
    const adapter = new MockAdapter([textResponse('first reply')])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('later-step-empty-batch'), { provider: 'mock', model: 'mock' })
      let steered = false
      ctx.on('agent/request', (_payload, next) => {
        if (!steered) {
          steered = true
          agent.steer(message('mid-step steering'))
        }
        return next()
      })
      ctx.on('agent/pre-step', ({ turn, step }, next) => turn === 1 && step === 2
        ? Promise.resolve({ kind: 'enter', messages: [] })
        : next())

      agent.followup(message('go'))
      await agent.whenIdle()

      expect(adapter.requests).toHaveLength(1)
      expect(admittedTexts(agent)).toEqual(['go'])
      expect(turnStarts(agent)).toBe(1)
      expect(turnEnds(agent)).toEqual([{ kind: 'completed' }])
      expect(pendingTexts(agent)).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps an ordinary non-empty first batch and its late wake as before', async () => {
    const adapter = new MockAdapter([textResponse('first reply'), textResponse('late reply')])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('nonempty-first-batch'), { provider: 'mock', model: 'mock' })
      const entered = Promise.withResolvers<undefined>()
      const decision = Promise.withResolvers<undefined>()
      ctx.on('agent/pre-step', async ({ agent: subject, turn, step, messages }, next) => {
        if (subject !== agent || turn !== 1 || step !== 1) return await next()
        entered.resolve(undefined)
        await decision.promise
        return { kind: 'enter', messages }
      })

      agent.followup(message('go'))
      await entered.promise
      agent.followup(message('late followup'))
      decision.resolve(undefined)
      await agent.whenIdle()

      expect(adapter.requests).toHaveLength(2)
      expect(requestText(adapter.requests[0])).toContain('go')
      expect(requestText(adapter.requests[1])).toContain('late followup')
      expect(admittedTexts(agent)).toEqual(['go', 'late followup'])
      expect(pendingTexts(agent)).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('the closing fact owns the redemption', () => {
  it('does not redeem a recorded wake when the closing turn/end is rejected', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('rejected-turn-end'), { provider: 'mock', model: 'mock' })
      const gate = gateFirstPreStep(ctx, agent)
      const errors: unknown[] = []
      ctx.on('agent/error', ({ error }) => { errors.push(error) })
      let injections = 0
      let vetoed = false
      ctx.on('internal/dispatch', (_mode, name, args) => {
        if (name !== 'session/event' || vetoed) return
        const event = args[1] as SessionEvent
        if (event.type !== 'turn/end') return
        vetoed = true
        injections += 1
        throw new Error('reject turn end')
      })

      agent.followup(message('claimed batch'))
      await gate.entered.promise
      agent.followup(message('late followup'))
      gate.decision.resolve({ kind: 'enter', messages: [] })
      await agent.whenIdle()

      // The injected failure really fired on the closing event.
      expect(injections).toBe(1)
      expect(errors.some(error => error instanceof Error && error.message === 'reject turn end')).toBe(true)
      expect(adapter.requests).toEqual([])
      expect(turnStarts(agent)).toBe(1)
      expect(pendingTexts(agent)).toEqual(['late followup'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('starts no turn when the idle notification disposes the agent with keepInbox', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('disposed-from-idle'), { provider: 'mock', model: 'mock' })
      const gate = gateFirstPreStep(ctx, agent)
      const stop = ctx.on('agent/status', ({ agent: subject, status }) => {
        if (subject !== agent || status !== 'idle' || returned) return
        returned = true
        agent.cancel({ kind: 'disposed' }, { keepInbox: true })
      })
      let returned = false

      agent.followup(message('claimed batch'))
      await gate.entered.promise
      agent.followup(message('late followup'))
      gate.decision.resolve({ kind: 'enter', messages: [] })
      await agent.whenIdle()
      stop()

      expect(returned).toBe(true)
      expect(adapter.requests).toEqual([])
      expect(turnStarts(agent)).toBe(1)
      expect(turnEnds(agent)).toEqual([{ kind: 'completed' }])
      expect(pendingTexts(agent)).toEqual(['late followup'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps the redeemed wake when the idle notification starts maintenance', async () => {
    const adapter = new MockAdapter([textResponse('late reply')])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('maintenance-from-idle'), { provider: 'mock', model: 'mock' })
      const gate = gateFirstPreStep(ctx, agent)
      const held = Promise.withResolvers<undefined>()
      let maintenance: Promise<unknown> | undefined
      const stop = ctx.on('agent/status', ({ agent: subject, status }) => {
        if (subject !== agent || status !== 'idle' || maintenance !== undefined) return
        maintenance = agent.runMaintenance(async () => { await held.promise })
      })

      agent.followup(message('claimed batch'))
      await gate.entered.promise
      agent.followup(message('late followup'))
      gate.decision.resolve({ kind: 'enter', messages: [] })
      await Promise.resolve()
      held.resolve(undefined)
      await agent.whenIdle()
      stop()
      await maintenance

      expect(adapter.requests).toHaveLength(1)
      expect(requestText(adapter.requests[0])).toContain('late followup')
      expect(admittedTexts(agent)).toEqual(['late followup'])
      expect(pendingTexts(agent)).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('lets an ordinary idle wake and its own cancellation consume the queue', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('idle-wake-then-cancel'), { provider: 'mock', model: 'mock' })
      const gate = gateFirstPreStep(ctx, agent)
      const stop = ctx.on('agent/status', ({ agent: subject, status }) => {
        if (subject !== agent || status !== 'idle' || returned) return
        returned = true
        agent.followup(message('from idle listener'))
        agent.cancel({ kind: 'user' })
      })
      let returned = false

      agent.followup(message('claimed batch'))
      await gate.entered.promise
      agent.followup(message('late followup'))
      gate.decision.resolve({ kind: 'enter', messages: [] })
      await agent.whenIdle()
      stop()

      expect(returned).toBe(true)
      expect(adapter.requests).toEqual([])
      expect(turnEnds(agent)).toEqual([{ kind: 'completed' }, { kind: 'aborted', reason: { kind: 'user' } }])
      expect(pendingTexts(agent)).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
