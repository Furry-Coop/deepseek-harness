/**
 * Driver-owned durable agent inbox projection and command facade.
 *
 * @module @deepseek-ai/dsh-agent-loop/inbox
 */

import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { Session, SessionEventMap, UserMessage } from '@deepseek-ai/dsh-session'
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

/** Pending input captured before a cancellation runs callbacks that may add more. */
export interface PendingInboxSnapshot {
  /** next-step occurrences present at capture time. */
  readonly step: readonly UserMessage[]
  /** next-turn occurrences present at capture time. */
  readonly turn: readonly UserMessage[]
}

/** One committed inbox mutation, holding the occurrences its logged splice carried. */
interface CommittedSplice {
  /** Occurrences the splice removed, in lane order before removal. */
  readonly removed: UserMessage[]
  /** Projection occurrences this splice inserted, exactly as the fold stores them. */
  readonly inserted: readonly UserMessage[]
}

/**
 * Driver-owned durable Inbox implementation used by ReactLoopAgent and focused
 * provider tests.
 * @param readState - reader for the live Inbox projection state.
 * @param session - session whose durable events store pending input.
 * @param dispatch - agent-scoped notifications for Inbox lifecycle events.
 */
export class ReactLoopInbox implements InboxContract {
  constructor(
    private readonly readState: () => InboxState,
    private readonly session: Session,
    private readonly dispatch: AgentEventDispatch,
  ) {}

  /** Prompts awaiting individual turns. */
  get nextTurn(): readonly UserMessage[] {
    return this.readState()['next-turn']
  }

  /** Input awaiting the next step boundary. */
  get nextStep(): readonly UserMessage[] {
    return this.readState()['next-step']
  }

  /** Whether either pending-message list contains work. */
  get hasPending(): boolean {
    const state = this.readState()
    return state['next-turn'].length > 0 || state['next-step'].length > 0
  }

  /** Durably cancel all pending input, clearing next-step before next-turn. */
  clear(): void {
    this.splice('next-step', 0, this.nextStep.length, [])
    this.splice('next-turn', 0, this.nextTurn.length, [])
  }

  /**
   * Capture both pending lists before a cancellation runs any callback.
   * @returns copies of the pending next-step and next-turn occurrences.
   */
  snapshotPending(): PendingInboxSnapshot {
    const state = this.readState()
    return { step: [...state['next-step']], turn: [...state['next-turn']] }
  }

  /**
   * Durably cancel only the pending occurrences in one snapshot.
   *
   * Removal matches each captured occurrence by message identity in the lane as
   * it exists now, so input inserted by a cancellation callback survives and a
   * changed length cannot delete it. Both lanes come from one snapshot taken
   * before any callback ran.
   * @param snapshot - pending input captured before the cancellation callbacks ran.
   */
  cancelSnapshot(snapshot: PendingInboxSnapshot): void {
    const step = new Map(snapshot.step.map(message => [message.id, message] as const))
    const turn = new Map(snapshot.turn.map(message => [message.id, message] as const))
    this.cancelLane('next-step', step)
    this.cancelLane('next-turn', turn)
  }

  /**
   * Remove the captured occurrences still pending in one lane, in place.
   *
   * The captured occurrence's eligibility is consumed before `mutate` runs any
   * discard notification, so input a notification inserts — even the same
   * message object — is later input and is not removed by this snapshot again.
   * @param target - pending list to modify.
   * @param captured - occurrences from {@link snapshotPending}, keyed by identity.
   */
  private cancelLane(target: InboxTarget, captured: Map<MessageId, UserMessage>): void {
    for (;;) {
      const lane = this.readState()[target]
      const start = lane.findIndex(message => captured.get(message.id) === message)
      if (start < 0) return
      let count = 1
      for (const message of lane.slice(start + 1)) {
        if (captured.get(message.id) !== message) break
        count += 1
      }
      for (const message of lane.slice(start, start + count)) captured.delete(message.id)
      this.mutate(target, start, count, [], true)
    }
  }

  /**
   * Remove and return the complete batch proposed for one step.
   * @param target - whether this boundary also consumes one queued turn.
   * @param turn - turn that will own the claimed batch.
   * @returns next-step input followed by the queued turn, when requested.
   */
  claim(target: InboxTarget, turn: number): UserMessage[] {
    const claimed = this.mutate('next-step', 0, this.nextStep.length, [], false).removed
    if (target === 'next-turn') claimed.push(...this.mutate('next-turn', 0, 1, [], false).removed)
    for (const message of claimed) this.dispatch.emit('agent/inbox/claimed', { message, turn })
    return claimed
  }

  /**
   * Append one message to a pending list.
   * @param target - pending list to extend.
   * @param message - message to append.
   */
  append(target: InboxTarget, message: UserMessage): void {
    this.splice(target, this.readState()[target].length, 0, [message])
  }

  /**
   * Append one message and report the pending occurrence it produced.
   *
   * `Session.append` detaches its payload, so the projection message is a fresh
   * object per insertion: a callback that removes and re-inserts the same
   * caller object still creates a different occurrence. The result is this
   * splice's own logged occurrence, never a later one that reused its identity.
   * @param target - pending list to extend.
   * @param message - message to append.
   * @returns this insertion's projection occurrence while it is still pending,
   *   or undefined when a callback removed it before the append returned.
   */
  insert(target: InboxTarget, message: UserMessage): UserMessage | undefined {
    const { inserted } = this.mutate(target, this.readState()[target].length, 0, [message], true)
    // A callback can remove this occurrence and insert another message with the
    // same id before the append returns, so the current lane must not answer
    // which occurrence this insertion produced.
    const occurrence = inserted.at(0)
    return occurrence !== undefined && this.holdsOccurrence(occurrence) ? occurrence : undefined
  }

  /**
   * Whether one inserted occurrence is still pending in either lane.
   * @param occurrence - projection message returned by {@link insert}.
   * @returns whether that exact occurrence remains pending.
   */
  holdsOccurrence(occurrence: UserMessage): boolean {
    const state = this.readState()
    return state['next-step'].includes(occurrence) || state['next-turn'].includes(occurrence)
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
    return this.mutate(target, start, deleteCount, inserted, true).removed
  }

  /** Locate one pending identity across both owned lists. */
  private locate(messageId: MessageId): { target: InboxTarget; index: number } | undefined {
    const state = this.readState()
    for (const target of ['next-turn', 'next-step'] as const) {
      const index = state[target].findIndex(message => message.id === messageId)
      if (index >= 0) return { target, index }
    }
    return undefined
  }

  /** Commit one normalized mutation and publish its live events. */
  private mutate(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
    discardRemoved: boolean,
  ): CommittedSplice {
    const state = this.readState()
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
    if (actualDeleteCount === 0 && inserted.length === 0) return { removed: [], inserted: [] }
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
    }
    const removed = inbox.slice(actualStart, actualStart + actualDeleteCount)
    const event = this.session.append('agent/inbox/spliced', splice)
    if (discardRemoved) {
      for (const message of removed) this.dispatch.emit('agent/inbox/discarded', { message })
    }
    const committed = event.data.inserted
    for (const message of committed) {
      this.dispatch.emit('agent/inbox/inserted', { message })
    }
    return { removed, inserted: committed }
  }
}
