import { ToolCallId, createUserMessage, expandAssistantStream, freezeMessage } from '@deepseek-ai/dsh-llm'
/**
 * Tests for the queue-aware `Agent.cancel()` primitive. The default clears
 * queued and steering work, while `keepInbox` preserves pending input for a
 * later wake after the active turn reaches quiescence. The suite
 * covers every landing window plus signal reset, `whenIdle()` quiescence, and
 * the cause each cancelled turn records.
 * @module dsh-agent-loop/tests/cancel
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, SessionLogOffset, TurnEndReason, type UserMessage } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture, TOOL_ABORTED_BEFORE_DISPATCH } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent, type AgentCancelCause } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'
import type { ReactLoopInbox } from '../src/inbox.ts'

function driverDone(agent: Agent): Promise<void> {
  return (agent as Agent & { done: Promise<void> }).done
}

async function harness(adapter: MockAdapter) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function send(agent: Agent, text: string) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

/** Resolve on the agent's next idle transition (event-based, not status poll). */
function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

/** All user-message texts recorded in the log (to assert what actually ran). */
function userTexts(agent: Agent): string[] {
  return agent.session.snapshotEvents()
    .filter(e => e.type === 'user/message')
    .flatMap(e => e.type === 'user/message' ? e.data.content : [])
    .flatMap(b => b.type === 'text' ? [b.text] : [])
}

