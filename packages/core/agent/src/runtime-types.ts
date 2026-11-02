/**
 * Public agent types and live-runtime events. Durable transcript facts and
 * turn/step boundaries remain `@deepseek-ai/dsh-session` events.
 *
 * @module @deepseek-ai/dsh-agent
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type {
  LlmAttemptId, LlmCallConfig, LlmFailure, MessageId, ReasoningEffortId, ResolvedRetryPolicy, StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AgentCancelCause, Session, SessionSeq, UserMessage } from '@deepseek-ai/dsh-session'
export type { AgentCancelCause } from '@deepseek-ai/dsh-session'
import type { Agent, InboxTarget } from './types.ts'
export type { Agent } from './types.ts'
import type { IdleHistoryRequest, IdleHistoryResult } from './idle-history.ts'
import type {} from '@deepseek-ai/dsh-system-prompt'
declare module '@deepseek-ai/dsh-system-prompt' {
  interface AssembleContext {
    /** Agent for this assembly; absent on diagnostics. When present, `scope` must identify the same agent. */
    agent?: Agent
  }
}

/** Merge-extensible agent creation options. Persona belongs to system-prompt sections. */
export interface AgentOptions {
  /** Provider route (must have a registered adapter at call time). */
  provider?: string
  /** Model id interpreted by the selected provider adapter. */
  model?: string
  /** Adapter-owned reasoning effort for the selected provider/model route. */
  reasoningEffort?: ReasoningEffortId
  /** Maximum output tokens for each conversation-model request. */
  maxTokens?: number
}

/** Options for {@link Agent.cancel}. */
export interface CancelOptions {
  /**
   * Preserve queued and steering inbox items instead of discarding them. The
   * active turn is still aborted, but un-started and pending work survives for a
   * later turn and no canceled inbox splice is logged.
   */
  keepInbox?: boolean | undefined
}

/** Agent-owned access to pending work; concrete storage belongs to the driver. */
export interface Inbox {
  /** Prompts awaiting individual turns. */
  readonly nextTurn: readonly UserMessage[]
  /** Input awaiting the next step boundary. */
  readonly nextStep: readonly UserMessage[]

  /**
   * Durably cancel pending input, clearing next-step before next-turn.
   *
   * The call captures both lists before it runs any callback, so input inserted
   * by a discard notification survives. A user cancellation with nothing
   * captured still leaves one durable intent fact so recovery can tell a user
   * cancellation from a crash that lost the queue.
   * @param cause - the stable caller intent recorded with the cancellation; a
   * plain clear is a user cancellation unless the disposing lifecycle says otherwise.
   */
  clear(cause?: 'user' | 'disposed'): void

  /**
   * Append one message to a pending list.
   * @param target - pending list to extend.
   * @param message - message to append.
   */
  append(target: InboxTarget, message: UserMessage): void

  /**
   * Prepend one message to a pending list.
   * @param target - pending list to extend.
   * @param message - message to prepend.
   */
  prepend(target: InboxTarget, message: UserMessage): void

  /**
   * Replace one pending message in place.
   * @param messageId - identity of the pending message to replace.
   * @param newMessage - replacement message.
   * @returns whether the message was still pending.
   */
  replace(messageId: MessageId, newMessage: UserMessage): boolean

  /**
   * Remove one pending message.
   * @param messageId - identity of the pending message to remove.
   * @returns whether the message was still pending.
   */
  remove(messageId: MessageId): boolean

  /**
   * Apply standard splice semantics and durably record the normalized result.
   * @param target - pending list to mutate.
   * @param start - splice position.
   * @param deleteCount - maximum number of messages to remove.
   * @param inserted - messages to insert at the resolved position.
   * @returns messages removed by the splice.
   */
  splice(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
  ): UserMessage[]
}

/**
 * An agent's lifecycle state, emitted on every transition as `agent/status`:
 * `idle` means no driver is active; `running` begins when waking input starts
 * cancellable pre-step processing and lasts while the driver drains,
 * closes, or checkpoints turns. Disposal removes the agent from its registry;
 * it is not a third observable status.
 */
export type AgentStatus = 'idle' | 'running'

/** Whether and with which messages the loop enters a proposed step. */
export type PreStepDecision =
  | {
    kind: 'reject'
    /**
     * Return the messages claimed for this step to the front of the pending-step
     * boundary in their original order instead of consuming them. A later turn
     * claim reads them before the turn prompt and before input staged during
     * pre-step. The turn still closes blocked and the driver does not
     * immediately re-run; the parked batch waits for the next waking input. A
     * cancellation that aborts the turn takes precedence and drops it instead.
     */
    preserveClaimed?: true
  }
  | {
    kind: 'enter'
    messages: UserMessage[]
    /** Start a distinct model-message series before this step's admitted messages. */
    startsRequestSeries?: true
  }

