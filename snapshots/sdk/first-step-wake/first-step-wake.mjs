/**
 * The step-less first batch, its late wake, and a deterministic model boundary.
 *
 * The caller's opening prompt claims the only message this fixture's first turn
 * will see. That turn's first `agent/pre-step` is held until a second delivery
 * reaches the inbox, and it then enters no step, so the turn closes empty and
 * the pending wake converges into the turn it still requires. The one request
 * that turn issues is answered here with fixed text instead of calling a
 * provider.
 */
export const inject = ['llm', 'agents']

const REPLY = 'STEP_WAKE_LATE_OK'

/**
 * Resolve once a delivery other than the claim waits in either inbox lane. The
 * caller sends its opening prompt before this pre-step runs, so any waiting
 * message here is the late wake.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Scenario-owned runtime.
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent - the claimed turn's agent.
 * @returns {Promise<void>} resolves after the wake's durable splice.
 */
function whenWakeArrives(ctx, agent) {
  if (agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0) return Promise.resolve()
  return new Promise((resolve) => {
    const dispose = ctx.on('session/event', (session, event) => {
      if (session !== agent.session) return
      if (event.type !== 'agent/inbox/spliced') return
      if (event.data.inserted.length === 0) return
      dispose()
      resolve()
    })
  })
}

/** @param {import('@deepseek-ai/cordis').Context} ctx - Scenario-owned runtime. */
export function apply(ctx) {
  ctx.on('llm/stream', async function* (request, next) {
    if (request.provider !== 'deepseek-account') { yield* next(); return }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: REPLY }
    request.signal.throwIfAborted()
  })

  ctx.on('agent/pre-step', async ({ agent, turn, step }, next) => {
    if (turn !== 1 || step !== 1) return await next()
    await whenWakeArrives(ctx, agent)
    // The claim is already taken, so this turn has no boundary left for the
    // wake; entering nothing closes it without a step and leaves the arrival to
    // the closing's convergence.
    return { kind: 'enter', messages: [] }
  })
}
