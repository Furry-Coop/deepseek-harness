/**
 * Controlled scenario plugin for the recorded history-ordering case.
 *
 * It contributes one stable runtime-context snapshot and, at the final assembly
 * seam of each attempt, records a full permutation of the current surface nodes:
 * the newest admitted material moves directly behind the protected head. The
 * plugin therefore exercises the durable `surface/order` record through the real
 * profile instead of hand-authoring a Session log.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'

export const name = 'history-assembly-order'

export const inject = ['systemPrompt']

export function apply(ctx: Context): void {
  ctx.systemPrompt.context({ name: 'ordering-fixture', order: 0, text: 'Ordering fixture context.' })
  ctx.on('agent/history-assembling', async ({ agent }, next) => {
    const nodes = [...agent.session.surface.nodes]
    if (nodes.length > 2) {
      agent.session.append('surface/order', {
        nodes: [nodes[0]!, nodes[nodes.length - 1]!, ...nodes.slice(1, -1)],
      })
    }
    return next()
  })
}