/** Action returned by a listener that owns model-request recovery. */
export type RequestErrorAction = { kind: 'retry' } | undefined

/** Why a session lifecycle began; seeded creates are `startup`, while persisted loads are `resume`. */
export type SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact'

/** One process-local live assistant streaming publication. */
export type AssistantStreamFrame =
  | {
    readonly type: 'start'
    readonly attemptId: LlmAttemptId
    /** Monotone within one attached Agent lifecycle; replacement restarts at 1. */
    readonly revision: number
    readonly turn: number
    readonly step: number
  }
  | {
    readonly type: 'chunk'
    readonly attemptId: LlmAttemptId
    readonly revision: number
    /** Dense zero-based position within the attempt. */
    readonly index: number
    /** Safe-integer timestamp reused by the durable embedded stream. */
    readonly time: number
    readonly chunk: StreamChunk
  }
  | {
    readonly type: 'end'
    readonly attemptId: LlmAttemptId
    readonly revision: number
    /** Number of chunk frames emitted by this attempt. */
    readonly index: number
    /** Durable settlement committed before this notification, or live abandonment without one. */
    readonly outcome:
      | {
        readonly kind: 'committed'
        readonly eventType: 'assistant/message' | 'assistant/attempt'
        readonly seq: SessionSeq
      }
      | { readonly kind: 'abandoned' }
  }

declare module './types.ts' {
  interface Agent {
    /** The provider route and model this agent's requests use. */
    readonly options: AgentOptions
    /** The live session this agent drives; its log is the durable source of truth. */
    readonly session: Session
    /** Agent-owned access to durable pending work. */
    readonly inbox: Inbox
    /** The current lifecycle state, mirrored on every `agent/status` transition. */
    readonly status: AgentStatus
    /** Agent-scoped context; its contributions are agent-local, unwind on disposal, and reject registration afterward. */
    readonly ctx: Context

    /**
     * Clear the queued and steering input present at entry — unless `keepInbox`
     * — and abort the activity active at entry. The first cause wins for that
     * activity. Input delivered by an abort listener or a clear notification
     * stays pending and wakes the next activity. With no active activity,
     * cancellation aborts nothing and does not arm later work.
     * @param cause - the stable caller intent carried by the active operation signal.
     * @param options - cancellation options; `keepInbox` preserves pending work.
     */
    cancel(cause: AgentCancelCause, options?: CancelOptions): void

    /**
   * Resolve after the current whole-agent activity reaches quiescence. This
   * follows replacement work started before the observed driver retires,
   * but does not identify the settlement of any particular message.
   * @returns fulfillment after no active driver or maintenance task remains.
   */
    whenIdle(): Promise<void>

    /**
   * Run one non-turn maintenance task from the true idle phase. The task starts
   * synchronously after claiming that phase; later waking input remains in the
   * inbox until the task settles, while public status stays `idle`.
   * `whenIdle()` follows both the task and any waking work released behind it.
   * @param task - operation whose fulfillment or rejection is preserved, with a signal aborted by {@link cancel}.
   * @throws synchronously when turn-driving or another maintenance task already owns the agent.
   * @returns the task promise.
   */
    runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>

    /**
   * Record plugin-owned formal history from the true idle phase without starting
   * a turn: one identified user message, preceded by a protected system head when
   * the surface carries none. Absent only on an Agent implementation that cannot
   * persist idle history, so a caller must treat absence as an unsupported
   * capability rather than a silent no-op.
   *
   * The message is snapshotted before the first await, so mutating the caller's
   * object afterwards cannot change what is recorded. The operation fails with an
   * `IdleHistoryError` before writing when a turn or another maintenance task owns
   * the agent, or when a non-empty surface does not start with a protected system
   * head: a head is established there only on an empty surface, and an existing
   * head — including an empty rendering — is never replaced or duplicated. With no
   * head it assembles and renders the real scoped prompt, so a maintenance head
   * carries the current prompt registry rather than a cached rendering.
   *
   * The message id is the stable request identity. A retry that finds the exact
   * same message already recorded appends nothing and reports its position; the
   * same id with different content, source, or attachments is a history conflict.
   * The message append and its durability checkpoint are separate outcomes: a
   * committed append is never rolled back, and a failed checkpoint reports the
   * committed position so a retry with the same identity cannot duplicate it.
   * This operation writes formal history only — it neither claims, splices, nor
   * injects inbox input, and it starts no request, turn, or step.
   * @param request - the exact user message to record as formal history.
   * @returns the established head and message positions plus the checkpoint outcome.
   * @throws an `IdleHistoryError` naming the refused phase, identity, surface, or checkpoint.
   */
    maintainIdleHistory?(request: IdleHistoryRequest): Promise<IdleHistoryResult>

