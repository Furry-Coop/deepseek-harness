/**
 * Pure admission policy for a host-side rewrite of a human Inbox occurrence.
 *
 * The Host may claim a pending human occurrence during pre-step, replace its
 * source kind, and admit the rewritten message under the same id after the
 * step starts. The durable proof that the rewrite belongs to that human input
 * is this chain — the non-canceled claim, a step that enters in the same Turn,
 * and the same-id admitted message after that step boundary. An admitted
 * message that merely reuses a request id is not evidence.
 *
 * This module is the single implementation home of that policy for the Client
 * echo settlement, prompt idempotency, title input, and cold-read validation.
 * It is browser-safe and depends only on Session/LLM types. It reads the
 * committed splice through a structural view of the fields it consumes, so it
 * does not depend on the Inbox writer or any Workspace module. Each consumer
 * keeps its own retention, receipts, watermarks, and domain aggregates;
 * `@deepseek-ai/dsh-agent/inbox-admission` is a re-export of this module.
 *
 * @module @deepseek-ai/dsh-session/inbox-admission
 */

import type { SessionEvent, SessionSeq } from './types.ts'

/**
 * The committed splice fields this policy reads.
 *
 * The Inbox writer owns the durable payload and its schema; this view names
 * only the coordinates and inserted messages an admission decision consumes.
 */
export interface InboxSpliceView {
  /** First index in the lane whose occurrences the splice replaces. */
  readonly start: number
  /** Number of lane occurrences removed at `start`; absent means zero. */
  readonly removedCount?: number
  /** Occurrences inserted at `start`, in lane order. */
  readonly inserted: readonly InboxMessage[]
  /** Present only when the splice is a cancellation. */
  readonly outcome?: 'canceled'
}

/** The message fields an admission decision reads. */
export interface InboxMessage {
  /** Message identity repeated by a rewrite admission. */
  readonly id: string
  /** Producer source; a human occurrence carries kind `user`. */
  readonly source: {
    readonly kind: string
    /** Request correlation, when the producer carried one. */
    readonly rpcId?: unknown
  }
}

/** How one committed Inbox splice relates to a claim. */
export type InboxSpliceKind =
  /** A cancellation records `outcome: 'canceled'` and owns the removal. */
  | 'cancellation'
  /** A non-canceled removal with no insertion is the Host claiming its batch. */
  | 'claim'
  /** Any other splice inserts or replaces pending occurrences. */
  | 'mutation'

/**
 * Classify one committed Inbox splice.
 * @param splice - the fields of one `agent/inbox/spliced` event this policy reads.
 * @returns whether the splice claims input, cancels it, or only mutates a lane.
 */
export function inboxSpliceKind(splice: InboxSpliceView): InboxSpliceKind {
  if (splice.outcome === 'canceled') return 'cancellation'
  return (splice.removedCount ?? 0) > 0 && splice.inserted.length === 0 ? 'claim' : 'mutation'
}

/**
 * Whether a pending message is a real human Inbox occurrence.
 *
 * A rewrite keeps the message identity but replaces this source, so the
 * original occurrence is the only durable proof of human authorship.
 * @param message - pending or admitted user message.
 * @returns whether the message carries the human source kind.
 */
export function isHumanInboxOccurrence(message: InboxMessage): boolean {
  return message.source.kind === 'user'
}

/**
 * Read the occurrences one splice removes from a lane.
 * @param lane - current pending messages of the splice's target lane.
 * @param splice - the fields of one `agent/inbox/spliced` event this policy reads.
 * @returns the removed occurrences in lane order, or `undefined` for invalid persisted bounds.
 */
export function inboxSpliceRemoved<T extends InboxMessage>(
  lane: readonly T[],
  splice: InboxSpliceView,
): readonly T[] | undefined {
  const removedCount = splice.removedCount ?? 0
  if (!Number.isSafeInteger(splice.start) || splice.start < 0 || splice.start > lane.length
    || !Number.isSafeInteger(removedCount) || removedCount < 0
    || splice.start + removedCount > lane.length) return undefined
  return lane.slice(splice.start, splice.start + removedCount)
}

