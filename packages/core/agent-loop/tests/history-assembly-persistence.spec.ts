/**
 * An ordering the assembly seam commits survives the real JSONL writer: the
 * frozen request of the first turn, the persisted log, and a cold reopen's
 * derived history agree on message order, and the seam can re-order again on a
 * later turn of the reopened agent.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const SESSION_ID = SessionId('history-assembly-persistence')
const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** One message's text blocks, as both recorded messages and requests expose them. */
interface TextCarrier {
  readonly role: string
  readonly id?: MessageId
  readonly source?: { readonly kind: string }
  readonly content: readonly { readonly type: string; readonly text?: string }[]
}

/** Message kinds in wire order. */
function kinds(messages: readonly TextCarrier[]): (string | undefined)[] {
  return messages.map(message => message.role === 'user' ? message.source?.kind : message.role)
}

/** Every text block of the human prompts, in wire order (injected context excluded). */
function userTexts(messages: readonly TextCarrier[]): string[] {
  return messages.flatMap(message => message.role === 'user' && message.source?.kind === 'user'
    ? message.content.flatMap(block => block.type === 'text' && block.text !== undefined ? [block.text] : [])
    : [])
}

/** Message identities in wire order; a missing id fails the comparison. */
function ids(messages: readonly TextCarrier[]): (MessageId | undefined)[] {
  return messages.map(message => message.id)
}

/** Mount the production persistence backend under one storage root. */
async function mountHost(root?: string): Promise<{ ctx: Context; adapter: MockAdapter; root: string }> {
  const storage = root ?? await mkdtemp(join(tmpdir(), 'dsh-history-assembly-'))
  if (root === undefined) roots.push(storage)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: 'persisted persona' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: storage })
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter([textResponse('first answer'), textResponse('second answer')])
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, adapter, root: storage }
}

/** Resolve when the driver next reaches idle. */
function settled(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', (payload) => {
      if (payload.agent !== agent || payload.status !== 'idle') return
      dispose()
      resolve()
    })
  })
}

/**
 * Register the seam listener this scenario uses: the newest admitted material
 * moves directly behind the protected head.
 */
function orderNewestAfterHead(ctx: Context, sizes: number[]): void {
  ctx.on('agent/history-assembling', async ({ agent }, next) => {
    const nodes = [...agent.session.surface.nodes]
    sizes.push(nodes.length)
    agent.session.append('surface/order', {
      nodes: [nodes[0]!, nodes[nodes.length - 1]!, ...nodes.slice(1, -1)],
    })
    return next()
  })
}

describe('history assembly persistence', () => {
  it('keeps a seam ordering through the JSONL writer and re-orders after a cold reopen', async () => {
    const host = await mountHost()
    host.ctx.systemPrompt.context({ name: 'policy', order: 0, text: 'Mode: read-only.' })
    const sizes: number[] = []
    orderNewestAfterHead(host.ctx, sizes)
    const handle = await host.ctx.agents.create({
      sessionId: SESSION_ID,
      agentOptions: { provider: 'mock', model: 'model' },
    })
    const agent = handle.agent
    const idle = settled(host.ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first input' }], source: { kind: 'user' } }))
    await idle

    // Surface [system, prompt, refreshed context] → the context moves behind the head.
    expect(sizes).toEqual([3])
    const recorded = host.adapter.requests[0]!
    expect(kinds(recorded.messages)).toEqual(['system', 'runtime-context', 'user'])
    expect(userTexts(recorded.messages)).toEqual(['first input'])
    const admittedIds = ids(recorded.messages)
    await host.ctx.sessions.flush(agent.session)
    // Close the writer before the reopen reads the stored generation.
    await handle.dispose()
    await host.ctx.fiber.dispose()

    // The cold host mounts the same runtime-context provider, so an unchanged
    // snapshot stays retained instead of being re-materialized or cleared.
    const cold = await mountHost(host.root)
    cold.ctx.systemPrompt.context({ name: 'policy', order: 0, text: 'Mode: read-only.' })
    const reopened = await cold.ctx.agents.resume({
      resumeSessionId: SESSION_ID,
      agentOptions: { provider: 'mock', model: 'model' },
    })
    const restored = reopened.agent.session
    expect(restored.snapshotEvents().filter(event => event.type === 'surface/order')).toHaveLength(1)
    const derived = restored.deriveMessages()
    expect(kinds(derived)).toEqual(['system', 'runtime-context', 'user', 'assistant'])
    // The persisted log alone reproduces the recorded order and identities.
    expect(ids(derived).slice(0, 3)).toEqual(admittedIds)

    // A later turn of the reopened agent re-applies an ordering of its own while
    // the recorded material keeps its recorded identities.
    const coldSizes: number[] = []
    orderNewestAfterHead(cold.ctx, coldSizes)
    const reopenedIdle = settled(cold.ctx, reopened.agent)
    reopened.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'second input' }], source: { kind: 'user' } }))
    await reopenedIdle

    // Recorded [system, ctx, prompt] plus assistant and the new prompt.
    expect(coldSizes).toEqual([5])
    const next = cold.adapter.requests.at(-1)!
    expect(kinds(next.messages)).toEqual(['system', 'user', 'runtime-context', 'user', 'assistant'])
    expect(userTexts(next.messages)).toEqual(['second input', 'first input'])
    expect(ids(next.messages).slice(2, 4)).toEqual(admittedIds.slice(1))
    expect(restored.snapshotEvents().filter(event => event.type === 'surface/order')).toHaveLength(2)
    await reopened.dispose()
  })
})