    /**
   * Route identified input to an inbox boundary and optionally wake the driver.
   * Waking input submitted after active cancellation is queued for the next
   * turn and runs when the aborted activity converges to idle; a `disposed`
   * cancel leaves it parked. A wake submitted while already idle always opens
   * its turn boundary, even when its message is cleared before the driver
   * claims ([driver wake convergence](../../agent-loop/src/agent.ts)).
   * @param message - identified content and the source that supplied it.
   * @param target - the preferred next-turn or next-step inbox boundary.
   * @param wakeup - whether delivery may wake the driver.
   */
    send(message: UserMessage, target: InboxTarget, wakeup: boolean): void

    /**
   * Queue an ordinary follow-up turn and wake the driver. The item becomes the
   * sole ordinary message of its own turn.
   * @param message - identified prompt content and the source that supplied it.
   */
    followup(message: UserMessage): void

    /**
   * Submit steering for the nearest step. An idle driver starts a turn;
   * a running driver consumes it at its next step boundary.
   * A rejected step leaves steering parked in the inbox until the next
   * wake; cancellation or disposal may discard pending steering.
   * @param message - identified steering content and the source that supplied it.
   */
    steer(message: UserMessage): void

    /**
   * Queue model-facing context for the next pre-step without waking the
   * driver. A running driver claims it at the nearest later step boundary;
   * idle drivers leave it pending until follow-up or steering
   * wakes them. It may miss a request whose pre-step already claimed its
   * batch. Cancellation or disposal may discard pending context.
   * @param message - identified injected context and the source that supplied it.
   */
    inject(message: UserMessage): void