describe('Agent.cancel()', () => {
  /**
   * Cancel one turn, let `mutate` alter the caller's cause the way a transport
   * does once it observes the abort, then report every recorded turn ending.
   */
  async function endingsAfterMutatingCancel(
    cause: AgentCancelCause,
    mutate: (cause: AgentCancelCause) => void,
  ): Promise<{ endings: TurnEndReason[]; errors: unknown[]; requests: number }> {
    const adapter = new MockAdapter([textResponse('next turn')])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('cancel-mutated-cause'), { provider: 'mock', model: 'mock' })
      const errors: unknown[] = []
      ctx.on('agent/error', ({ error }) => { errors.push(error) })
      ctx.on('agent/request', ({ signal, turn }, next) => {
        if (turn === 1) {
          signal.addEventListener('abort', () => { mutate(cause) }, { once: true })
          agent.cancel(cause)
        }
        return next()
      })

      send(agent, 'cancel this turn')
      await agent.whenIdle()
      // A second turn proves the cancelled one closed: an unclosed turn would
      // make the next `turn/start` fail the session's turn-bracket invariant.
      send(agent, 'continue')
      await agent.whenIdle()

      return {
        endings: agent.session.snapshotEvents()
          .flatMap(event => event.type === 'turn/end' ? [event.data.reason] : []),
        errors,
        requests: adapter.requests.length,
      }
    } finally {
      await ctx.fiber.dispose()
    }
  }

  /**
   * Node's fetch assigns an enumerable `stack` string onto the abort reason it
   * receives (`node:internal/deps/undici`), which a plain assignment reproduces.
   */
  function assignTransportStack(cause: AgentCancelCause): void {
    Object.defineProperty(cause, 'stack', {
      value: 'Error\n    at node:internal/deps/undici/undici',
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }

  /** Add an own property JSON discards, the descriptor `Error.captureStackTrace` produces. */
  function captureNonEnumerableStack(cause: AgentCancelCause): void {
    Error.captureStackTrace(cause)
  }

  it.each<AgentCancelCause>([
    { kind: 'user' },
    { kind: 'parent' },
    { kind: 'hook', reason: 'policy stopped this turn' },
    { kind: 'disposed' },
  ])('records $kind cancellation without the stack a transport assigned to the abort reason', async (cause) => {
    const expectedCause = { ...cause }

    const { endings, errors, requests } = await endingsAfterMutatingCancel(cause, assignTransportStack)

    expect(Object.getOwnPropertyDescriptor(cause, 'stack')?.enumerable).toBe(true)
    expect(errors).toEqual([])
    expect(endings).toEqual([{ kind: 'aborted', reason: expectedCause }, { kind: 'completed' }])
    expect(requests).toBe(1)
  })

  it('closes a cancelled turn whose abort reason acquired an own property JSON discards', async () => {
    const cause: AgentCancelCause = { kind: 'user' }

    // `Session.append` rejects a payload JSON cannot hold rather than logging a
    // lossy ending, so the caller's object must not reach the log by reference.
    const { endings, errors } = await endingsAfterMutatingCancel(cause, captureNonEnumerableStack)

    expect(Object.getOwnPropertyDescriptor(cause, 'stack')?.enumerable).toBe(false)
    expect(errors).toEqual([])
    expect(endings).toEqual([{ kind: 'aborted', reason: { kind: 'user' } }, { kind: 'completed' }])
  })

  it('cancel() on an idle agent with nothing queued is a no-op; the next prompt runs (F2 leak guard)', async () => {
    const adapter = new MockAdapter([textResponse('reply')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    // The loop is parked at the idle wait with nothing queued. A cancel here must
    // NOT arm the marker — otherwise the next legitimate prompt would be dropped.
    agent.cancel({ kind: 'user' })

    send(agent, 'real prompt')
    await waitForIdle(ctx, agent)

    // The prompt ran: its user message is in the log and one turn completed.
    expect(userTexts(agent)).toEqual(['real prompt'])
    expect(agent.session.snapshotEvents().some(e => e.type === 'turn/end')).toBe(true)
  })

  it('cancel({ keepInbox: true }) does not restore work already claimed by a waking send', async () => {
    const adapter = new MockAdapter([textResponse('wake reply')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'preserved' }],
      source: { kind: 'user' },
    }))
    // A waking send starts and claims synchronously, so keepInbox has no
    // pending item to preserve by the time this cancellation runs.
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    expect(agent.session.snapshotEvents().some(event =>
      event.type === 'agent/inbox/spliced' && event.data.outcome === 'canceled')).toBe(false)
    await agent.whenIdle()
    expect(agent.inbox.nextTurn).toHaveLength(0)
    expect(userTexts(agent)).toEqual([])
    expect(adapter.requests).toHaveLength(0)
    expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason)
      .toEqual({ kind: 'aborted', reason: { kind: 'user' } })

    const idle = waitForIdle(ctx, agent)
    send(agent, 'wake it')
    await idle
    expect(userTexts(agent)).toEqual(['wake it'])
    expect(adapter.requests).toHaveLength(1)
  })

  it('cancel({ keepInbox: true }) parks queued work after an active turn aborts', async () => {
    const adapter = new MockAdapter([
      'hang',
      textResponse('preserved reply'),
      textResponse('wake reply'),
    ])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('keep-after-abort'), { provider: 'mock', model: 'mock' })

    send(agent, 'active')
    await new Promise(resolve => setTimeout(resolve, 30))
    send(agent, 'preserved')
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    await agent.whenIdle()

    expect(userTexts(agent)).toEqual(['active'])
    expect(agent.inbox.nextTurn).toHaveLength(1)
    expect(adapter.requests).toHaveLength(1)

    const idle = waitForIdle(ctx, agent)
    send(agent, 'wake it')
    await idle
    expect(userTexts(agent)).toEqual(['active', 'preserved', 'wake it'])
    expect(adapter.requests).toHaveLength(3)
  })

  it('cancel({ keepInbox: true }) latches a waking send landing in the abort-to-idle window', async () => {
    const adapter = new MockAdapter(['hang', textResponse('B reply')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('latch-window'), { provider: 'mock', model: 'mock' })

    send(agent, 'active')
    await new Promise(resolve => setTimeout(resolve, 30))

    // The abort signal is set but the driver has not converged to idle yet:
    // the waking send must be latched, not parked until another wake.
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    send(agent, 'B')

    await agent.whenIdle()

    expect(userTexts(agent)).toEqual(['active', 'B'])
    expect(adapter.requests).toHaveLength(2)
    expect(agent.inbox.nextTurn).toHaveLength(0)
    expect(agent.session.snapshotEvents().filter(e => e.type === 'turn/end').map(e =>
      e.type === 'turn/end' ? e.data.reason : null)).toEqual([
      { kind: 'aborted', reason: { kind: 'user' } },
      { kind: 'completed' },
    ])
  })

  it('cancel() without keepInbox clears a latched wake alongside the inbox', async () => {
    const adapter = new MockAdapter(['hang', textResponse('C reply')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('latch-cleared'), { provider: 'mock', model: 'mock' })

    send(agent, 'active')
    await new Promise(resolve => setTimeout(resolve, 30))
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    send(agent, 'B') // latched behind the aborted activity
    agent.cancel({ kind: 'user' }) // drops the inbox and the latch with it
    await agent.whenIdle()

    expect(userTexts(agent)).toEqual(['active'])
    expect(agent.inbox.nextTurn).toHaveLength(0)
    expect(adapter.requests).toHaveLength(1)

    send(agent, 'C')
    await agent.whenIdle()
    expect(userTexts(agent)).toEqual(['active', 'C'])
    expect(adapter.requests).toHaveLength(2)
  })

  it('removing the latched wake before convergence suppresses the replay', async () => {
    const adapter = new MockAdapter(['hang'])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('removed-latched-wake'), { provider: 'mock', model: 'mock' })

    send(agent, 'active')
    await new Promise(resolve => setTimeout(resolve, 30))

    agent.cancel({ kind: 'user' }, { keepInbox: true })
    const steer = createUserMessage({ content: [{ type: 'text', text: 'steer me' }], source: { kind: 'user' } })
    agent.steer(steer) // latched behind the aborted activity
    agent.inbox.remove(steer.id) // the wake is retracted before convergence

    await agent.whenIdle()

    expect(userTexts(agent)).toEqual(['active'])
    expect(adapter.requests).toHaveLength(1)
    expect(agent.inbox.nextTurn).toHaveLength(0)
    expect(agent.status).toBe('idle')
    // No replay with nothing to run: the latched message is gone, so no
    // empty follow-up turn is recorded.
    expect(agent.session.snapshotEvents().filter(e => e.type === 'turn/start')).toHaveLength(1)
  })

  it('latches a wake arriving deep into a slow abort convergence', async () => {
    // The stream notices the abort only after 50ms, so the driver stays in
    // the abort-to-idle window long after `cancel()` returned: the wake must
    // be latched across the whole window, not just the same-tick case.
    const adapter = new MockAdapter(['hang-slow', textResponse('B reply')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('slow-convergence'), { provider: 'mock', model: 'mock' })

    send(agent, 'A')
    await new Promise(resolve => setTimeout(resolve, 30))

    agent.cancel({ kind: 'user' }, { keepInbox: true })
    await new Promise(resolve => setTimeout(resolve, 10))
    send(agent, 'B')

    await agent.whenIdle()
    expect(userTexts(agent)).toEqual(['A', 'B'])
    expect(adapter.requests).toHaveLength(2)
    expect(agent.inbox.nextTurn).toHaveLength(0)
  })

  it('does not latch a wake landing after disposal begins', async () => {
    const adapter = new MockAdapter(['hang-slow', textResponse('late reply')])
    const ctx = await harness(adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('dispose-window-wake'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const agent = handle.agent

    send(agent, 'active')
    await new Promise(resolve => setTimeout(resolve, 30))

    // Dispose cancels with `{ kind: 'disposed' }`; a wake landing in the
    // abort-to-idle window must not latch, so `whenIdle()` does not wait on
    // a model turn over the session being torn down.
    const disposal = handle.dispose()
    setTimeout(() => { send(agent, 'late wake') }, 10)
    await disposal

    expect(adapter.requests).toHaveLength(1)
    expect(userTexts(agent)).toEqual(['active'])
  })

  it('cancel after waking send closes its synchronously opened turn without a step', async () => {
    const adapter = new MockAdapter([textResponse('should not run')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    send(agent, 'drop me first')
    send(agent, 'drop me second')
    agent.cancel({ kind: 'user' })

    await new Promise(r => setTimeout(r, 30))

    expect(userTexts(agent)).toEqual([])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'step/start')).toHaveLength(0)
    expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason)
      .toEqual({ kind: 'aborted', reason: { kind: 'user' } })
    expect(agent.status).toBe('idle')
  })

  it('disposal from the running notification drops queued work before turn start', async () => {
    const adapter = new MockAdapter([textResponse('should not run')])
    const ctx = await harness(adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('dispose-running-session'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const agent = handle.agent

    const running = Promise.withResolvers<undefined>()
    let disposalDone: Promise<void> | undefined
    ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== agent || status !== 'running') return
      disposalDone = handle.dispose()
      running.resolve(undefined)
    })

    send(agent, 'drop before claim')
    await running.promise
    if (disposalDone === undefined) throw new Error('running listener did not start disposal')
    await disposalDone
    await driverDone(agent)

    expect(agent.status).toBe('idle')
    expect(agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
    expect(userTexts(agent)).toEqual([])
    expect(adapter.requests).toHaveLength(0)
  })

  it('a whenIdle() waiter registered BEFORE a pre-step cancel resolves (F1 hang guard)', async () => {
    const adapter = new MockAdapter([textResponse('x')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    // This waiter cannot rely on a running→idle transition because cancellation
    // drops the turn before it runs; the skip path must settle it directly.
    send(agent, 'q')
    const idle = agent.whenIdle()
    agent.cancel({ kind: 'user' })

    // Must resolve (not hang). A timeout makes the failure a clear test failure.
    await Promise.race([
      idle,
      new Promise((_r, reject) => setTimeout(() => { reject(new Error('whenIdle hung after pre-step cancel')) }, 1000)),
    ])
    expect(agent.status).toBe('idle')
  })

  it('idle-listener cancellation settles its waiter without cancelling later work', async () => {
    const adapter = new MockAdapter([textResponse('first reply'), textResponse('later reply')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('idle-listener-cancel'), { provider: 'mock', model: 'mock' })

    const replacementRegistered = Promise.withResolvers<undefined>()
    let replacementObservation: Promise<{ status: string; requests: number; turns: number }> | undefined
    ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== agent || status !== 'idle' || replacementObservation !== undefined) return
      send(agent, 'cancelled replacement')
      replacementObservation = agent.whenIdle().then(() => ({
        status: agent.status,
        requests: adapter.requests.length,
        turns: agent.session.snapshotEvents().filter(event => event.type === 'turn/start').length,
      }))
      agent.cancel({ kind: 'user' })
      replacementRegistered.resolve(undefined)
    })

    send(agent, 'first')
    await replacementRegistered.promise
    if (replacementObservation === undefined) throw new Error('idle listener did not register replacement work')

    await expect(Promise.race([
      replacementObservation,
      new Promise((_resolve, reject) => setTimeout(() => { reject(new Error('whenIdle hung after idle-listener cancel')) }, 1000)),
    ])).resolves.toEqual({ status: 'idle', requests: 1, turns: 2 })

    const idle = waitForIdle(ctx, agent)
    send(agent, 'later')
    await idle
    expect(adapter.requests).toHaveLength(2)
    expect(userTexts(agent)).toEqual(['first', 'later'])
  })

  it('replacement work queued after idle-listener cancellation replays at convergence', async () => {
    const adapter = new MockAdapter([
      textResponse('first reply'),
      textResponse('replacement reply'),
      textResponse('wake reply'),
    ])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('idle-listener-post-cancel-send'), { provider: 'mock', model: 'mock' })

    const replacementRegistered = Promise.withResolvers<undefined>()
    let replacementIdle: Promise<void> | undefined
    ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== agent || status !== 'idle' || replacementIdle !== undefined) return
      send(agent, 'cancelled replacement')
      agent.cancel({ kind: 'user' })
      send(agent, 'surviving replacement')
      replacementIdle = agent.whenIdle()
      replacementRegistered.resolve(undefined)
    })

    send(agent, 'first')
    await replacementRegistered.promise
    if (replacementIdle === undefined) throw new Error('idle listener did not register replacement work')
    await replacementIdle

    // The wake sent after the cancel fired is latched: the surviving
    // replacement runs at convergence without a third message.
    expect(adapter.requests).toHaveLength(2)
    expect(userTexts(agent)).toEqual(['first', 'surviving replacement'])
    expect(agent.inbox.nextTurn).toHaveLength(0)

    const idle = waitForIdle(ctx, agent)
    send(agent, 'wake it')
    await idle
    expect(adapter.requests).toHaveLength(3)
    expect(userTexts(agent)).toEqual(['first', 'surviving replacement', 'wake it'])
  })

  it('cancel() mid-step aborts the active turn and drops every queued tail item', async () => {
    const adapter = new MockAdapter(['hang'])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    await new Promise(r => setTimeout(r, 30))
    expect(agent.status).toBe('running')
    send(agent, 'queued tail')
    agent.cancel({ kind: 'user' })
    await waitForIdle(ctx, agent)

    expect(reasons).toEqual([{ kind: 'aborted', reason: { kind: 'user' } }])
    expect(userTexts(agent)).toEqual(['go'])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(adapter.requests).toHaveLength(1)
  })

  it('cancel from an assistant/message observer skips execution but balances replay', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'danger', {}),
      textResponse('recovered after cancellation'),
    ])
    const ctx = await harness(adapter)
    let executions = 0
    ctx.tools.register(defineContentToolFixture({
      name: 'danger',
      description: 'must not run after cancellation',
      parameters: {},
      async execute() {
        executions += 1
        return [{ type: 'text', text: 'ran' }]
      },
    }))
    const agent = await ctx.agentLoop.create(SessionId('cancel-after-assistant-message'), { provider: 'mock', model: 'mock' })
    const dispose = ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'assistant/message') {
        agent.cancel({ kind: 'user' })
      }
    })

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_session, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    await waitForIdle(ctx, agent)
    dispose()

    expect(executions).toBe(0)
    expect(reasons).toEqual([{ kind: 'aborted', reason: { kind: 'user' } }])
    const call = agent.session.snapshotEvents().find(event => event.type === 'tool/call')
    const result = agent.session.snapshotEvents().find(event => event.type === 'tool/result')
    expect(call?.type === 'tool/call' ? call.data.callId : undefined).toBe('c1')
    expect(result?.type === 'tool/result' ? result.data : undefined).toMatchObject({
      message: {
        role: 'tool',
        source: { kind: 'tool', callId: 'c1' },
        content: [{ type: 'text' }],
        isError: true,
      },
      error: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH },
    })

    send(agent, 'continue safely')
    await waitForIdle(ctx, agent)
    const replayedResult = adapter.requests[1]!.messages.find(message => message.role === 'tool')
    expect(replayedResult).toMatchObject({ toolCallId: 'c1', isError: true })
    expect(reasons).toEqual([
      { kind: 'aborted', reason: { kind: 'user' } },
      { kind: 'completed' },
    ])
  })

  it('a prompt sent AFTER a cancelled turn settles runs normally (marker reset)', async () => {
    const adapter = new MockAdapter(['hang', textResponse('second reply')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    // First turn hangs; cancel it mid-step.
    send(agent, 'first')
    await new Promise(r => setTimeout(r, 30))
    agent.cancel({ kind: 'user' })
    await waitForIdle(ctx, agent)

    // The marker must have been reset after the cancelled turn — a fresh prompt
    // runs to completion rather than being dropped by a stale marker.
    send(agent, 'second')
    await waitForIdle(ctx, agent)

    expect(userTexts(agent)).toContain('second')
    // The second turn completed (its reply was streamed).
    const reasons = agent.session.snapshotEvents().filter(e => e.type === 'turn/end')
    expect(reasons.length).toBe(2)
  })

  it('cancel mid-stream finalizes the streamed prefix onto the surface', async () => {
    const adapter = new MockAdapter(['hang', textResponse('after')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('partial-finalize'), { provider: 'mock', model: 'mock' })

    send(agent, 'go')
    await new Promise(r => setTimeout(r, 30))
    agent.cancel({ kind: 'user' })
    await waitForIdle(ctx, agent)

    // The prefix the user watched stream is committed as the step's message,
    // carrying the truncation marker and exact embedded stream that delivered it.
    const message = agent.session.snapshotEvents().find(e => e.type === 'assistant/message')
    expect(message?.type === 'assistant/message' ? message.data.message.content : undefined)
      .toEqual([{ type: 'text', text: 'partial' }])
    expect(message?.type === 'assistant/message' ? message.data.interrupted : undefined).toBe(true)
    expect(message?.type === 'assistant/message'
      ? expandAssistantStream(message.data.stream).some(member => (
        member.chunk.type === 'text-delta' && member.chunk.text === 'partial'
      ))
      : false).toBe(true)
    expect(message?.sourceEventSeqs).toBeUndefined()
    const types = agent.session.snapshotEvents().map(e => e.type)
    expect(types.indexOf('assistant/message')).toBeLessThan(types.indexOf('step/end'))
    expect(types.indexOf('step/end')).toBeLessThan(types.indexOf('turn/end'))

    // The next request derives the finalized prefix: the model sees what the user saw.
    send(agent, 'continue')
    await waitForIdle(ctx, agent)
    const replayed = adapter.requests[1]!.messages
      .filter(m => m.role === 'assistant')
      .flatMap(m => m.content)
      .flatMap(b => b.type === 'text' ? [b.text] : [])
    expect(replayed).toContain('partial')
  })

  it('retains terminal replay state when cancellation races the final stream chunk', async () => {
    const response = textResponse('complete')
    const replayState = { response: { id: 'response' }, blocks: ['text-meta'] }
    response[response.length - 1] = {
      type: 'finish', reason: { kind: 'stop' }, replayState,
    }
    const adapter = new MockAdapter([response])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('terminal-cancel-replay'), {
      provider: 'mock', model: 'mock',
    })
    ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
      if (subject === agent && frame.type === 'chunk' && frame.chunk.type === 'finish') {
        agent.cancel({ kind: 'user' })
      }
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    const message = agent.session.snapshotEvents().find(event => event.type === 'assistant/message')
    expect(message?.type === 'assistant/message' ? message.data.message.source.replayState : undefined)
      .toEqual(replayState)
    expect(message?.type === 'assistant/message' ? message.data.interrupted : undefined).toBe(true)
    expect(() => Session.fromRestore(
      agent.session.id,
      structuredClone([...agent.session.snapshotEvents()]),
      structuredClone(agent.session.header),
      SessionLogOffset(0),
      'detached',
    )).not.toThrow()
  })

  it('cancel during reasoning-only streaming finalizes the reasoning prefix', async () => {
    const adapter = new MockAdapter([{
      hangAfter: [
        { type: 'block-start', index: 0, blockType: 'reasoning' },
        { type: 'reasoning-delta', index: 0, text: 'thinking about it' },
        { type: 'usage', usage: { inputTokens: 7, outputTokens: 4 } },
      ],
    }])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('reasoning-finalize'), { provider: 'mock', model: 'mock' })

    send(agent, 'go')
    await new Promise(r => setTimeout(r, 30))
    agent.cancel({ kind: 'user' })
    await waitForIdle(ctx, agent)

    const message = agent.session.snapshotEvents().find(e => e.type === 'assistant/message')
    expect(message?.type === 'assistant/message' ? message.data.message.content : undefined)
      .toEqual([{ type: 'reasoning', text: 'thinking about it' }])
    // A usage chunk delivered before the cancel travels with the finalized prefix.
    expect(message?.type === 'assistant/message' ? message.data.usage : undefined)
      .toEqual({ inputTokens: 7, outputTokens: 4 })
  })

  it('cancel drops a half-streamed tool call and keeps the completed text before it', async () => {
    const adapter = new MockAdapter([{
      hangAfter: [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'reading the file' },
        { type: 'block-end', index: 0, block: { type: 'text', text: 'reading the file' } },
        { type: 'block-start', index: 1, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 1, id: ToolCallId('c1'), name: 'read', argumentsDelta: '{"pa' },
      ],
    }])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('tool-call-drop'), { provider: 'mock', model: 'mock' })

    send(agent, 'go')
    await new Promise(r => setTimeout(r, 30))
    agent.cancel({ kind: 'user' })
    await waitForIdle(ctx, agent)

    // The undispatched call is dropped whole — no dangling tool_use to pair.
    const message = agent.session.snapshotEvents().find(e => e.type === 'assistant/message')
    expect(message?.type === 'assistant/message' ? message.data.message.content : undefined)
      .toEqual([{ type: 'text', text: 'reading the file' }])
    expect(agent.session.snapshotEvents().some(e => e.type === 'tool/call')).toBe(false)
  })

  it('cancel during error recovery does not finalize the failed stream', async () => {
    const adapter = new MockAdapter([[
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'doomed partial' },
      { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'SERVER_ERROR' } } },
    ]])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('recovery-cancel'), { provider: 'mock', model: 'mock' })
    // Cancellation lands while agent/request-error is in flight — the window
    // dsh-llm-retry opens when its backoff waits after appending llm/retry.
    ctx.on('agent/request-error', async ({ agent: subject }) => {
      if (subject === agent) subject.cancel({ kind: 'user' })
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    // The failed stream's prefix stays off the surface: clients reset it on
    // retry, and provider failures commit nothing.
    expect(agent.session.snapshotEvents().some(e => e.type === 'assistant/message')).toBe(false)
    const end = agent.session.snapshotEvents().find(e => e.type === 'turn/end')
    expect(end?.type === 'turn/end' ? end.data.reason.kind : undefined).toBe('aborted')
  })

  it('retry retains the failed attempt while the final message embeds only its own stream', async () => {
    const adapter = new MockAdapter([
      [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'doomed partial' },
        { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'SERVER_ERROR' } } },
      ],
      textResponse('recovered'),
    ])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('retry-discards-content'), { provider: 'mock', model: 'mock' })
    ctx.on('agent/request-error', async () => ({ kind: 'retry' as const }))

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    const messages = agent.session.snapshotEvents().filter(e => e.type === 'assistant/message')
    expect(messages).toHaveLength(1)
    const message = messages[0]!
    expect(message.type === 'assistant/message' ? message.data.message.content : undefined)
      .toEqual([{ type: 'text', text: 'recovered' }])
    expect(message.type === 'assistant/message' ? message.data.interrupted : undefined).toBeUndefined()
    const failed = agent.session.snapshotEvents().find(e => e.type === 'assistant/attempt')
    expect(failed?.type === 'assistant/attempt'
      ? expandAssistantStream(failed.data.stream).some(member => (
        member.chunk.type === 'text-delta' && member.chunk.text === 'doomed partial'
      ))
      : false).toBe(true)
    expect(message.type === 'assistant/message'
      ? expandAssistantStream(message.data.stream).some(member => (
        member.chunk.type === 'text-delta' && member.chunk.text === 'doomed partial'
      ))
      : true).toBe(false)
  })

  it('retains a partial attempt when stream middleware rejects without cancellation', async () => {
    const failure = new Error('provider transport failed')
    const adapter = new MockAdapter([[
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'partial before failure' },
    ]])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('provider-stream-rejection'), { provider: 'mock', model: 'mock' })
    ctx.on('llm/stream', async function* (_options, next) {
      for await (const chunk of next()) {
        yield chunk
        if (chunk.type === 'text-delta') throw failure
      }
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    const attempt = agent.session.snapshotEvents().find(event => event.type === 'assistant/attempt')
    expect(attempt?.type === 'assistant/attempt'
      ? expandAssistantStream(attempt.data.stream).map(member => member.chunk)
      : []).toContainEqual({ type: 'text-delta', index: 0, text: 'partial before failure' })
    expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')).toMatchObject({
      type: 'turn/end', data: { reason: { kind: 'error', error: { message: failure.message } } },
    })
  })

  it('cancel before any visible content finalizes nothing', async () => {
    const adapter = new MockAdapter([{
      hangAfter: [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 0, id: ToolCallId('c1'), name: 'read', argumentsDelta: '{"pa' },
      ],
    }])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('nothing-to-finalize'), { provider: 'mock', model: 'mock' })

    send(agent, 'go')
    await new Promise(r => setTimeout(r, 30))
    agent.cancel({ kind: 'user' })
    await waitForIdle(ctx, agent)

    expect(agent.session.snapshotEvents().some(e => e.type === 'assistant/message')).toBe(false)
  })

  it('cancel from a synchronous step/start session-event listener drops the step (post-step-start window)', async () => {
    const adapter = new MockAdapter([textResponse('should not stream')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    // A step/start session-event listener fires AFTER step/start is appended
    // (and after the pre-step extension point), so cancelling there lands in the SECOND
    // cancel check (the one that must closeStep() to balance the already-open
    // step) — distinct from a turn-start cancel, caught before the step opens.
    let streamed = false
    ctx.on('agent/assistant-stream', ({ frame }) => { if (frame.type === 'chunk') streamed = true })
    const dispose = ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'step/start') agent.cancel({ kind: 'user' })
    })

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    await waitForIdle(ctx, agent)
    dispose()

    // No step streamed, the turn ended with the coarse aborted outcome, and the
    // log is balanced (the open step was closed by the cancel branch).
    expect(streamed).toBe(false)
    expect(reasons).toEqual([{ kind: 'aborted', reason: { kind: 'user' } }])
    const types = agent.session.snapshotEvents().map(e => e.type)
    expect(types.filter(t => t === 'step/start').length).toBe(types.filter(t => t === 'step/end').length)
  })

  it('an intent observed from session/event cannot recurse without bound', async () => {
    const adapter = new MockAdapter([textResponse('should not stream')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('intent-recursion'), { provider: 'mock', model: 'mock' })
    let streamed = false
    ctx.on('agent/assistant-stream', ({ frame }) => { if (frame.type === 'chunk') streamed = true })
    // 空队列的 step/start 取消会因重入排到本次 publication 的同步 drain。
    let stepStartSeq = -1
    let intentSeq = -1
    ctx.on('session/event', (session, event) => {
      if (session !== agent.session) return
      if (event.type === 'step/start') {
        stepStartSeq = event.seq
        agent.cancel({ kind: 'user' })
      }
    })
    // 观察 intent 也取消；坏实现会不断排新任务。计数上限避免锁死 runner。
    let intents = 0
    const disposeIntent = ctx.on('session/event', (session, event) => {
      if (session !== agent.session || event.type !== 'agent/inbox/spliced') return
      if (event.data.outcome !== 'canceled' || event.data.removedCount !== undefined) return
      if (intents >= 5) return
      intents += 1
      intentSeq = event.seq
      agent.cancel({ kind: 'user' })
    })
    send(agent, 'go')
    await waitForIdle(ctx, agent)
    disposeIntent()
    expect(intents).toBe(1)
    // 意图就在触发它的 publication 之后，不会晚于任何后续输入。
    expect(stepStartSeq).toBeGreaterThanOrEqual(0)
    expect(intentSeq).toBe(stepStartSeq + 1)
    expect(streamed).toBe(false)
  })

  it('aborts the captured activity when cancellation bookkeeping fails', async () => {
    const adapter = new MockAdapter(['hang', textResponse('after bookkeeping failure')])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('bookkeeping-failure'), { provider: 'mock', model: 'mock' })
      send(agent, 'go')
      await expect.poll(() => adapter.requests.length).toBe(1)
      const signal = adapter.requests[0]?.signal
      if (signal === undefined) throw new Error('model request omitted its turn signal')
      const later = createUserMessage({ content: [{ type: 'text', text: 'after bookkeeping failure' }], source: { kind: 'user' } })
      signal.addEventListener('abort', () => { agent.followup(later) }, { once: true })
      const bookkeeping = vi.spyOn(agent.inbox as ReactLoopInbox, 'cancelSnapshot')
        .mockImplementation(() => { throw new Error('forced cancellation bookkeeping failure') })
      try {
        expect(() => { agent.cancel({ kind: 'user' }) }).toThrow('forced cancellation bookkeeping failure')
      } finally {
        bookkeeping.mockRestore()
      }
      await agent.whenIdle()
      // The abort listener's input still wakes; the failure skipped neither the
      // abort of the captured activity nor the activity the listener started.
      expect(adapter.requests).toHaveLength(2)
      expect(userTexts(agent)).toEqual(['go', 'after bookkeeping failure'])
      expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
        ?.data.reason).toEqual({ kind: 'completed' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('disposal from a synchronous step/start session-event listener stops before adapter dispatch', async () => {
    const adapter = new MockAdapter([textResponse('should not stream')])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], adapter)

    const handle = await ctx.agents.create({
      sessionId: SessionId('dispose-step-start-session'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const agent = handle.agent

    let disposalDone: Promise<void> | undefined
    let streamed = false
    ctx.on('agent/assistant-stream', ({ frame }) => { if (frame.type === 'chunk') streamed = true })
    ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'step/start') disposalDone = handle.dispose()
    })

    send(agent, 'go')
    await disposalDone
    await driverDone(agent)

    expect(streamed).toBe(false)
    expect(adapter.requests).toHaveLength(0)
    expect(agent.session.snapshotEvents().some(e => e.type === 'turn/end')).toBe(false)
    const types = agent.session.snapshotEvents().map(e => e.type)
    expect(types.filter(t => t === 'step/start').length).toBe(types.filter(t => t === 'step/end').length)
  })

  it('cancel during the stopping window ends the turn aborted and runs no further step', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    let steps = 0
    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'step/start') steps += 1
      if (event.type === 'turn/end') reasons.push(event.data.reason)
    })

    let cancelled = false
    ctx.on('agent/turn-stopping', ({ agent: subject }) => {
      if (subject === agent && !cancelled) {
        cancelled = true
        agent.cancel({ kind: 'user' })
      }
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    // Only ONE step ran (the second was cancelled in the stopping window),
    // and the shared turn signal classified the durable outcome as aborted.
    expect(steps).toBe(1)
    expect(reasons).toEqual([{ kind: 'aborted', reason: { kind: 'user' } }])
  })

  it('cancel from a synchronous agent/status(running) listener drops the turn (window 2)', async () => {
    const adapter = new MockAdapter([textResponse('should not run')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    // `agent/status` is synchronous, so cancellation can land before the
    // durable turn-start commit and must drop the reserved work.
    let streamed = false
    ctx.on('agent/assistant-stream', ({ frame }) => { if (frame.type === 'chunk') streamed = true })
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'running') agent.cancel({ kind: 'user' })
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)
    dispose()

    // No turn opened, no step streamed, and a later prompt still runs (the marker
    // was reset).
    expect(streamed).toBe(false)
    expect(agent.session.snapshotEvents().some(e => e.type === 'turn/start')).toBe(false)
  })

  it('a running-listener cancellation replays replacement work at convergence', async () => {
    const adapter = new MockAdapter([textResponse('A reply'), textResponse('B reply')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    let replaced = false
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== agent || status !== 'running' || replaced) return
      replaced = true
      agent.cancel({ kind: 'user' })
      send(agent, 'B')
    })

    send(agent, 'A')
    const idle = agent.whenIdle()
    await idle
    dispose()

    // B's wake was latched behind the cancelled driver: it runs on its own.
    expect(userTexts(agent)).toEqual(['B'])
    expect(agent.inbox.nextTurn).toHaveLength(0)
    expect(adapter.requests).toHaveLength(1)

    const replacementIdle = waitForIdle(ctx, agent)
    send(agent, 'C')
    await replacementIdle
    expect(userTexts(agent)).toEqual(['B', 'C'])
    expect(adapter.requests).toHaveLength(2)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/end')).toHaveLength(2)
  })

  it('a prompt queued during pre-step cancellation replays at convergence', async () => {
    const adapter = new MockAdapter([textResponse('A reply'), textResponse('B reply')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    send(agent, 'A')
    const idle = agent.whenIdle()
    agent.cancel({ kind: 'user' })
    send(agent, 'B')

    await idle
    expect(userTexts(agent)).toEqual(['B'])
    expect(agent.inbox.nextTurn).toHaveLength(0)
    expect(adapter.requests).toHaveLength(1)

    const replacementIdle = waitForIdle(ctx, agent)
    send(agent, 'C')
    await replacementIdle
    expect(userTexts(agent)).toEqual(['B', 'C'])
    expect(adapter.requests).toHaveLength(2)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/end')).toHaveLength(3)
  })

  it("cancel clears the turn's steering — it is not re-enqueued as a fresh turn", async () => {
    const adapter = new MockAdapter(['hang'])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    send(agent, 'go')
    await new Promise(r => setTimeout(r, 30))
    expect(agent.status).toBe('running')
    // Steer (joins the running turn's steering FIFO), then cancel: the steering
    // must be dropped, NOT re-enqueued as a new queued turn.
    agent.steer(createUserMessage({ content: [{ type: 'text', text: 'steer text' }], source: { kind: 'user' } }))
    agent.cancel({ kind: 'user' })
    await waitForIdle(ctx, agent)

    // After the cancelled turn settles, the agent is idle with NO follow-up turn
    // started from the dropped steering.
    await new Promise(r => setTimeout(r, 30))
    expect(agent.status).toBe('idle')
    const turnStarts = agent.session.snapshotEvents().filter(e => e.type === 'turn/start')
    expect(turnStarts.length).toBe(1) // only the original (cancelled) turn
    // The steering text was dropped — it never reached the log.
    const flat = agent.session.snapshotEvents()
      .filter(e => e.type === 'user/message')
      .flatMap(e => e.data.content)
      .flatMap(b => b.type === 'text' ? [b.text] : [])
    expect(flat).not.toContain('steer text')
  })

  it('replays replacement work queued synchronously by an abort observer', async () => {
    const adapter = new MockAdapter([
      'hang',
      textResponse('replacement reply'),
      textResponse('wake reply'),
    ])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('abort-observer-replacement'), { provider: 'mock', model: 'mock' })

    send(agent, 'original')
    await expect.poll(() => adapter.requests.length).toBe(1)
    const signal = adapter.requests[0]?.signal
    if (signal === undefined) throw new Error('model request omitted its turn signal')
    signal.addEventListener('abort', () => { send(agent, 'replacement') }, { once: true })
    const idle = agent.whenIdle()
    agent.cancel({ kind: 'user' })
    await Promise.race([
      idle,
      new Promise((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error(`replacement did not settle: ${JSON.stringify({
            status: agent.status,
            requests: adapter.requests.length,
            users: userTexts(agent),
            events: agent.session.snapshotEvents().map(event => event.type),
          })}`))
        }, 1000)
      }),
    ])

    // The abort-observer wake was latched: replacement runs at convergence,
    // so the original turn is followed by a completed replacement turn.
    expect(adapter.requests).toHaveLength(2)
    expect(userTexts(agent)).toEqual(['original', 'replacement'])
    expect(agent.inbox.nextTurn).toHaveLength(0)
    const reasons = agent.session.snapshotEvents()
      .filter(event => event.type === 'turn/end')
      .map(event => event.type === 'turn/end' ? event.data.reason : undefined)
    expect(reasons).toEqual([{ kind: 'aborted', reason: { kind: 'user' } }, { kind: 'completed' }])

    const replacementIdle = waitForIdle(ctx, agent)
    send(agent, 'wake it')
    await replacementIdle
    expect(adapter.requests).toHaveLength(3)
    expect(userTexts(agent)).toEqual(['original', 'replacement', 'wake it'])
  })

  it('keeps the first typed cause for an active turn', async () => {
    const adapter = new MockAdapter(['hang'])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('typed-first-wins'), { provider: 'mock', model: 'mock' })
    const supplied: { kind: 'parent' | 'user' } = { kind: 'parent' }

    send(agent, 'go')
    await expect.poll(() => adapter.requests.length).toBe(1)
    agent.cancel(supplied)
    agent.cancel({ kind: 'user' })
    await waitForIdle(ctx, agent)

    const runtimeReason: unknown = adapter.requests[0]?.signal?.reason
    expect(runtimeReason).toEqual({ kind: 'parent' })
    expect(runtimeReason).toBe(supplied)
    const turnEnd = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason).toEqual({
      kind: 'aborted',
      reason: { kind: 'parent' },
    })
  })

  it('preserves the first user cancellation when lifecycle teardown races it', async () => {
    const adapter = new MockAdapter(['hang'])
    const ctx = await harness(adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('cancel-dispose-race'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const { agent } = handle

    send(agent, 'go')
    await expect.poll(() => adapter.requests.length).toBe(1)
    agent.cancel({ kind: 'user' })
    await handle.dispose()

    const turnEnd = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason).toEqual({ kind: 'aborted', reason: { kind: 'user' } })
  })

  it.each([
    'pre-step',
    'system-prompt',
    'request',
    'stopping',
    'tool',
  ] as const)('lets a cooperative %s boundary settle from the explicit turn signal', async (stage) => {
    const adapter = new MockAdapter(stage === 'tool'
      ? [toolCallResponse('blocked-tool', 'blocked', {})]
      : [textResponse('done')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId(`cooperative-${stage}`), { provider: 'mock', model: 'mock' })
    const started = Promise.withResolvers<undefined>()
    const blockUntilAbort = async (signal: AbortSignal): Promise<void> => {
      started.resolve(undefined)
      if (signal.aborted) return
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    }

    switch (stage) {
      case 'pre-step':
        ctx.on('agent/pre-step', async ({ agent: subject, signal }, next) => {
          if (subject === agent) await blockUntilAbort(signal)
          return next()
        })
        break
      case 'system-prompt':
        ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
          if (context.agent === agent) {
            if (context.signal === undefined) throw new Error('turn assembly omitted its signal')
            await blockUntilAbort(context.signal)
          }
          return next()
        })
        break
      case 'request':
        ctx.on('agent/request', async ({ agent: subject, signal }, next) => {
          if (subject === agent) await blockUntilAbort(signal)
          return next()
        })
        break
      case 'stopping':
        ctx.on('agent/turn-stopping', async ({ agent: subject, signal }) => {
          if (subject === agent) await blockUntilAbort(signal)
        })
        break
      case 'tool':
        ctx.tools.register(defineContentToolFixture({
          name: 'blocked',
          description: 'wait for cancellation',
          parameters: {},
          execute: async (_args, exec) => {
            if (exec.signal === undefined) throw new Error('tool execution omitted its signal')
            await blockUntilAbort(exec.signal)
            return [{ type: 'text', text: 'cancelled' }]
          },
        }))
        break
    }

    send(agent, 'go')
    await started.promise
    const idle = agent.whenIdle()
    agent.cancel({ kind: 'user' })
    await idle
    const turnEnd = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason)
      .toEqual({ kind: 'aborted', reason: { kind: 'user' } })
    await ctx.fiber.dispose()
  })

  it('records the stable cancellation cause on durable inbox splices', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    try {
      const handle = await ctx.agents.create({
        sessionId: SessionId('inbox-splice-cause'),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      const agent = handle.agent
      const splices: { outcome?: string; cause?: string; removedCount?: number }[] = []
      ctx.on('session/event', (session, event) => {
        if (session === agent.session && event.type === 'agent/inbox/spliced') splices.push(event.data)
      })
      const canceled = createUserMessage({ content: [{ type: 'text', text: 'user cancel' }], source: { kind: 'user' } })
      agent.inject(canceled)
      agent.cancel({ kind: 'user' })
      expect(splices.at(-1)).toMatchObject({ outcome: 'canceled', cause: 'user', removedCount: 1 })

      const removed = createUserMessage({ content: [{ type: 'text', text: 'removed' }], source: { kind: 'user' } })
      agent.inject(removed)
      agent.inbox.remove(removed.id)
      expect(splices.at(-1)).toMatchObject({ outcome: 'canceled', removedCount: 1 })
      expect(splices.at(-1)?.cause).toBeUndefined()

      const disposedMessage = createUserMessage({ content: [{ type: 'text', text: 'dispose' }], source: { kind: 'user' } })
      agent.inject(disposedMessage)
      await handle.dispose()
      expect(splices.at(-1)).toMatchObject({ outcome: 'canceled', cause: 'disposed', removedCount: 1 })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('inject commits a batch in one splice and a synchronous cancel clears it', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('inject-batch'), { provider: 'mock', model: 'mock' })
      const splices: {
        target: string
        start: number
        inserted: readonly { id: string }[]
        outcome?: string
        cause?: string
        removedCount?: number
      }[] = []
      ctx.on('session/event', (session, event) => {
        if (session === agent.session && event.type === 'agent/inbox/spliced') splices.push(event.data)
      })
      let cancelOnInsert = false
      const disposeInserted = ctx.on('agent/inbox/inserted', () => {
        if (cancelOnInsert) agent.cancel({ kind: 'user' })
      })
      const first = createUserMessage({ content: [{ type: 'text', text: 'batch one' }], source: { kind: 'user' } })
      const second = createUserMessage({ content: [{ type: 'text', text: 'batch two' }], source: { kind: 'user' } })
      if (agent.injectBatch === undefined) throw new Error('AgentLoop must provide injectBatch')
      agent.injectBatch([first, second])
      expect(agent.inbox.nextStep.map(message => message.id)).toEqual([first.id, second.id])
      expect(splices.at(-1)?.inserted.map(message => message.id)).toEqual([first.id, second.id])
      agent.cancel({ kind: 'user' })

      cancelOnInsert = true
      const third = createUserMessage({ content: [{ type: 'text', text: 'cancel one' }], source: { kind: 'user' } })
      const fourth = createUserMessage({ content: [{ type: 'text', text: 'cancel two' }], source: { kind: 'user' } })
      agent.injectBatch([third, fourth])
      disposeInserted()
      expect(agent.inbox.nextStep).toEqual([])
      expect(agent.inbox.nextTurn).toEqual([])
      // The batch splice precedes the synchronous cancel's clear: no later
      // one-by-one insertion exists to resurrect the batch.
      const batch = splices.find(entry => entry.inserted.some(message => message.id === third.id))
      expect(batch?.inserted.map(message => message.id)).toEqual([third.id, fourth.id])
      // The first synchronous cancel removed the whole batch in one splice; a
      // later cancel on the already-empty queue appends an intent-only fact.
      const removal = splices.find(entry => entry.removedCount === 2)
      expect(removal).toMatchObject({ outcome: 'canceled', cause: 'user', removedCount: 2 })
      const intents = splices.filter(entry => entry.removedCount === undefined && entry.inserted.length === 0)
      expect(intents.length).toBeGreaterThan(0)
      expect(intents.every(entry => entry.target === 'next-step' && entry.start === 0
        && entry.outcome === 'canceled' && entry.cause === 'user')).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('aborts a running turn and wakes input delivered by the cancellation intent', async () => {
    const adapter = new MockAdapter(['hang', textResponse('next reply')])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('intent-wakes-later-input'), { provider: 'mock', model: 'mock' })
      const later = createUserMessage({ content: [{ type: 'text', text: 'next' }], source: { kind: 'user' } })
      // A consumer of the durable fact records its own follow-up in the
      // post-publication drain, before cancel() returns to its caller.
      const dispose = ctx.on('session/event', (session, event) => {
        if (session !== agent.session || event.type !== 'agent/inbox/spliced') return
        if (event.data.outcome !== 'canceled' || event.data.removedCount !== undefined) return
        session.afterPublication(() => { agent.followup(later) })
      })
      send(agent, 'first')
      await expect.poll(() => adapter.requests.length).toBe(1)
      agent.cancel({ kind: 'user' })
      await agent.whenIdle()
      dispose()

      const events = agent.session.snapshotEvents()
      const intent = events.find(event => event.type === 'agent/inbox/spliced'
        && event.data.outcome === 'canceled' && event.data.removedCount === undefined)
      const inserted = events.find(event => event.type === 'agent/inbox/spliced'
        && event.data.inserted.some(message => message.id === later.id))
      if (intent === undefined) throw new Error('cancellation intent was not appended')
      if (inserted === undefined) throw new Error('later input was not queued')
      expect(inserted.seq).toBeGreaterThan(intent.seq)
      expect(adapter.requests).toHaveLength(2)
      expect(adapter.requests[0]?.signal?.aborted).toBe(true)
      expect(userTexts(agent)).toEqual(['first', 'next'])
      expect(events.filter(event => event.type === 'turn/end')
        .map(event => event.type === 'turn/end' ? event.data.reason : undefined))
        .toEqual([{ kind: 'aborted', reason: { kind: 'user' } }, { kind: 'completed' }])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('leaves a turn started by an idle cancellation callback running', async () => {
    const adapter = new MockAdapter([textResponse('idle reply')])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('idle-cancel-does-not-arm'), { provider: 'mock', model: 'mock' })
      const later = createUserMessage({ content: [{ type: 'text', text: 'started by callback' }], source: { kind: 'user' } })
      const dispose = ctx.on('session/event', (session, event) => {
        if (session !== agent.session || event.type !== 'agent/inbox/spliced') return
        if (event.data.outcome !== 'canceled' || event.data.removedCount !== undefined) return
        session.afterPublication(() => { agent.followup(later) })
      })
      agent.cancel({ kind: 'user' })
      await agent.whenIdle()
      dispose()

      // An idle cancellation arms nothing: the turn this callback started is
      // not aborted by the cancellation that ran before it.
      expect(adapter.requests).toHaveLength(1)
      expect(userTexts(agent)).toEqual(['started by callback'])
      expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/end')
        .map(event => event.type === 'turn/end' ? event.data.reason : undefined))
        .toEqual([{ kind: 'completed' }])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps input added by an abort listener while removing the captured queue', async () => {
    const adapter = new MockAdapter(['hang', textResponse('after abort')])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('abort-listener-input'), { provider: 'mock', model: 'mock' })
      send(agent, 'first')
      await expect.poll(() => adapter.requests.length).toBe(1)
      const oldSteer = createUserMessage({ content: [{ type: 'text', text: 'old steer' }], source: { kind: 'user' } })
      const oldTurn = createUserMessage({ content: [{ type: 'text', text: 'old turn' }], source: { kind: 'user' } })
      agent.inject(oldSteer)
      agent.send(oldTurn, 'next-turn', false)
      const signal = adapter.requests[0]?.signal
      if (signal === undefined) throw new Error('model request omitted its turn signal')
      const later = createUserMessage({ content: [{ type: 'text', text: 'abort input' }], source: { kind: 'user' } })
      signal.addEventListener('abort', () => { agent.followup(later) }, { once: true })
      agent.cancel({ kind: 'user' })
      await agent.whenIdle()

      // Only the input captured at entry was removed; the abort listener's
      // input stays pending and runs once the cancelled turn converges.
      expect(agent.inbox.nextStep).toEqual([])
      expect(agent.inbox.nextTurn).toEqual([])
      expect(userTexts(agent)).toEqual(['first', 'abort input'])
      expect(adapter.requests).toHaveLength(2)
      const removals = agent.session.snapshotEvents().filter(event => event.type === 'agent/inbox/spliced'
        && event.data.outcome === 'canceled' && event.data.removedCount !== undefined)
      expect(removals.map(event => event.type === 'agent/inbox/spliced' ? event.data.removedCount : 0))
        .toEqual([1, 1])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('removes captured messages by identity when a clear callback prepends later input', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('captured-identity-clear'), { provider: 'mock', model: 'mock' })
      const oldStep = createUserMessage({ content: [{ type: 'text', text: 'old step' }], source: { kind: 'user' } })
      const oldTurn = createUserMessage({ content: [{ type: 'text', text: 'old turn' }], source: { kind: 'user' } })
      const later = createUserMessage({ content: [{ type: 'text', text: 'later turn' }], source: { kind: 'user' } })
      agent.inject(oldStep)
      agent.send(oldTurn, 'next-turn', false)
      let prepended = false
      const dispose = ctx.on('agent/inbox/discarded', ({ message }) => {
        if (prepended || message.id !== oldStep.id) return
        prepended = true
        // The cancellation callback prepends later input to the other lane; a
        // length-based clear would delete it and leave the old turn behind.
        agent.inbox.prepend('next-turn', later)
      })
      agent.cancel({ kind: 'user' })
      dispose()

      expect(prepended).toBe(true)
      expect(agent.inbox.nextStep).toEqual([])
      expect(agent.inbox.nextTurn.map(message => message.id)).toEqual([later.id])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('lets a nested cancellation cancel the input the first abort listener added', async () => {
    const adapter = new MockAdapter(['hang'])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('nested-cancel'), { provider: 'mock', model: 'mock' })
      const later = createUserMessage({ content: [{ type: 'text', text: 'nested target' }], source: { kind: 'user' } })
      send(agent, 'first')
      await expect.poll(() => adapter.requests.length).toBe(1)
      const signal = adapter.requests[0]?.signal
      if (signal === undefined) throw new Error('model request omitted its turn signal')
      let nested = false
      signal.addEventListener('abort', () => {
        if (nested) return
        nested = true
        agent.followup(later)
        // The second cancellation targets the input the first listener added.
        agent.cancel({ kind: 'user' })
      }, { once: true })
      agent.cancel({ kind: 'user' })
      await agent.whenIdle()

      expect(nested).toBe(true)
      expect(agent.inbox.nextTurn).toEqual([])
      expect(agent.inbox.nextStep).toEqual([])
      expect(userTexts(agent)).toEqual(['first'])
      expect(adapter.requests).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps captured pending input and the earlier wake under keepInbox', async () => {
    const adapter = new MockAdapter(['hang', textResponse('kept reply')])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('keep-captured-input'), { provider: 'mock', model: 'mock' })
      send(agent, 'first')
      await expect.poll(() => adapter.requests.length).toBe(1)
      const steer = createUserMessage({ content: [{ type: 'text', text: 'kept steer' }], source: { kind: 'user' } })
      const later = createUserMessage({ content: [{ type: 'text', text: 'kept after abort' }], source: { kind: 'user' } })
      agent.inject(steer)
      const signal = adapter.requests[0]?.signal
      if (signal === undefined) throw new Error('model request omitted its turn signal')
      signal.addEventListener('abort', () => { agent.followup(later) }, { once: true })
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      await agent.whenIdle()

      // keepInbox removes nothing: the captured steering and the input added
      // during the cancellation both run in the next turn.
      expect(userTexts(agent)).toEqual(['first', 'kept steer', 'kept after abort'])
      expect(adapter.requests).toHaveLength(2)
      expect(agent.session.snapshotEvents().some(event => event.type === 'agent/inbox/spliced'
        && event.data.outcome === 'canceled')).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('stops maintenance and runs input delivered by the cancellation', async () => {
    const adapter = new MockAdapter([textResponse('maintenance reply')])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('maintenance-cancel-wake'), { provider: 'mock', model: 'mock' })
      const started = Promise.withResolvers<undefined>()
      let maintenanceSignal: AbortSignal | undefined
      const maintenance = agent.runMaintenance(async (signal) => {
        maintenanceSignal = signal
        started.resolve(undefined)
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
        return 'stopped'
      })
      await started.promise
      // Public status stays idle while maintenance runs.
      expect(agent.status).toBe('idle')
      const later = createUserMessage({ content: [{ type: 'text', text: 'after maintenance cancel' }], source: { kind: 'user' } })
      if (maintenanceSignal === undefined) throw new Error('maintenance omitted its signal')
      maintenanceSignal.addEventListener('abort', () => { agent.followup(later) }, { once: true })
      agent.cancel({ kind: 'user' })
      await maintenance
      await agent.whenIdle()

      expect(adapter.requests).toHaveLength(1)
      expect(userTexts(agent)).toEqual(['after maintenance cancel'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('aborts the captured activity when pending input cannot be captured', async () => {
    const adapter = new MockAdapter(['hang', textResponse('after snapshot failure')])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('snapshot-failure'), { provider: 'mock', model: 'mock' })
      send(agent, 'go')
      await expect.poll(() => adapter.requests.length).toBe(1)
      const old = createUserMessage({ content: [{ type: 'text', text: 'old pending' }], source: { kind: 'user' } })
      agent.inject(old)
      const signal = adapter.requests[0]?.signal
      if (signal === undefined) throw new Error('model request omitted its turn signal')
      const later = createUserMessage({ content: [{ type: 'text', text: 'after snapshot failure' }], source: { kind: 'user' } })
      signal.addEventListener('abort', () => { agent.followup(later) }, { once: true })
      const snapshot = vi.spyOn(agent.inbox as ReactLoopInbox, 'snapshotPending')
        .mockImplementation(() => { throw new Error('forced snapshot failure') })
      try {
        expect(() => { agent.cancel({ kind: 'user' }) }).toThrow('forced snapshot failure')
      } finally {
        snapshot.mockRestore()
      }
      // The failed capture leaves the old occurrence pending instead of
      // guessing, and the abort guarantee still stopped the captured activity.
      expect(agent.inbox.nextStep.map(message => message.id)).toEqual([old.id])
      await agent.whenIdle()
      expect(adapter.requests).toHaveLength(2)
      expect(userTexts(agent)).toEqual(['go', 'old pending', 'after snapshot failure'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('removes each captured occurrence once when a discard notification re-injects it', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('captured-reinject'), { provider: 'mock', model: 'mock' })
      const original = createUserMessage({ content: [{ type: 'text', text: 're-injected' }], source: { kind: 'user' } })
      agent.inject(original)
      let reinjections = 0
      // The cap keeps a broken implementation that re-matches the consumed
      // occurrence from locking the runner.
      const dispose = ctx.on('agent/inbox/discarded', ({ message }) => {
        if (message.id !== original.id || reinjections >= 3) return
        reinjections += 1
        agent.inbox.append('next-step', message)
      })
      agent.cancel({ kind: 'user' })
      dispose()

      // The occurrence captured at entry was removed once; the re-injected
      // occurrence is later input and remains pending.
      expect(reinjections).toBe(1)
      expect(agent.inbox.nextStep.map(message => message.id)).toEqual([original.id])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('records the cancellation entry cut before input added while the intent is deferred', async () => {
    const adapter = new MockAdapter([textResponse('late input reply')])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('cancel-entry-cut'), { provider: 'mock', model: 'mock' })
      const started = Promise.withResolvers<undefined>()
      let maintenanceSignal: AbortSignal | undefined
      const maintenance = agent.runMaintenance(async (signal) => {
        maintenanceSignal = signal
        started.resolve(undefined)
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
        return 'stopped'
      })
      await started.promise
      if (maintenanceSignal === undefined) throw new Error('maintenance omitted its signal')
      const later = createUserMessage({ content: [{ type: 'text', text: 'added before the intent' }], source: { kind: 'user' } })
      // One observer queues later input for the drain; a later observer cancels
      // reentrantly, so the intent is appended after that input.
      let queued = false
      const disposeQueued = ctx.on('session/event', (session, event) => {
        if (session !== agent.session || event.type !== 'request/context' || queued) return
        if (event.data.provider !== 'probe') return
        queued = true
        session.afterPublication(() => { agent.followup(later) })
      })
      let canceled = false
      const disposeCancel = ctx.on('session/event', (session, event) => {
        if (session !== agent.session || event.type !== 'request/context' || canceled) return
        if (event.data.provider !== 'probe') return
        canceled = true
        agent.cancel({ kind: 'user' })
      })
      const probe = agent.session.append('request/context', { provider: 'probe', model: 'model' })
      disposeQueued()
      disposeCancel()
      await maintenance
      await agent.whenIdle()

      const events = agent.session.snapshotEvents()
      const intent = events.find(event => event.type === 'agent/inbox/spliced'
        && event.data.cause === 'user' && event.data.removedCount === undefined)
      const inserted = events.find(event => event.type === 'agent/inbox/spliced'
        && event.data.inserted.some(message => message.id === later.id))
      if (intent === undefined || intent.type !== 'agent/inbox/spliced') throw new Error('cancellation intent was not appended')
      if (inserted === undefined) throw new Error('later input was not queued')
      expect(probe.seq).toBeLessThan(inserted.seq)
      // The intent is logged after the later input, but its entry cut is that
      // input's own insertion seq; a reader must use entrySeq, not the intent
      // seq, so an older cancellation cannot claim this later turn.
      expect(intent.data.entrySeq).toBe(inserted.seq)
      expect(intent.seq).toBeGreaterThan(inserted.seq)
      expect(userTexts(agent)).toEqual(['added before the intent'])
      expect(adapter.requests).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('holds a clear callback wake until an idle cancellation removes both captured lists', async () => {
    const adapter = new MockAdapter([textResponse('later reply')])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('idle-cohort-wake'), { provider: 'mock', model: 'mock' })
      const oldStep = createUserMessage({ content: [{ type: 'text', text: 'old step' }], source: { kind: 'user' } })
      const oldTurn = createUserMessage({ content: [{ type: 'text', text: 'old turn' }], source: { kind: 'user' } })
      const later = createUserMessage({ content: [{ type: 'text', text: 'later' }], source: { kind: 'user' } })
      agent.inject(oldStep)
      agent.send(oldTurn, 'next-turn', false)
      let woken = false
      const dispose = ctx.on('agent/inbox/discarded', ({ message }) => {
        if (woken || message.id !== oldStep.id) return
        woken = true
        // The wake arrives while the captured turn is still pending. A driver
        // started here would claim that turn before this cancellation removes it.
        agent.followup(later)
      })
      agent.cancel({ kind: 'user' })
      dispose()
      await agent.whenIdle()

      expect(woken).toBe(true)
      expect(userTexts(agent)).toEqual(['later'])
      expect(adapter.requests).toHaveLength(1)
      expect(agent.inbox.nextTurn).toEqual([])
      expect(agent.inbox.nextStep).toEqual([])
      expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/end')
        .map(event => event.type === 'turn/end' ? event.data.reason : undefined))
        .toEqual([{ kind: 'completed' }])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('replays a held steering wake only after the captured turn is removed', async () => {
    const adapter = new MockAdapter([textResponse('steer reply')])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('idle-cohort-steer'), { provider: 'mock', model: 'mock' })
      const oldStep = createUserMessage({ content: [{ type: 'text', text: 'old step' }], source: { kind: 'user' } })
      const oldTurn = createUserMessage({ content: [{ type: 'text', text: 'old turn' }], source: { kind: 'user' } })
      const later = createUserMessage({ content: [{ type: 'text', text: 'later steer' }], source: { kind: 'user' } })
      agent.inject(oldStep)
      agent.send(oldTurn, 'next-turn', false)
      const dispose = ctx.on('agent/inbox/discarded', ({ message }) => {
        if (message.id === oldStep.id) agent.steer(later)
      })
      agent.cancel({ kind: 'user' })
      dispose()
      await agent.whenIdle()

      // The steering wake lands in next-step; the captured turn must still be
      // gone before the driver opens the turn that claims that steering.
      expect(userTexts(agent)).toEqual(['later steer'])
      expect(adapter.requests).toHaveLength(1)
      expect(agent.inbox.nextStep).toEqual([])
      expect(agent.inbox.nextTurn).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('withdraws a held wake a nested cancellation removed, without waking passive input', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('nested-cancelled-wake'), { provider: 'mock', model: 'mock' })
      const oldStep = createUserMessage({ content: [{ type: 'text', text: 'old step' }], source: { kind: 'user' } })
      const oldTurn = createUserMessage({ content: [{ type: 'text', text: 'old turn' }], source: { kind: 'user' } })
      const waking = createUserMessage({ content: [{ type: 'text', text: 'waking' }], source: { kind: 'user' } })
      const passive = createUserMessage({ content: [{ type: 'text', text: 'passive' }], source: { kind: 'user' } })
      agent.inject(oldStep)
      agent.send(oldTurn, 'next-turn', false)
      let nested = false
      const dispose = ctx.on('agent/inbox/discarded', ({ message }) => {
        if (!nested && message.id === oldStep.id) {
          nested = true
          agent.followup(waking)
          // The nested cancellation targets the waking occurrence. The passive
          // input arrives after its snapshot and authorizes no turn of its own.
          agent.cancel({ kind: 'user' })
          return
        }
        if (message.id === waking.id) agent.inject(passive)
      })
      agent.cancel({ kind: 'user' })
      dispose()

      expect(nested).toBe(true)
      expect(adapter.requests).toHaveLength(0)
      expect(agent.inbox.nextTurn).toEqual([])
      expect(agent.inbox.nextStep.map(message => message.id)).toEqual([passive.id])
      expect(agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('holds no wake for an occurrence a callback removed during its insertion', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('withdrawn-insertion-wake'), { provider: 'mock', model: 'mock' })
      const oldStep = createUserMessage({ content: [{ type: 'text', text: 'old step' }], source: { kind: 'user' } })
      const waking = createUserMessage({ content: [{ type: 'text', text: 'waking' }], source: { kind: 'user' } })
      agent.inject(oldStep)
      const disposeInserted = ctx.on('agent/inbox/inserted', ({ message }) => {
        if (message.id === waking.id) agent.inbox.remove(message.id)
      })
      const disposeDiscarded = ctx.on('agent/inbox/discarded', ({ message }) => {
        if (message.id === oldStep.id) agent.followup(waking)
      })
      agent.cancel({ kind: 'user' })
      disposeDiscarded()
      disposeInserted()

      // The waking occurrence never reached pending, so its wake authorizes
      // nothing and no turn boundary is opened.
      expect(adapter.requests).toHaveLength(0)
      expect(agent.inbox.nextTurn).toEqual([])
      expect(agent.inbox.nextStep).toEqual([])
      expect(agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not start a held wake when the captured removal fails', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('failed-cohort-wake'), { provider: 'mock', model: 'mock' })
      const oldStep = createUserMessage({ content: [{ type: 'text', text: 'old step' }], source: { kind: 'user' } })
      const later = createUserMessage({ content: [{ type: 'text', text: 'later' }], source: { kind: 'user' } })
      agent.inject(oldStep)
      const dispose = ctx.on('agent/inbox/discarded', ({ message }) => {
        if (message.id === oldStep.id) agent.followup(later)
      })
      const inbox = agent.inbox as ReactLoopInbox
      const real = inbox.cancelSnapshot.bind(inbox)
      const failure = vi.spyOn(inbox, 'cancelSnapshot').mockImplementation((snapshot, cause, entrySeq) => {
        real(snapshot, cause, entrySeq)
        throw new Error('forced removal failure')
      })
      try {
        expect(() => { agent.cancel({ kind: 'user' }) }).toThrow('forced removal failure')
      } finally {
        failure.mockRestore()
        dispose()
      }

      // The failure leaves the cancellation incomplete, so its held wake must
      // not run the unfinished work; the later input waits for an explicit wake.
      expect(adapter.requests).toHaveLength(0)
      expect(agent.inbox.nextTurn.map(message => message.id)).toEqual([later.id])
      expect(agent.inbox.nextStep).toEqual([])
      expect(agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not start a held wake for a disposing cancellation', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    try {
      const handle = await ctx.agents.create({
        sessionId: SessionId('disposed-held-wake'),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      const agent = handle.agent
      const oldStep = createUserMessage({ content: [{ type: 'text', text: 'old step' }], source: { kind: 'user' } })
      const later = createUserMessage({ content: [{ type: 'text', text: 'later' }], source: { kind: 'user' } })
      agent.inject(oldStep)
      const dispose = ctx.on('agent/inbox/discarded', ({ message }) => {
        if (message.id === oldStep.id) agent.followup(later)
      })
      await handle.dispose()
      dispose()

      // Disposal starts no model turn: the later input stays queued for an
      // explicit wake instead of running over the session being torn down.
      expect(adapter.requests).toHaveLength(0)
      expect(agent.inbox.nextTurn.map(message => message.id)).toEqual([later.id])
      expect(agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps a turn occurrence a clear callback removed and re-appended', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('reinserted-clear-occurrence'), { provider: 'mock', model: 'mock' })
      const oldStep = createUserMessage({ content: [{ type: 'text', text: 'old step' }], source: { kind: 'user' } })
      const oldTurn = createUserMessage({ content: [{ type: 'text', text: 'old turn' }], source: { kind: 'user' } })
      agent.inject(oldStep)
      agent.send(oldTurn, 'next-turn', false)
      let requeued = false
      const dispose = ctx.on('agent/inbox/discarded', ({ message }) => {
        if (requeued || message.id !== oldStep.id) return
        requeued = true
        const pending = agent.inbox.nextTurn[0]
        if (pending === undefined) throw new Error('expected a pending turn occurrence')
        // Each committed insertion is a detached projection message, so the
        // re-appended occurrence is later input rather than the captured one.
        agent.inbox.remove(pending.id)
        agent.inbox.append('next-turn', pending)
      })
      agent.cancel({ kind: 'user' })
      dispose()

      expect(requeued).toBe(true)
      expect(agent.inbox.nextStep).toEqual([])
      expect(agent.inbox.nextTurn.map(message => message.id)).toEqual([oldTurn.id])
      const cancellations = agent.session.snapshotEvents()
        .filter(event => event.type === 'agent/inbox/spliced'
          && event.data.cause === 'user' && event.data.removedCount !== undefined)
      expect(cancellations.map(event => event.type === 'agent/inbox/spliced' ? event.data.target : ''))
        .toEqual(['next-step'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('withdraws a held wake instead of redeeming a same-identity passive reinsert', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('reinserted-same-identity-wake'), { provider: 'mock', model: 'mock' })
      const oldStep = createUserMessage({ content: [{ type: 'text', text: 'old step' }], source: { kind: 'user' } })
      const waking = createUserMessage({ content: [{ type: 'text', text: 'waking' }], source: { kind: 'user' } })
      agent.inject(oldStep)
      let withdrawn: UserMessage | undefined
      let nested = false
      const disposeInserted = ctx.on('agent/inbox/inserted', ({ message }) => {
        if (nested || message.id !== waking.id) return
        nested = true
        withdrawn = message
        // The nested cancellation removes the waking occurrence; the passive
        // send then inserts the same identity as a fresh projection object in
        // the same lane. Only that later occurrence stays pending.
        agent.cancel({ kind: 'user' })
        agent.send(waking, 'next-turn', false)
      })
      const disposeDiscarded = ctx.on('agent/inbox/discarded', ({ message }) => {
        if (message.id === oldStep.id) agent.followup(waking)
      })
      agent.cancel({ kind: 'user' })
      disposeInserted()
      disposeDiscarded()
      await agent.whenIdle()

      expect(nested).toBe(true)
      expect(adapter.requests).toHaveLength(0)
      expect(agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
      expect(agent.inbox.nextStep).toEqual([])
      expect(agent.inbox.nextTurn.map(message => message.id)).toEqual([waking.id])
      expect(agent.inbox.nextTurn[0]).not.toBe(withdrawn)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps a same-identity passive reinsert with different content pending without waking', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('reinserted-new-payload-wake'), { provider: 'mock', model: 'mock' })
      const oldStep = createUserMessage({ content: [{ type: 'text', text: 'old step' }], source: { kind: 'user' } })
      const waking = createUserMessage({ content: [{ type: 'text', text: 'waking' }], source: { kind: 'user' } })
      const replacement = freezeMessage({
        ...waking,
        content: [{ type: 'text', text: 'passive replacement' }],
      })
      agent.inject(oldStep)
      let withdrawn: UserMessage | undefined
      let nested = false
      const disposeInserted = ctx.on('agent/inbox/inserted', ({ message }) => {
        if (nested || message.id !== waking.id) return
        nested = true
        withdrawn = message
        agent.cancel({ kind: 'user' })
        agent.inbox.append('next-turn', replacement)
      })
      const disposeDiscarded = ctx.on('agent/inbox/discarded', ({ message }) => {
        if (message.id === oldStep.id) agent.followup(waking)
      })
      agent.cancel({ kind: 'user' })
      disposeInserted()
      disposeDiscarded()
      await agent.whenIdle()

      expect(nested).toBe(true)
      expect(adapter.requests).toHaveLength(0)
      expect(agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
      expect(agent.inbox.nextStep).toEqual([])
      expect(agent.inbox.nextTurn).toHaveLength(1)
      expect(agent.inbox.nextTurn[0]).not.toBe(withdrawn)
      expect(agent.inbox.nextTurn[0]?.content).toEqual([{ type: 'text', text: 'passive replacement' }])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('withdraws a waking occurrence a publication drain replaced before append returned', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('after-publication-reinsert-wake'), { provider: 'mock', model: 'mock' })
      const oldStep = createUserMessage({ content: [{ type: 'text', text: 'old step' }], source: { kind: 'user' } })
      const waking = createUserMessage({ content: [{ type: 'text', text: 'waking' }], source: { kind: 'user' } })
      const replacement = freezeMessage({
        ...waking,
        content: [{ type: 'text', text: 'drain replacement' }],
      })
      agent.inject(oldStep)
      let scheduled = false
      let withdrawn: UserMessage | undefined
      const disposeScheduled = ctx.on('session/event', (session, event) => {
        if (session !== agent.session || scheduled || event.type !== 'agent/inbox/spliced') return
        if (event.data.inserted.every(message => message.id !== waking.id)) return
        scheduled = true
        // Queued from the splice's own publication: this drain runs inside the
        // append that is about to report the inserted occurrence, so the
        // withdraw-and-reinsert completes before the caller sees the result.
        session.afterPublication(() => {
          withdrawn = agent.inbox.nextTurn.find(message => message.id === waking.id)
          agent.cancel({ kind: 'user' })
          agent.inbox.append('next-turn', replacement)
        })
      })
      const disposeDiscarded = ctx.on('agent/inbox/discarded', ({ message }) => {
        if (message.id === oldStep.id) agent.followup(waking)
      })
      agent.cancel({ kind: 'user' })
      disposeScheduled()
      disposeDiscarded()
      await agent.whenIdle()

      expect(scheduled).toBe(true)
      expect(withdrawn).toBeDefined()
      expect(adapter.requests).toHaveLength(0)
      expect(agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
      expect(agent.inbox.nextStep).toEqual([])
      expect(agent.inbox.nextTurn).toHaveLength(1)
      expect(agent.inbox.nextTurn[0]).not.toBe(withdrawn)
      expect(agent.inbox.nextTurn[0]?.content).toEqual([{ type: 'text', text: 'drain replacement' }])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
