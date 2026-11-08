/**
 * Durable agent session-event vocabulary shared with type-only consumers.
 *
 * @module @deepseek-ai/dsh-agent/types
 */

import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'
import type { UserMessage } from '@deepseek-ai/dsh-llm/types'
// Type-only: the Workspace registry's archive-admission family map this registry merges `turn` into.
import type {} from '@deepseek-ai/dsh-workspace/types'
import type { OptionalSessionSeq, SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { TypertContext, TypertLookup } from '@deepseek-ai/dsh-typert-protocol'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Public live-agent handle; the runtime face augments its live capabilities. */
export interface Agent {
  /** Session-backed Agent identity. */
  readonly id: SessionId
}

declare module '@deepseek-ai/dsh-workspace/types' {
  interface SessionActivityKindMap {
    /** The session's own Agent is inside a turn, including one waiting for an approval or an answer. */
    turn: true
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertLookupMap {
    agent: TypertLookup<Agent, SessionId>
  }

  interface TypertContextMap {
    /** Agent Context identity shared by Host and Client adapters. */
    agent: TypertContext<SessionId>
  }
}

/** One of the two ordered pending-message lists owned by an agent. */
export type InboxTarget = 'next-turn' | 'next-step'

/** Complete pending Inbox value reconstructed from durable splices. */
export interface InboxState {
  readonly 'next-turn': readonly UserMessage[]
  readonly 'next-step': readonly UserMessage[]
}

/**
 * Wire-JSON pending Inbox value. Each message round-trips the session log
 * losslessly, but the fold state's full `UserMessage` type cannot cross a
 * typert Remote boundary (its source union carries an `unknown` replay
 * field), so the typed projection table keeps this JSON-safe form.
 */
export interface InboxWireState {
  readonly 'next-turn': readonly JsonValue[]
  readonly 'next-step': readonly JsonValue[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Pending agent input reconstructed from durable inbox splices. */
    inbox: InboxWireState
  }
}

/** Turn and step positions recorded in a Session. */
export interface TurnBoundaryProjection {
  /** Seq of the open turn's `turn/start`, or null between turns. */
  readonly openTurnStartSeq: OptionalSessionSeq
  /** Seq of the latest `step/start` event, or null before the first step. */
  readonly lastStepStartSeq: OptionalSessionSeq
  /** The latest step boundary (`step/start` or `step/end`) and its seq, or null before the first step boundary. */
  readonly lastStepBoundary: { readonly kind: 'start' | 'end'; readonly seq: SessionSeq } | null
  /** Turn number of the latest `turn/start`; 0 before the first turn. */
  readonly lastTurn: number
}

/** Complete provider, model, and optional reasoning effort chosen for one Session's model steps. */
export interface ModelSelection {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Adapter-owned reasoning effort, or provider/default behavior when absent. */
  reasoningEffort?: ReasoningEffortId
}

/** Client view of the durable model-selection fold. */
export interface ModelSelectionProjection {
  /** Selection used by the latest recorded model request. */
  readonly lastUsed: ModelSelection | null
  /** Selection the next model step uses; null while the Agent's initial options supply the route. */
  readonly next: ModelSelection | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Recorded model selection for the next model step and the latest request. */
    modelSelection: ModelSelectionProjection
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One normalized mutation of an agent's durable pending-message lists.
     * The session-projection registry applies the committed event before
     * `Session.append()` returns; Inbox live notifications follow that commit.
     */
    'agent/inbox/spliced': {
      target: InboxTarget
      start: number
      removedCount?: number
      inserted: UserMessage[]
      outcome?: 'canceled'
      /**
       * The stable caller intent behind a cancellation, recorded even when the
       * cancellation removed no pending input (an intent-only splice with no
       * `removedCount`). {@link Agent.cancel} records `disposed` for ordinary
       * agent teardown and `user` for every other cause; this writer omits it
       * on a mutation that is not a lifecycle cancellation. Consumers use it to
       * tell a normal disposal's discard apart from work the user cancelled,
       * including a cancel issued after the queue was already empty. A record
       * written before this member existed also omits it, so its absence is
       * unknown history rather than proof that no cancellation occurred.
       */
      cause?: 'user' | 'disposed'
      /**
       * Session log length captured at cancellation entry, before the
       * cancellation ran any abort listener or clear notification. A pending
       * occurrence inserted at or after this seq is later input that the
       * cancellation did not target, even when the cancellation's own splice is
       * logged after it. Consumers take this cut instead of the splice's seq;
       * an older cancellation therefore cannot claim a later turn's claim or
       * first build. This writer omits it on a mutation that is not a lifecycle
       * cancellation, and a record written before it existed carries none at
       * all: without `entrySeq` the exact entry cut cannot be rebuilt, so
       * consumers must not substitute the intent's own seq or read the absence
       * as a non-cancellation.
       */
      entrySeq?: import('@deepseek-ai/dsh-session/types').SessionLogOffset
    }
    /**
     * Complete model selection that applies from the next model step until a
     * later selection. Log-only: it never enters derived model history.
     */
    'model/selection': ModelSelection
  }
}
