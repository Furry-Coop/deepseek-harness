/**
 * Driver-owned durable agent inbox projection and command facade.
 *
 * @module @deepseek-ai/dsh-agent-loop/inbox
 */

import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { Session, SessionEventMap, SessionLogOffset, UserMessage } from '@deepseek-ai/dsh-session'
import type {
  AgentEventDispatch,
  Inbox as InboxContract,
  InboxState,
  InboxTarget,
  InboxWireState,
} from '@deepseek-ai/dsh-agent'
import { z } from 'zod'

/** Wire validation for pending agent input reconstructed from durable inbox splices. */
export const inboxProjectionSchema = z.object({
  'next-turn': z.array(z.custom<UserMessage>()).readonly(),
  'next-step': z.array(z.custom<UserMessage>()).readonly(),
}).readonly()

/** Standard fold that reconstructs pending input and rejects invalid durable splice history. */
export const inboxProjectionDefinition = {
  key: 'inbox',
  stateSchema: inboxProjectionSchema,
  init: (): InboxState => ({ 'next-turn': [], 'next-step': [] }),
  apply(state: InboxState, event) {
    if (event.type !== 'agent/inbox/spliced') return state
    const splice = event.data
    try {
      const inbox = state[splice.target]
      const removedCount = splice.removedCount ?? 0
      if (!Number.isSafeInteger(splice.start) || splice.start < 0 || splice.start > inbox.length
        || !Number.isSafeInteger(removedCount) || removedCount < 0
        || splice.start + removedCount > inbox.length) {
        throw new Error('invalid inbox splice')
      }
      const next = inbox.toSpliced(splice.start, removedCount, ...splice.inserted)
      const ids = new Set<string>()
      for (const message of splice.target === 'next-turn'
        ? [...next, ...state['next-step']]
        : [...state['next-turn'], ...next]) {
        if (ids.has(message.id)) throw new Error(`message "${message.id}" is already pending`)
        ids.add(message.id)
      }
      return splice.target === 'next-turn'
        ? { 'next-turn': next, 'next-step': state['next-step'] }
        : { 'next-turn': state['next-turn'], 'next-step': next }
    } catch (error: unknown) {
      throw new Error(`invalid persisted inbox splice at session seq ${event.seq}`, { cause: error })
    }
  },
  wire: {
    // The wire value is the fold state itself: every pending message already
    // round-trips the session log as lossless JSON. Only the static type
    // narrows to the JSON-safe projection table entry.
    viewSchema: inboxProjectionSchema as unknown as z.ZodType<InboxWireState>,
    view: (state: InboxState) => state as unknown as InboxWireState,
  },
  stateVersion: 1,
} satisfies ProjectionDefinition<'inbox', InboxState>

/**
 * Pending input captured before a cancellation runs callbacks that may add more.
 * @property step - next-step occurrences present at capture time.
 * @property turn - next-turn occurrences present at capture time.
 */
export interface PendingInboxSnapshot {
  readonly step: readonly UserMessage[]
  readonly turn: readonly UserMessage[]
}

/**
 * Driver-owned durable Inbox implementation used by ReactLoopAgent and focused
 * provider tests.
 * @param projections - registry with the standard Inbox projection registered by AgentLoop.
 * @param session - session whose durable events store pending input.
 * @param dispatch - agent-scoped notifications for Inbox lifecycle events.
 */
export class ReactLoopInbox implements InboxContract {
  /** One deferred post-append cancel intent; the log rejects reentrant appends. */
  #queuedIntent = false
  /** Optional diagnostic sink for an intent the log could not accept. */
  readonly #warn: ((message: string) => void) | undefined

  constructor(
    private readonly projections: SessionProjectionRegistry,
    private readonly session: Session,
    private readonly dispatch: AgentEventDispatch,
    warn?: (message: string) => void,
  ) {
    this.#warn = warn
  }

  /** Prompts awaiting individual turns. */
  get nextTurn(): readonly UserMessage[] {
    return this.current()['next-turn']
  }

  /** Input awaiting the next step boundary. */
  get nextStep(): readonly UserMessage[] {
    return this.current()['next-step']
  }

  /** Whether either pending-message list contains work. */
  get hasPending(): boolean {
    const state = this.current()
    return state['next-turn'].length > 0 || state['next-step'].length > 0
  }

  /**
   * Durably cancel pending input, clearing next-step before next-turn.
   *
   * The call captures both lists before it runs any callback, so input inserted
   * by an abort listener or a discard notification survives; a changed list
   * length cannot remove the wrong occurrence. A user cancellation with nothing
   * captured still leaves one durable intent fact: later recovery can tell a
   * user cancellation from a crash that merely lost the queue. The intent-only
   * splice is a no-op for the fold.
   * @param cause - the stable caller intent recorded on each cancellation so a
   *   reader can tell ordinary teardown from a user cancellation without live state.
   */
  clear(cause: 'user' | 'disposed' = 'user'): void {
    this.cancelSnapshot(this.snapshotPending(), cause, this.session.seq)
  }