    /**
   * Queue a batch of model-facing context at the next-step boundary in one
   * inbox splice without waking the driver. One splice commits the whole batch,
   * so a synchronous insertion observer that cancels clears it instead of
   * leaving later one-by-one insertions behind. Same admission rules as
   * {@link Agent.inject}; a producer that omits it accepts only single messages.
   * @param messages - identified injected context in insertion order.
   */
    injectBatch?(messages: readonly UserMessage[]): void
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    // ---- lifecycle ----
    /**
     * An entered agent is ready for per-agent initialization after factory setup.
     * Listeners run in order and are awaited before creation resolves. AgentLoop
     * holds queued input until all listeners finish. A throw or rejection fails
     * creation and skips later listeners. Disposal retains the scope and session
     * until dispatch settles; listeners must not await agent.whenIdle() or their
     * own owner's disposal.
     * @param payload.agent - the newly registered agent with its live session and completed setup.
     * @param payload.source - fresh creation, resume, clear, or compaction source.
     * @param payload.signal - factory initialization cancellation signal, when provided.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode serial
     */
    'agent/created'(this: Scoped<Agent>, payload: { agent: Agent; source: SessionStartSource; signal?: AbortSignal }): undefined | Promise<undefined>
    /**
     * An agent left the registry; AgentLoop emits this after driver quiescence
     * and scoped-registration unwind, but before session detachment. Custom
     * registry users own their driver-ordering contract.
     * @param payload.agent - the exact agent removed from the registry.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/disposed'(this: Scoped<Agent>, payload: { agent: Agent }): void
    /**
     * Agent status changed (`idle` ⇄ `running`). A waking delivery enters
     * `running` synchronously after reserving cancellation; `idle` means no
     * driver remains scheduled or active.
     * @param payload.agent - the agent whose status flipped.
     * @param payload.status - the status just entered (the transition's destination).
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/status'(this: Scoped<Agent>, payload: { agent: Agent; status: AgentStatus }): void
    /**
     * One message entered the live inbox.
     * @param payload.agent - the agent whose inbox changed.
     * @param payload.message - the inserted message.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/inbox/inserted'(this: Scoped<Agent>, payload: { agent: Agent; message: UserMessage }): void
    /**
     * One message left the inbox inside its open turn. If the proposed step
     * is rejected without `preserveClaimed`, the claimed message ends here: it
     * is neither discarded nor re-emitted as a user/message, and the turn
     * closes without a step. A rejecting listener that sets `preserveClaimed`
     * returns the exact claimed batch to the front of the pending-step boundary
     * in original order; a cancelled turn still drops it.
     * @param payload.agent - the agent whose inbox changed.
     * @param payload.message - the claimed message.
     * @param payload.turn - the owning turn.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/inbox/claimed'(this: Scoped<Agent>, payload: { agent: Agent; message: UserMessage; turn: number }): void
    /**
     * One message was discarded from the live inbox.
     * @param payload.agent - the agent whose inbox changed.
     * @param payload.message - the discarded message.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/inbox/discarded'(this: Scoped<Agent>, payload: { agent: Agent; message: UserMessage }): void
    // ---- the machine's extension points ----
    /**
     * Reject a proposed step or replace the messages that enter it. Calling
     * `next()` preserves the current messages. A rejecting decision may set
     * `preserveClaimed` to park the exact claimed batch at the front of its
     * pending-step boundary for a later wake; the turn still closes blocked
     * without re-running the driver. A cancelled turn drops the batch, while
     * never-claimed pending input follows the cancellation's own keep-inbox
     * policy.
     * @param payload.agent - the agent proposing the step.
     * @param payload.messages - messages removed from the inbox for this step.
     * @param payload.turn - the turn that will own the step.
     * @param payload.step - the step proposed by the loop.
     * @param payload.signal - the current turn's cancellation signal.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode waterfall
     */
    'agent/pre-step'(this: Scoped<Agent>, payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>
    /**
     * Replace the frozen call configuration. `await next()` yields the config
     * the machine would use (agent options on the first request, the logged
     * header afterwards); return a replacement to switch. On step admission,
     * this runs after assembly and `step/start`, before the system prompt and
     * accepted user batch are committed. Cancellation here or during subsequent
     * `prepareCall()` resolution commits neither. The prepared call capability
     * governs prompt admission. Model-visible content must use logged channels;
     * this waterfall cannot mutate messages.
     * @param payload.agent - the agent making the model call.
     * @param payload.turn - the open turn number.
     * @param payload.step - the step whose request this is.
     * @param payload.signal - the current turn's explicit abort signal.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode waterfall
    */
    'agent/request'(this: Scoped<Agent>, payload: { agent: Agent; turn: number; step: number; signal: AbortSignal }, next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig>
    /**
     * Handle one failed model-request attempt before the loop retries or closes
     * its step. A listener returns `{ kind: 'retry' }` without calling `next()`
     * when it owns recovery, or calls `next()` to delegate. The default
     * `undefined` leaves the failure terminal.
     * @param payload.agent - the agent whose request failed.
     * @param payload.turn - the turn containing the failed request.
     * @param payload.step - the step containing the failed request attempt.
     * @param payload.provider - the provider selected for the failed request.
     * @param payload.failure - serializable facts normalized at the final adapter boundary.
     * @param payload.retryPolicy - the policy of the adapter registration that served the failed request.
     * @param payload.signal - the turn abort signal.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode waterfall
     */
    'agent/request-error'(this: Scoped<Agent>, payload: { agent: Agent; turn: number; step: number; provider: string; failure: LlmFailure; retryPolicy: ResolvedRetryPolicy | undefined; signal: AbortSignal }, next: () => Promise<RequestErrorAction>): Promise<RequestErrorAction>
    /**
     * Process-local assistant-stream publication. Chunk frames are transient;
     * the loop appends one final v2 `assistant/message` or `assistant/attempt`
     * with the same stream before a committed end frame.
     * @param payload.agent - the agent whose attempt produced the frame.
     * @param payload.frame - one ordered start, chunk, or end publication.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/assistant-stream'(this: Scoped<Agent>, payload: { agent: Agent; frame: AssistantStreamFrame }): void
    /**
     * The turn is about to close: the model owes no response (no live tool
     * calls, no fresh steering). Awaited before the boundary commits — a
     * listener that objects steers (`agent.steer(...)`) and the machine
     * re-reads its inbox: fresh steering runs another step, none closes the
     * turn. Data decides, so listener order cannot change the outcome. The
     * inverse control (stop a tool loop early) is data too: a tool result
     * carrying `concludesTurn` ends the turn at its step. The conclusion
     * never short-circuits already-submitted next-step work: same-step
     * `additionalContexts` or racing steering still runs, and the turn
     * closes only when that inbox drains.
     * @param payload.agent - the agent whose turn is at its stop boundary.
     * @param payload.turn - the turn about to close.
     * @param payload.signal - the current turn's explicit abort signal.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode serial
     */
    'agent/turn-stopping'(this: Scoped<Agent>, payload: { agent: Agent; turn: number; signal: AbortSignal }): Promise<void> | void
    // ---- error notifications (emit) ----
    /**
     * A step or turn errored. The machine reports a failure here even when
     * the error has no in-turn position for a durable record.
     * @param payload.agent - the agent whose turn errored.
     * @param payload.turn - the turn in which the failure surfaced.
     * @param payload.step - the step at which the failure surfaced.
     * @param payload.error - the failure, verbatim.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/error'(this: Scoped<Agent>, payload: { agent: Agent; turn: number; step: number; error: unknown }): void
  }
}