/** Evidence that one human occurrence was claimed and still awaits its entered step. */
export interface AdmissionWindow {
  /** Claim splice seq, or null when no live claim remains. */
  readonly claimSeq: SessionSeq | null
  /** Turn that was open when the claim committed. */
  readonly claimTurn: number | null
  /** First `step/start` after the claim in the same Turn, or null before one enters. */
  readonly stepStartSeq: SessionSeq | null
}

/** No live claim; also the value that closes an unadmitted window. */
export const NO_ADMISSION_WINDOW: AdmissionWindow = Object.freeze({
  claimSeq: null,
  claimTurn: null,
  stepStartSeq: null,
})

/**
 * Open a claim window for one occurrence removed by a non-canceled splice.
 * @param turn - Turn number currently open, or 0 outside a Turn.
 * @param claimSeq - seq of the claim splice.
 * @returns the open window, or {@link NO_ADMISSION_WINDOW} outside a Turn.
 */
export function claimAdmissionWindow(turn: number, claimSeq: SessionSeq): AdmissionWindow {
  return turn > 0 ? { claimSeq, claimTurn: turn, stepStartSeq: null } : NO_ADMISSION_WINDOW
}

/**
 * Advance a claim window over one durable boundary event.
 *
 * The step that can admit the rewrite is the first `step/start` after the
 * claim in the claim's Turn. `step/end` spends an unadmitted window so a later
 * step cannot reuse it, and `turn/end` closes every window in the Turn.
 * @param window - current window for one occurrence.
 * @param event - next committed session event.
 * @returns the advanced window; the same reference when the event is unrelated.
 */
export function advanceAdmissionWindow(window: AdmissionWindow, event: SessionEvent): AdmissionWindow {
  if (window.claimSeq === null) return window
  switch (event.type) {
    case 'step/start':
      if (window.stepStartSeq !== null
        || event.data.turn !== window.claimTurn
        || event.seq <= window.claimSeq) return window
      return { ...window, stepStartSeq: event.seq }
    case 'step/end':
    case 'turn/end':
      return NO_ADMISSION_WINDOW
    default:
      return window
  }
}

/**
 * Read the narrow request correlation a message source carries.
 *
 * The Client, prompt command, and title service each own their branded request
 * id; this pure policy compares the underlying string so it never depends on
 * one of those domains. `undefined` means the source carries no correlation.
 * @param message - pending or admitted user message.
 * @returns the non-empty correlation string, or `undefined` when absent.
 */
export function inboxCorrelationOf(
  message: Pick<InboxMessage, 'source'>,
): string | undefined {
  if (!('rpcId' in message.source)) return undefined
  const rpcId: unknown = message.source.rpcId
  return typeof rpcId === 'string' && rpcId !== '' ? rpcId : undefined
}

/** Identity one claimed occurrence requires of its admitted rewrite. */
export interface AdmissionIdentity {
  /** Message identity repeated by the admitted rewrite. */
  readonly messageId: string
  /** Request correlation carried by the original occurrence, or null when it had none. */
  readonly correlation: string | null
}

/**
 * Whether one admitted message is the rewrite of a claimed occurrence.
 *
 * The admitted message must repeat the occurrence's identity, replace the human
 * source kind, enter after the claim's step, and carry the same correlation —
 * including both sides carrying none. A producer that repeats the message id
 * with a different or missing request correlation is refused.
 * @param window - claim window after advancing over the admitted message's event.
 * @param admitted - admitted `user/message` payload.
 * @param admittedSeq - seq of that admitted event.
 * @param identity - original occurrence identity and correlation.
 * @returns whether the non-human same-id admission enters the claim's window.
 */
export function admitsRewrite(
  window: AdmissionWindow,
  admitted: InboxMessage,
  admittedSeq: SessionSeq,
  identity: AdmissionIdentity,
): boolean {
  return window.stepStartSeq !== null
    && admitted.id === identity.messageId
    && admitted.source.kind !== 'user'
    && admittedSeq > window.stepStartSeq
    && inboxCorrelationOf(admitted) === (identity.correlation ?? undefined)
}
