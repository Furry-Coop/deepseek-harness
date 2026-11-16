/**
 * `agent/history-assembling` is the final snapshot point for one attempt: every
 * admitted message is already committed, `next()` builds and freezes the
 * request synchronously, and a listener that commits a `surface/order` inside
 * its own serialized work sees that order in the frozen request.
 */

import { afterEach, describe, expect, it } from 'vitest'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmError, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: 'stable base' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

/** Create an agent, send one prompt, and wait for the driver to go idle. */
async function runTurn(ctx: Context, id: string, text: string): Promise<Agent> {
  const agent = await ctx.agentLoop.create(SessionId(id), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
  return agent
}

/** Message kind the request carried at one index, for order assertions. */
function kindOf(message: { readonly role: string; readonly source?: { readonly kind: string } } | undefined): string | undefined {
  if (message === undefined) return undefined
  return message.role === 'user' ? message.source?.kind : message.role
}

describe('agent/history-assembling', () => {
  it('announces the fully admitted step history and freezes the request its continuation builds', async () => {
    const adapter = new MockAdapter([textResponse('done')])
    const ctx = await harness(adapter)
    ctx.systemPrompt.context({ name: 'policy', order: 0, text: 'Mode: read-only.' })
    const seen: { admitted: Message[]; request: GenerateOptions }[] = []
    ctx.on('agent/history-assembling', async ({ agent, turn, step, signal }, next) => {
      expect(turn).toBe(1)
      expect(step).toBe(1)
      expect(signal.aborted).toBe(false)
      const admitted = agent.session.deriveMessages()
      const request = await next()
      seen.push({ admitted, request })
      return request
    })

    const agent = await runTurn(ctx, 'history-assembly-announce', 'go')

    expect(seen).toHaveLength(1)
    const first = seen[0]!
    const { admitted, request } = first
    // Later admission is complete: the system head, the prompt, and the
    // refreshed runtime-context snapshot are all on the surface already.
    expect(admitted[0]?.role).toBe('system')
    expect(admitted.map(message => message.role)).toEqual(['system', 'user', 'user'])
    expect(admitted[2]?.source?.kind).toBe('runtime-context')
    // The continuation returned the exact request that reached the adapter.
    expect(request).toBe(adapter.requests[0])
    expect(request.messages).toHaveLength(admitted.length)
    for (const [index, message] of admitted.entries()) expect(request.messages[index]).toBe(message)
    expect(Object.isFrozen(request)).toBe(true)
    expect(Object.isFrozen(request.messages)).toBe(true)
    expect(agent.session.snapshotEvents().some(event => event.type === 'surface/order')).toBe(false)
  })

  it('applies an ordering committed inside the seam to the frozen request and the log', async () => {
    const adapter = new MockAdapter([textResponse('done')])
    const ctx = await harness(adapter)
    ctx.systemPrompt.context({ name: 'policy', order: 0, text: 'Mode: read-only.' })
    let admitted: Message[] = []
    let before: SessionSeq[] = []
    ctx.on('agent/history-assembling', async ({ agent }, next) => {
      admitted = agent.session.deriveMessages()
      before = [...agent.session.surface.nodes]
      // Detached copy of the head-pinned tail reversal: [head, last, ...rest].
      agent.session.append('surface/order', { nodes: [before[0]!, ...before.slice(1).reverse()] })
      return next()
    })

    const agent = await runTurn(ctx, 'history-assembly-order', 'go')

    const request = adapter.requests[0]
    expect(request).toBeDefined()
    const messages = request!.messages
    // Same recorded messages, moved: identity is preserved, nothing is copied.
    expect(messages[0]).toBe(admitted[0])
    expect(messages[1]).toBe(admitted[2])
    expect(messages[2]).toBe(admitted[1])
    expect(kindOf(messages[1])).toBe('runtime-context')
    expect(kindOf(messages[2])).toBe('user')
    // The reordering is durable and is what the surface holds ahead of the
    // assistant message this attempt appended afterwards.
    expect(agent.session.snapshotEvents().filter(event => event.type === 'surface/order')).toHaveLength(1)
    const surface = [...agent.session.surface.nodes]
    expect(surface).toHaveLength(before.length + 1)
    expect(surface.slice(0, before.length)).toEqual([before[0]!, ...before.slice(1).reverse()])
    // The changed prefix starts a new message series in the logged header.
    expect(agent.session.snapshotEvents().find(event => event.type === 'request/header')).toMatchObject({
      data: { reason: 'initial', startsSeries: true },
    })
  })

  it('runs once per attempt, and a retry freezes the order in force for that attempt', async () => {
    const adapter = new MockAdapter([fail('busy', 'RATE_LIMIT'), textResponse('ok')])
    const ctx = await harness(adapter)
    ctx.systemPrompt.context({ name: 'policy', order: 0, text: 'Mode: read-only.' })
    const attempts: { turn: number; step: number; order: (string | undefined)[] }[] = []
    ctx.on('agent/history-assembling', async ({ agent, turn, step }, next) => {
      // Commit the ordering exactly once; the retried attempt sees it already applied.
      if (!agent.session.snapshotEvents().some(event => event.type === 'surface/order')) {
        const nodes = [...agent.session.surface.nodes]
        agent.session.append('surface/order', { nodes: [nodes[0]!, ...nodes.slice(1).reverse()] })
      }
      const request = await next()
      attempts.push({ turn, step, order: request.messages.map(kindOf) })
      return request
    })
    ctx.on('agent/request-error', async () => ({ kind: 'retry' }))

    const agent = await runTurn(ctx, 'history-assembly-retry', 'go')

    expect(attempts).toEqual([
      { turn: 1, step: 1, order: ['system', 'runtime-context', 'user'] },
      { turn: 1, step: 1, order: ['system', 'runtime-context', 'user'] },
    ])
    expect(adapter.requests).toHaveLength(2)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'surface/order')).toHaveLength(1)
    for (const request of adapter.requests) {
      expect(kindOf(request.messages[1])).toBe('runtime-context')
    }
  })

  it('runs again for a tool continuation step without splitting the tool pair', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'echo', {}),
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    let mode = 'read-only'
    ctx.systemPrompt.context({ name: 'policy', order: 0, text: () => `Mode: ${mode}.` })
    ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: 'echo the argument',
      parameters: {},
      async execute() {
        mode = 'changed'
        return [{ type: 'text', text: 'echoed' }]
      },
    }))
    const steps: number[] = []
    const errors: unknown[] = []
    ctx.on('agent/error', ({ error }) => { errors.push(error) })
    let secondAdmitted: Message[] = []
    ctx.on('agent/history-assembling', async ({ agent, step }, next) => {
      steps.push(step)
      if (step === 2) {
        secondAdmitted = agent.session.deriveMessages()
        const nodes = [...agent.session.surface.nodes]
        // [system, prompt, first context, assistant, tool result, refreshed
        // context] → the refreshed snapshot moves behind the head and the older
        // one to the tail. The assistant/tool pair keeps its order.
        expect(nodes).toHaveLength(6)
        const [head, prompt, firstContext, assistant, result, latestContext] = nodes
        agent.session.append('surface/order', {
          nodes: [head!, latestContext!, prompt!, assistant!, result!, firstContext!],
        })
      }
      return next()
    })

    await runTurn(ctx, 'history-assembly-tools', 'go')

    expect(steps).toEqual([1, 2])
    expect(errors).toEqual([])
    expect(adapter.requests).toHaveLength(2)
    const messages = adapter.requests[1]!.messages
    expect(messages.map(message => message.role)).toEqual(['system', 'user', 'user', 'assistant', 'tool', 'user'])
    expect(messages[1]).toBe(secondAdmitted[5])
    expect(messages[2]).toBe(secondAdmitted[1])
    // The native tool-call message and its result stay adjacent and unchanged.
    expect(messages[3]).toBe(secondAdmitted[3])
    expect(messages[4]).toBe(secondAdmitted[4])
    expect(messages[5]).toBe(secondAdmitted[2])
    expect(messages[3]!.content.some(block => block.type === 'tool-call')).toBe(true)
  })

  it('refuses a listener that returns something other than the frozen request', async () => {
    const adapter = new MockAdapter([textResponse('unused')])
    const ctx = await harness(adapter)
    ctx.on('agent/history-assembling', async (_payload, next) => ({ ...await next() }))
    const errors: unknown[] = []
    ctx.on('agent/error', ({ error }) => { errors.push(error) })

    const agent = await runTurn(ctx, 'history-assembly-refuse', 'go')

    expect(adapter.requests).toHaveLength(0)
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toContain('agent/history-assembling must call next() and return the frozen request')
    expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')).toMatchObject({
      data: { reason: { kind: 'error' } },
    })
  })

  it('refuses a listener that returns without continuing the chain', async () => {
    const adapter = new MockAdapter([textResponse('unused')])
    const ctx = await harness(adapter)
    // @ts-expect-error -- a listener that returns without next() must be refused at runtime.
    ctx.on('agent/history-assembling', () => undefined)
    const errors: unknown[] = []
    ctx.on('agent/error', ({ error }) => { errors.push(error) })

    const agent = await runTurn(ctx, 'history-assembly-veto', 'go')

    expect(adapter.requests).toHaveLength(0)
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toContain('agent/history-assembling must call next() and return the frozen request')
    expect(agent.session.requestHeader()).toBeUndefined()
  })

  it('sends no request when cancellation lands after the continuation returned', async () => {
    const adapter = new MockAdapter([textResponse('unused')])
    const ctx = await harness(adapter)
    const frozen = Promise.withResolvers<GenerateOptions>()
    const release = Promise.withResolvers<undefined>()
    let dispatches = 0
    ctx.on('llm/stream', (_request, next) => { dispatches += 1; return next() })
    ctx.on('agent/history-assembling', async (_payload, next) => {
      const request = await next()
      frozen.resolve(request)
      // Cleanup that outlives the snapshot: the request is already frozen and
      // logged, and cancellation here must still stop the dispatch.
      await release.promise
      return request
    })

    const agent = await ctx.agentLoop.create(SessionId('history-assembly-late-cancel'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await frozen.promise
    agent.cancel({ kind: 'user' })
    release.resolve(undefined)
    await agent.whenIdle()

    // The turn never reached the provider: not even the dispatch entry point ran.
    expect(dispatches).toBe(0)
    expect(adapter.requests).toHaveLength(0)
    expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')).toMatchObject({
      data: { reason: { kind: 'aborted', reason: { kind: 'user' } } },
    })
  })

  it('sends no request when cancellation lands while the seam waits', async () => {
    const adapter = new MockAdapter([textResponse('unused')])
    const ctx = await harness(adapter)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    ctx.on('agent/history-assembling', async (_payload, next) => {
      entered.resolve(undefined)
      await release.promise
      return next()
    })

    const agent = await ctx.agentLoop.create(SessionId('history-assembly-cancel'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await entered.promise
    agent.cancel({ kind: 'user' })
    release.resolve(undefined)
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(0)
    expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')).toMatchObject({
      data: { reason: { kind: 'aborted', reason: { kind: 'user' } } },
    })
    expect(agent.session.requestHeader()).toBeUndefined()
  })

  it('leaves the request unchanged when no listener participates', async () => {
    const adapter = new MockAdapter([textResponse('done')])
    const ctx = await harness(adapter)
    ctx.systemPrompt.context({ name: 'policy', order: 0, text: 'Mode: read-only.' })

    const agent = await runTurn(ctx, 'history-assembly-control', 'go')

    const request = adapter.requests[0]!
    const derived = agent.session.deriveMessages()
    expect(derived.map(kindOf)).toEqual(['system', 'user', 'runtime-context', 'assistant'])
    expect(request.messages.map(kindOf)).toEqual(['system', 'user', 'runtime-context'])
    for (const [index, message] of request.messages.entries()) expect(message).toBe(derived[index])
    expect(agent.session.snapshotEvents().some(event => event.type === 'surface/order')).toBe(false)
  })
})

function fail(message: string, code: string): () => never {
  return () => {
    throw new LlmError(message, code)
  }
}