  /**
   * Capture both pending lists before a cancellation runs any callback.
   * @returns copies of the pending next-step and next-turn occurrences.
   */
  snapshotPending(): PendingInboxSnapshot {
    const state = this.current()
    return { step: [...state['next-step']], turn: [...state['next-turn']] }
  }

  /**
   * Durably cancel only the pending occurrences in one snapshot.
   *
   * Removal matches each captured occurrence by message identity in the lane as
   * it exists now, so input inserted by a cancellation callback survives and a
   * changed length cannot delete it. Both lanes come from one snapshot taken
   * before any callback ran. Every written splice carries `entrySeq`, the log
   * length the caller captured before its callbacks; a record may be appended
   * after later input, so readers use that cut rather than the splice's own seq.
   * @param snapshot - pending input captured before the cancellation callbacks ran.
   * @param cause - whether a user or the disposing lifecycle cancelled the work.
   * @param entrySeq - session log length captured at cancellation entry.
   */
  cancelSnapshot(
    snapshot: PendingInboxSnapshot,
    cause: 'user' | 'disposed',
    entrySeq: SessionLogOffset,
  ): void {
    const step = new Map(snapshot.step.map(message => [message.id, message] as const))
    const turn = new Map(snapshot.turn.map(message => [message.id, message] as const))
    if (step.size === 0 && turn.size === 0) {
      if (cause === 'user') this.recordCancelIntent(entrySeq)
      return
    }
    this.cancelLane('next-step', step, cause, entrySeq)
    this.cancelLane('next-turn', turn, cause, entrySeq)
  }

  /**
   * Remove the captured occurrences still pending in one lane, in place.
   *
   * The captured occurrence's eligibility is consumed before `mutate` runs any
   * discard notification, so input a notification inserts — even the same
   * message object — is later input and is not removed by this snapshot again.
   * @param target - pending list to modify.
   * @param captured - occurrences from {@link snapshotPending}, keyed by identity.
   * @param cause - cancellation intent recorded on each splice.
   * @param entrySeq - session log length captured at cancellation entry.
   */
  private cancelLane(
    target: InboxTarget,
    captured: Map<MessageId, UserMessage>,
    cause: 'user' | 'disposed',
    entrySeq: SessionLogOffset,
  ): void {
    for (;;) {
      const lane = this.current()[target]
      const start = lane.findIndex(message => captured.get(message.id) === message)
      if (start < 0) return
      let count = 1
      for (const message of lane.slice(start + 1)) {
        if (captured.get(message.id) !== message) break
        count += 1
      }
      for (const message of lane.slice(start, start + count)) captured.delete(message.id)
      this.mutate(target, start, count, [], true, cause, entrySeq)
    }
  }

  /**
   * Record a user cancellation that removed no pending input; fold leaves state unchanged.
   *
   * A cancellation raised from inside an append's session observer cannot
   * append reentrantly, so its intent is queued to run synchronously right
   * after that publication and before detach. Keeping the flag set across the
   * append and all its synchronous observers bounds an observer that cancels
   * again. The intent is an empty splice, so it removes no later input; a
   * callback in the same publication stack can still append input before the
   * queued intent runs, so the intent's seq is not an ordering fence. The
   * splice records `entrySeq` for the caller's entry cut; that cut, not the
   * splice seq, distinguishes input the cancellation targeted from later input.
   * Window: a physical kill between the reentrant cancel and the
   * post-publication drain loses the intent.
   * @param entrySeq - session log length captured at cancellation entry.
   */
  private recordCancelIntent(entrySeq: SessionLogOffset): void {
    if (this.#queuedIntent) return
    this.#queuedIntent = true
    const splice: SessionEventMap['agent/inbox/spliced'] = {
      target: 'next-step',
      start: 0,
      inserted: [],
      outcome: 'canceled',
      cause: 'user',
      entrySeq,
    }
    try {
      this.session.append('agent/inbox/spliced', splice)
      this.#queuedIntent = false
    } catch (error: unknown) {
      if (!(error instanceof Error) || !error.message.includes('cannot reenter')) {
        this.#queuedIntent = false
        throw error
      }
      this.session.afterPublication(() => {
        try {
          this.session.append('agent/inbox/spliced', splice)
        } catch (appendError: unknown) {
          // Not necessarily closing: the session may still be detached without
          // durability. Keep the real failure visible instead of claiming the
          // intent is persisted.
          this.#warn?.(`inbox cancel intent was not appended after publication: ${String(appendError)}`)
        } finally {
          this.#queuedIntent = false
        }
      })
    }
  }

  /**
   * Remove and return the complete batch proposed for one step.
   * @param target - whether this boundary also consumes one queued turn.
   * @param turn - turn that will own the claimed batch.
   * @returns next-step input followed by the queued turn, when requested.
   */
  claim(target: InboxTarget, turn: number): UserMessage[] {
    const claimed = this.mutate('next-step', 0, this.nextStep.length, [], false)
    if (target === 'next-turn') claimed.push(...this.mutate('next-turn', 0, 1, [], false))
    for (const message of claimed) this.dispatch.emit('agent/inbox/claimed', { message, turn })
    return claimed
  }

  /**
   * Append one message to a pending list.
   * @param target - pending list to extend.
   * @param message - message to append.
   */
  append(target: InboxTarget, message: UserMessage): void {
    this.splice(target, this.current()[target].length, 0, [message])
  }

  /**
   * Prepend one message to a pending list.
   * @param target - pending list to extend.
   * @param message - message to prepend.
   */
  prepend(target: InboxTarget, message: UserMessage): void {
    this.splice(target, 0, 0, [message])
  }

  /**
   * Replace one pending message in place.
   * @param messageId - identity of the pending message to replace.
   * @param newMessage - replacement message.
   * @returns whether the message was still pending.
   */
  replace(messageId: MessageId, newMessage: UserMessage): boolean {
    const location = this.locate(messageId)
    if (location === undefined) return false
    this.splice(location.target, location.index, 1, [newMessage])
    return true
  }

  /**
   * Remove one pending message.
   * @param messageId - identity of the pending message to remove.
   * @returns whether the message was still pending.
   */
  remove(messageId: MessageId): boolean {
    const location = this.locate(messageId)
    if (location === undefined) return false
    this.splice(location.target, location.index, 1, [])
    return true
  }

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
  ): UserMessage[] {
    return this.mutate(target, start, deleteCount, inserted, true)
  }

