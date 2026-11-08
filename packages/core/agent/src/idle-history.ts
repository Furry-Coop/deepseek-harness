/**
 * Contract for recording plugin-owned formal history from a truly idle agent:
 * the durable system head (when the surface has none) plus one user message,
 * committed outside any turn or step.
 *
 * @module @deepseek-ai/dsh-agent/idle-history
 */

import type { SessionSeq, UserMessage } from '@deepseek-ai/dsh-session'

/** One request to record formal history while the agent is idle. */
export interface IdleHistoryRequest {
  /**
   * The exact user message to append as formal history. The operation snapshots
   * it before its first await, so mutating this object afterwards cannot change
   * what is recorded. Its message id is the operation's stable request identity:
   * a retry that finds the same recorded message on the current surface appends
   * nothing, while the same id with any different content or source is refused
   * as a history conflict.
   */
  readonly message: UserMessage
}

/** Append positions established before the durability checkpoint ran. */
export interface IdleHistoryAppend {
  /**
   * Sequence of the protected system head this call established, or `null` when
   * the surface already had one or nothing was appended.
   */
  readonly systemHeadSeq: SessionSeq | null
  /** Sequence of the formal user message on the current surface. */
  readonly messageSeq: SessionSeq
  /** Whether this call appended the message; `false` when its exact identity was already recorded. */
  readonly appended: boolean
}

/** Settled result of one idle-history maintenance. */
export interface IdleHistoryResult extends IdleHistoryAppend {
  /**
   * Whether a durability listener participated in the checkpoint. `false` means
   * no persistence backend observed the append, not that the append failed.
   */
  readonly checkpointed: boolean
}

/**
 * What prevented one idle-history maintenance from completing:
 *
 * - `not-idle`: a turn or another maintenance task owns the agent. Public
 *   `status` stays `idle` during maintenance, so this reports the phase, not the
 *   status.
 * - `aborted`: `cancel()` aborted the maintenance signal before the formal
 *   message append committed. A system head this call already established stays
 *   committed as recovery state; a later identical attempt appends only the
 *   message after it.
 * - `agent-changed`: this agent is no longer the live agent/session for its id.
 *   A system head this call already established stays committed as recovery
 *   state; this instance appends no message.
 * - `history-conflict`: another writer took the surface head while the prompt was
 *   assembled, so establishing the head would reorder or shadow its messages.
 * - `checkpoint`: the appends committed and the durability checkpoint failed;
 *   {@link IdleHistoryError.append} carries their positions.
 */
export type IdleHistoryFailure = 'not-idle' | 'aborted' | 'agent-changed' | 'history-conflict' | 'checkpoint'

/** Typed failure of one idle-history maintenance. */
export class IdleHistoryError extends Error {
  /**
   * @param message - diagnostic naming the agent and the failed stage.
   * @param failure - which decision or boundary refused to continue.
   * @param append - committed append positions, present exactly for a failed checkpoint.
   * @param options - standard error options; `cause` keeps the checkpoint failure.
   */
  constructor(
    message: string,
    readonly failure: IdleHistoryFailure,
    readonly append?: IdleHistoryAppend,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'IdleHistoryError'
  }
}
