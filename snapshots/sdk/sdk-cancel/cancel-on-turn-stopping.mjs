/**
 * Cancel the root Session's first turn at its real turn-stopping boundary.
 *
 * Both SDK snapshot lanes load this fixture because the SDK protocol has no
 * cancellation RPC: the cancellation must reach the runtime through the same
 * Agent API a plugin uses.
 */

export const name = 'snapshot-cancel-on-turn-stopping'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - Scenario-owned runtime.
 */
export function apply(ctx) {
  let canceled = false
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    if (canceled || turn !== 1) return
    // Child agents settle their own turns; only the SDK-owned root is canceled.
    if (agent.session.header.parentSession !== undefined) return
    // The turn is canceled after its request was admitted and answered.
    if (agent.session.requestHeader() === undefined) return
    canceled = true
    agent.cancel({ kind: 'hook', reason: 'snapshot cancellation' })
  })
}
