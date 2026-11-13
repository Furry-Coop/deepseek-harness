/**
 * Pure types of the title domain: the ONE home of the `title` projection-key
 * declaration, free of this package's host-side value imports (cordis
 * service, schemastery, the llm seam). Two namespace projections serve it —
 * `./types` for host consumers and `./client/types` for client aggregates —
 * with zero content duplication.
 *
 * @module @deepseek-ai/dsh-session-title/types
 */

export {}

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { AdmissionWindow } from '@deepseek-ai/dsh-agent/inbox-admission'
import type { InboxTarget } from '@deepseek-ai/dsh-agent/types'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { OptionalSessionSeq, SessionSeq } from '@deepseek-ai/dsh-session/types'

/** Identifies one session-title provider registration. */
export type SessionTitleProviderId = Branded<'SessionTitleProviderId'>

/** Exact auxiliary model route that produced a title. */
export interface SessionTitleModelIdentity {
  /** Registered LLM provider route. */
  readonly provider: string
  /** Provider model id. */
  readonly model: string
}

/** Durable ownership record for an accepted session title. */
export type SessionTitleSource =
  | { readonly kind: 'fallback' }
  | {
    readonly kind: 'provider'
    readonly provider: SessionTitleProviderId
    readonly model?: SessionTitleModelIdentity
  }
  | {
    /** Explicit user rename: pins the title — automatic generation stops scheduling. */
    readonly kind: 'user'
  }

/**
 * Non-user source for an origin-derived title.
 *
 * A manual rename must use `session/title` with the user source; the
 * from-input record can therefore never fabricate a user pin.
 */
export type SessionTitleGeneratedSource = Exclude<SessionTitleSource, { kind: 'user' }>

/**
 * One exact input reference frozen by the title service.
 *
 * A directly admitted human message cites only its `user/message` seq. A
 * rewrite of a claimed human Inbox occurrence cites the occurrence, the claim,
 * and the admitted message, because no human `user/message` exists for it.
 */
export type SessionTitleInputRef =
  | {
    /** An ordinary human `user/message` and its exact event seq. */
    readonly kind: 'message'
    readonly messageSeq: SessionSeq
  }
  | {
    /** A rewrite of a claimed human Inbox occurrence. */
    readonly kind: 'origin'
    /** Seq of the `agent/inbox/spliced` event that inserted the occurrence. */
    readonly originalInboxSeq: SessionSeq
    /** Message identity repeated by the admitted rewrite. */
    readonly messageId: MessageId
    /** Claim splice seq that removed the occurrence. */
    readonly claimSeq: SessionSeq
    /** Seq of the admitted `user/message` event. */
    readonly admittedSeq: SessionSeq
  }

/** Payload of the log-only `session/title` event. */
export interface SessionTitleEventData {
  /** Normalized non-empty title text. */
  readonly title: string
  /**
   * Exact human `user/message` seqs used to derive this title; empty only for
   * an explicit user rename. An origin-derived title never writes this field:
   * it uses `session/title-from-input` and `inputRefs` instead.
   */
  readonly messageSeqs: SessionSeq[]
  /** Whether the built-in fallback, a registered provider, or the user supplied the title. */
  readonly source: SessionTitleSource
}

/**
 * Payload of the log-only `session/title-from-input` event.
 *
 * Used when at least one selected input is a rewrite of a claimed human Inbox
 * occurrence, so no human `user/message` seq can carry its attribution.
 */
export interface SessionTitleFromInputEventData {
  /** Normalized non-empty title text. */
  readonly title: string
  /** Exact admitted input references, in admission order. */
  readonly inputRefs: SessionTitleInputRef[]
  /** Whether the built-in fallback or a registered provider supplied the title. */
  readonly source: SessionTitleGeneratedSource
}

/** Latest folded title plus the title event's durable envelope facts. */
export interface SessionTitleSnapshot extends SessionTitleEventData {
  /** Seq of the latest title event. */
  readonly eventSeq: SessionSeq
  /** Timestamp of the latest title event. */
  readonly updatedAt: number
  /**
   * Exact input references when the latest title came from
   * `session/title-from-input`; `messageSeqs` is empty for that title.
   */
  readonly inputRefs?: readonly SessionTitleInputRef[]
}

/** Host title projection value. */
export type TitleProjection = SessionTitleSnapshot

/** One eligible title input exposed to title providers. */
export interface SessionTitleUserMessage {
  /** Seq of the `user/message` event that admitted this input. */
  readonly seq: SessionSeq
  /** Exact concatenated text-block content. */
  readonly text: string
}

/** Eligible title input with the exact reference the service freezes into the title event. */
export interface SessionTitleInputEntry extends SessionTitleUserMessage {
  /** Whether an ordinary human message or a claimed occurrence supplied this input. */
  readonly ref: SessionTitleInputRef
}

/** One tracked human occurrence still pending in an Inbox lane. */
export interface TitlePendingOccurrence {
  /** Message identity the admitted rewrite must repeat. */
  readonly messageId: MessageId
  /** Seq of the `agent/inbox/spliced` event that inserted the occurrence. */
  readonly originalInboxSeq: SessionSeq
  /** Exact concatenated text-block content of the occurrence. */
  readonly text: string
  /** Request correlation carried by the occurrence, or null when it had none. */
  readonly correlation: string | null
  /** Lane that currently holds the occurrence. */
  readonly target: InboxTarget
  /** Current index inside that lane. */
  readonly index: number
}

/** One claimed human occurrence awaiting its entered-step admission. */
export interface TitleClaimedOccurrence {
  /** Message identity the admitted rewrite must repeat. */
  readonly messageId: MessageId
  /** Seq of the `agent/inbox/spliced` event that inserted the occurrence. */
  readonly originalInboxSeq: SessionSeq
  /** Exact concatenated text-block content of the occurrence. */
  readonly text: string
  /** Request correlation carried by the occurrence, or null when it had none. */
  readonly correlation: string | null
  /** Claim and entered-step evidence for the occurrence. */
  readonly window: AdmissionWindow
}

/** Eligible title input stored as a bounded aggregate with its lane fold. */
export interface TitleInputState {
  /** The oldest eligible input, or null before any. */
  readonly first: SessionTitleInputEntry | null
  /** Total eligible inputs folded so far. */
  readonly count: number
  /** Seq of the newest eligible `user/message` event, or null before any. */
  readonly lastSeq: OptionalSessionSeq
  /** Human occurrences still pending in the two Inbox lanes. */
  readonly pending: readonly TitlePendingOccurrence[]
  /** Claimed occurrences that a step may still admit. */
  readonly claimed: readonly TitleClaimedOccurrence[]
  /** Turn currently open, or 0 between Turns. */
  readonly openTurn: number
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * The session's current normalized title — the latest title event's text
     * (last-wins), or `null` before the first title lands. A plain string: the
     * shape the client list rows consume.
     */
    title: string | null
  }
}
