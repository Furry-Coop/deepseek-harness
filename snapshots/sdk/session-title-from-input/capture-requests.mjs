/**
 * Capture the scenario's assembled model inputs before adapter execution.
 *
 * The snapshot asserts that the main turn saw only the effective pre-step text
 * while the title request saw only the original caller text.
 */
import { appendFileSync } from 'node:fs'

/**
 * @param ctx - Scenario context providing the LLM event stream.
 * @param config - Output path under the scenario's private DSH home.
 */
export function apply(ctx, config) {
  ctx.on('llm/stream', async function* (options, next) {
    appendFileSync(config.path, JSON.stringify({
      provider: options.provider,
      model: options.model,
      purpose: options.purpose,
      maxTokens: options.maxTokens,
      reasoningEffort: options.reasoningEffort,
      messages: options.messages,
      tools: options.tools,
    }) + '\n')
    yield* next()
  })
}
