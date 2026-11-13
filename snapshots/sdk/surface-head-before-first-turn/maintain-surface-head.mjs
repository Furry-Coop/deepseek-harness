/**
 * Establish the protected surface head before the first user turn.
 *
 * The creation listener is awaited inside the agent's creation maintenance, so
 * the head work is scheduled after that maintenance settles instead of
 * re-entering it. `whenIdle()` is the public awaitable entry: the Agent is
 * truly idle there and the caller has not sent its first prompt yet.
 *
 * The optional `llm/stream` hook is the TypeScript snapshot's deterministic
 * model boundary. It captures the assembled request and returns fixed text, so
 * the recording needs neither a key nor a provider. The Python SDK scenario
 * leaves `reply` unset and keeps its existing model endpoint.
 */
import { appendFileSync, writeFileSync } from 'node:fs'
import { setImmediate } from 'node:timers/promises'

export const name = 'surface-head-fixture'
export const inject = ['agents']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - Scenario-owned runtime.
 * @param {{
 *   resultPath: string,
 *   capturePath?: string,
 *   provider?: string,
 *   reply?: string,
 * }} config - Evidence paths and the optional deterministic model boundary.
 */
export function apply(ctx, config) {
  ctx.on('agent/created', ({ agent }) => {
    if (agent.session.header.origin === 'subagent') return
    // This listener runs inside the creation maintenance and is awaited by
    // creation. Return immediately and claim the idle phase only after that
    // maintenance settles, so neither call is a re-entry into creation.
    void setImmediate()
      .then(() => agent.whenIdle())
      .then(async () => {
        const statusBefore = agent.status
        const first = await agent.maintainSurfaceHead()
        const second = await agent.maintainSurfaceHead()
        writeFileSync(config.resultPath, JSON.stringify({
          statusBefore,
          statusAfter: agent.status,
          first,
          second,
        }) + '\n')
      })
      .catch((error) => {
        // The driver reads this marker; a refused or missing capability must
        // fail the scenario with the typed failure instead of a silent timeout.
        writeFileSync(config.resultPath, JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          ...typeof error?.failure === 'string' ? { failure: error.failure } : {},
        }) + '\n')
      })
  })

  if (config.reply === undefined) return
  ctx.on('llm/stream', async function* (request, next) {
    if (request.provider !== config.provider) {
      yield* next()
      return
    }
    if (config.capturePath !== undefined) {
      appendFileSync(config.capturePath, JSON.stringify({
        provider: request.provider,
        model: request.model,
        purpose: request.purpose,
        maxTokens: request.maxTokens,
        reasoningEffort: request.reasoningEffort,
        messages: request.messages,
        tools: request.tools,
      }) + '\n')
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: config.reply }
    request.signal.throwIfAborted()
  })
}
