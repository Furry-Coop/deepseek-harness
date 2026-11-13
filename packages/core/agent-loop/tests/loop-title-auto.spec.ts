import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionTitleService, { foldSessionTitle } from '@deepseek-ai/dsh-session-title'
import * as FirstPromptProvider from '@deepseek-ai/dsh-session-title-first-prompt-llm'
import * as AllPromptsProvider from '@deepseek-ai/dsh-session-title-all-prompts-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse } from './mock-adapter.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Test-only Host rewrite of a claimed human prompt that keeps its request id. */
    'loop-title-handoff': { kind: 'loop-title-handoff'; rpcId: string }
  }
}

const TITLE_CONFIG = { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 } as const
const LLM_CONFIG = {
  targetWords: 5,
  targetCjkCharacters: 10,
  maxInputBytes: 1_000,
  maxOutputTokens: 32,
  timeoutMs: 1_000,
  provider: 'title-route',
  model: 'title-model',
} as const
const ORIGINAL = 'ORIGINAL human request'
const EFFECTIVE = 'EFFECTIVE prompt'

interface Harness {
  readonly ctx: Context
  readonly adapter: MockAdapter
  readonly agent: Agent
  readonly titleEvent: Promise<Extract<SessionEvent, { type: 'session/title-from-input' }>>
  readonly claimedId: () => string | undefined
}

/** Boot the real loop, the title service, and one shipped provider over one scripted adapter. */
async function harness(
  provider: typeof FirstPromptProvider | typeof AllPromptsProvider,
  titleText: string,
): Promise<Harness> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SessionTitleService, TITLE_CONFIG)
  const script = (options: GenerateOptions) =>
    options.purpose === 'session-title' ? textResponse(titleText) : textResponse('ok')
  const adapter = new MockAdapter([script, script])
  ctx.llm.registerAdapter(['main'], adapter)
  ctx.llm.registerAdapter(['title-route'], adapter)
  await ctx.plugin(provider, LLM_CONFIG)
  const agent = await ctx.agentLoop.create(SessionId(`loop-auto-title-${provider.name}`), {
    provider: 'main',
    model: 'main-model',
  })
  let claimedId: string | undefined
  ctx.on('agent/pre-step', async ({ messages }): Promise<PreStepDecision> => {
    const original = messages[0]!
    claimedId = original.id
    return {
      kind: 'enter',
      messages: [{
        ...original,
        content: [{ type: 'text', text: EFFECTIVE }],
        source: { kind: 'loop-title-handoff', rpcId: 'req-loop' },
      }],
    }
  })
  const titleEvent = new Promise<Extract<SessionEvent, { type: 'session/title-from-input' }>>((resolve) => {
    ctx.on('session/event', (session, event) => {
      if (session === agent.session
        && event.type === 'session/title-from-input'
        && event.data.source.kind === 'provider') resolve(event)
    })
  })
  return { ctx, adapter, agent, titleEvent, claimedId: () => claimedId }
}

/** Drive one prompt through the real loop and return the recorded events. */
async function drive(run: Harness, titleText: string): Promise<readonly SessionEvent[]> {
  run.agent.followup(createUserMessage({
    content: [{ type: 'text', text: ORIGINAL }],
    source: { kind: 'user', rpcId: 'req-loop' },
  }))
  await run.agent.whenIdle()
  const event = await run.titleEvent
  expect(event.data.title).toBe(titleText)
  return run.agent.session.snapshotEvents()
}

/** Assert the origin chain, model inputs, and cold-fold result of one automatic title. */
function expectAutomaticOriginTitle(run: Harness, log: readonly SessionEvent[], titleText: string): void {
  const messageId = run.claimedId()
  expect(messageId).toBeDefined()
  const inserted = log.find(event => event.type === 'agent/inbox/spliced'
    && event.data.inserted.some(message => message.id === messageId))
  const claim = log.find(event => event.type === 'agent/inbox/spliced'
    && event.data.inserted.length === 0
    && event.data.removedCount === 1
    && event.data.outcome === undefined)
  const admitted = log.find(event => event.type === 'user/message' && event.data.id === messageId)
  expect(inserted).toBeDefined()
  expect(claim).toBeDefined()
  expect(admitted).toBeDefined()
  const title = log.findLast(event => event.type === 'session/title-from-input')
  expect(title?.type === 'session/title-from-input' && title.data).toMatchObject({
    title: titleText,
    inputRefs: [{
      kind: 'origin',
      originalInboxSeq: inserted!.seq,
      messageId,
      claimSeq: claim!.seq,
      admittedSeq: admitted!.seq,
    }],
    source: { kind: 'provider' },
  })
  expect(foldSessionTitle(log)).toMatchObject({
    title: titleText,
    messageSeqs: [],
    inputRefs: [{ kind: 'origin', admittedSeq: admitted!.seq }],
  })

  const titleRequest = run.adapter.requests.find(request => request.purpose === 'session-title')
  expect(titleRequest).toBeDefined()
  const prompt = titleRequest!.messages[0]?.content[0]
  expect(prompt?.type === 'text' && prompt.text).toContain(ORIGINAL)
  expect(prompt?.type === 'text' && prompt.text).not.toContain(EFFECTIVE)
  const mainRequest = run.adapter.requests.find(request => request.purpose !== 'session-title')
  expect(JSON.stringify(mainRequest?.messages)).toContain(EFFECTIVE)
  expect(JSON.stringify(mainRequest?.messages)).not.toContain(ORIGINAL)

  const audit = log.find(event => event.type === 'session/title-llm-request-from-input')
  expect(audit?.type === 'session/title-llm-request-from-input' && audit.data.messages).toHaveLength(1)
  expect(audit?.type === 'session/title-llm-request-from-input'
    && audit.data.messages[0]?.content).toHaveLength(1)
  expect(log.some(event => event.type === 'session/title-llm-request')).toBe(false)

  const surface = JSON.stringify(run.agent.session.deriveMessages())
  expect(surface).not.toContain(ORIGINAL)
  expect(surface).toContain(EFFECTIVE)
}

describe('automatic title from a real loop pre-step rewrite', () => {
  it('first-prompt provider receives the claimed original and writes the new title', async () => {
    const run = await harness(FirstPromptProvider, 'First-message model title')
    const log = await drive(run, 'First-message model title')
    expectAutomaticOriginTitle(run, log, 'First-message model title')
  })

  it('all-prompts provider receives the same claimed original and writes the new title', async () => {
    const run = await harness(AllPromptsProvider, 'All messages model title')
    const log = await drive(run, 'All messages model title')
    expectAutomaticOriginTitle(run, log, 'All messages model title')
  })
})
