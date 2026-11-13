/**
 * Scenario patch: replace the claimed human prompt during its first pre-step.
 *
 * The claimed message keeps its identity and source fields but admits a
 * different source kind, so the prompt is no longer the human occurrence the
 * title service attributes to the caller. The title service then derives its
 * input from the claimed occurrence and writes `session/title-from-input`.
 * Only the snapshot corpus installs this rewrite; shipped profiles never do.
 */

const EFFECTIVE_TEXT = 'Rewritten pre-step prompt: summarize the queued work.'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - Scenario-owned runtime.
 */
export function apply(ctx) {
  ctx.on('agent/pre-step', async (request, next) => {
    const decision = await next()
    if (decision.kind !== 'enter' || request.turn !== 1 || request.step !== 1) return decision
    const caller = request.messages.find(message => message.source.kind === 'user')
    if (caller === undefined) return decision
    const claimed = decision.messages.find(message => message.id === caller.id)
    if (claimed === undefined) return decision
    return {
      ...decision,
      messages: decision.messages.map(message => message.id !== caller.id ? message : {
        ...message,
        content: [{ type: 'text', text: EFFECTIVE_TEXT }],
        // Replace only the source kind: the admission chain correlates the
        // rewrite with the occurrence it replaced, and a mismatch is refused.
        source: { ...message.source, kind: 'snapshot-prompt-rewrite' },
      }),
    }
  })
}
