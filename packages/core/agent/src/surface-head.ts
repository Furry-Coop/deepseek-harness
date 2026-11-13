/**
 * Contract for establishing or verifying the protected system head of a
 * plugin-owned formal history surface from a truly idle agent.
 *
 * A plugin that writes its own surface messages needs the head to exist first:
 * a `system/message` appended after another writer's message leaves a log the
 * next turn cannot reopen. A plugin that only learns about its first write at
 * `agent/pre-step` has no legal point before `step/start`, so it establishes
 * the head while idle and leaves later prompt updates to the existing route and
 * series policy of prompt admission.
 *
 * @module @deepseek-ai/dsh-agent/surface-head
 */

import type { SessionSeq } from '@deepseek-ai/dsh-session'

/** Committed position of the protected system head one operation verified or established. */
export interface SurfaceHeadPosition {
  /** Sequence of the protected system head on the committed surface. */
  readonly headSeq: SessionSeq
  /** Whether this call appended the head; `false` when the surface already carried one. */
  readonly appended: boolean
}

/** Settled result of one surface-head maintenance. */
export interface SurfaceHeadResult extends SurfaceHeadPosition {
  /**
   * Whether a durability listener participated in the checkpoint. `false` means
   * no persistence backend observed the head, not that the head is absent.
   */
  readonly checkpointed: boolean
}

/**
 * What prevented one surface-head maintenance from completing:
 *
 * - `not-idle`: a turn or another maintenance task owns the agent. Public
 *   `status` stays `idle` during maintenance, so this reports the phase.
 * - `aborted`: `cancel()` aborted the maintenance signal. A head this call
 *   already committed stays as legal recovery state and is reported in
 *   {@link SurfaceHeadError.head}.
 * - `agent-changed`: this agent is no longer the live agent/session for its id.
 *   A committed head is likewise reported and stays on the surface.
 * - `history-conflict`: the surface holds at least one node and does not start
 *   with a protected system head, so no head can be established without
 *   reordering another writer's messages.
 * - `checkpoint`: the head is on the surface and the durability checkpoint
 *   failed; {@link SurfaceHeadError.head} carries its position, so a later call
 *   verifies durability instead of appending a second head.
 */
export type SurfaceHeadFailure = 'not-idle' | 'aborted' | 'agent-changed' | 'history-conflict' | 'checkpoint'

/** Typed failure of one surface-head maintenance. */
export class SurfaceHeadError extends Error {
  /**
   * @param message - diagnostic naming the agent and the failed stage.
   * @param failure - which decision or boundary refused to continue.
   * @param head - committed head position, present exactly when a head is on the
   * surface after this call: a settled no-op, an append followed by cancellation,
   * a replaced owner, or a failed checkpoint.
   * @param options - standard error options; `cause` keeps the cancellation or checkpoint failure.
   */
  constructor(
    message: string,
    readonly failure: SurfaceHeadFailure,
    readonly head?: SurfaceHeadPosition,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'SurfaceHeadError'
  }
}