  /** Locate one pending identity across both owned lists. */
  private locate(messageId: MessageId): { target: InboxTarget; index: number } | undefined {
    const state = this.current()
    for (const target of ['next-turn', 'next-step'] as const) {
      const index = state[target].findIndex(message => message.id === messageId)
      if (index >= 0) return { target, index }
    }
    return undefined
  }

  /** Read the current durable projection state. */
  private current(): InboxState {
    const state = this.projections.stateOf(this.session, 'inbox')
    if (state === undefined) {
      throw new Error(
        `agent "${this.session.id}" cannot read inbox state: its projection registration is not active`,
      )
    }
    return state
  }

  /**
   * Commit one normalized mutation and publish its live events.
   * @param target - pending list to mutate.
   * @param start - splice position.
   * @param deleteCount - maximum number of messages to remove.
   * @param inserted - messages to insert at the resolved position.
   * @param discardRemoved - whether removed messages are cancellation discards.
   * @param cancelCause - cancellation intent for a lifecycle removal, when any.
   * @param entrySeq - entry cut recorded on a cancellation splice.
   */
  private mutate(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
    discardRemoved: boolean,
    cancelCause?: 'user' | 'disposed',
    entrySeq?: SessionLogOffset,
  ): UserMessage[] {
    const state = this.current()
    const inbox = state[target]
    const truncatedStart = Math.trunc(start)
    const offset = Number.isNaN(truncatedStart) ? 0 : truncatedStart
    const actualStart = offset < 0
      ? Math.max(inbox.length + offset, 0)
      : Math.min(offset, inbox.length)
    const truncatedDeleteCount = Math.trunc(deleteCount)
    const actualDeleteCount = Math.min(
      Math.max(Number.isNaN(truncatedDeleteCount) ? 0 : truncatedDeleteCount, 0),
      inbox.length - actualStart,
    )
    if (actualDeleteCount === 0 && inserted.length === 0) return []
    const candidate = inbox.toSpliced(actualStart, actualDeleteCount, ...inserted)
    const ids = new Set<string>()
    for (const message of target === 'next-turn'
      ? [...candidate, ...state['next-step']]
      : [...state['next-turn'], ...candidate]) {
      if (ids.has(message.id)) throw new Error(`message "${message.id}" is already pending`)
      ids.add(message.id)
    }
    const outcome = discardRemoved && actualDeleteCount > 0 ? 'canceled' as const : undefined
    const splice: SessionEventMap['agent/inbox/spliced'] = {
      target,
      start: actualStart,
      ...(actualDeleteCount === 0 ? {} : { removedCount: actualDeleteCount }),
      inserted,
      ...(outcome === undefined ? {} : { outcome }),
      // Only a cancellation carries the caller's stable intent and entry cut;
      // explicit removals and replacements stay byte-identical to the released
      // event.
      ...(outcome === undefined || cancelCause === undefined ? {} : {
        cause: cancelCause,
        ...(entrySeq === undefined ? {} : { entrySeq }),
      }),
    }
    const removed = inbox.slice(actualStart, actualStart + actualDeleteCount)
    const event = this.session.append('agent/inbox/spliced', splice)
    if (discardRemoved) {
      for (const message of removed) this.dispatch.emit('agent/inbox/discarded', { message })
    }
    for (const message of event.data.inserted) {
      this.dispatch.emit('agent/inbox/inserted', { message })
    }
    return removed
  }
}
