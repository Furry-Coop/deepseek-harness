/**
 * Private Host projection of the prompt-admission identities owned by the
 * Session Controller.
 *
 * A retried prompt is idempotent while its request id is still pending or was
 * already admitted. The ordinary admission is a human `user/message`; a
 * host-side rewrite replaces the human source kind and admits the same message
 * id after the original Inbox occurrence was claimed and a step entered. This
 * unit folds both into the bounded request-id set the prompt command reads, so
 * the command never rescans the log.
 *
 * The admitted request-id list is the unit's only linear state: one entry per
 * admitted prompt is the idempotency fact a retry must observe across reloads
 * and forks. Pending occurrences are bounded by the Inbox itself and claimed
 * occurrences by the current step batch.
 *
 * @module @deepseek-ai/dsh-api-session-controller/prompt-admission
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InboxTarget } from '@deepseek-ai/dsh-agent'
import {
  advanceAdmissionWindow,
  admitsRewrite,
  claimAdmissionWindow,
  inboxSpliceKind,
  isHumanInboxOccurrence,
  NO_ADMISSION_WINDOW,
  type AdmissionWindow,
} from '@deepseek-ai/dsh-agent/inbox-admission'
import { brandNumber, brandString } from '@deepseek-ai/dsh-brand'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { UserMessage } from '@deepseek-ai/dsh-llm/types'
import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition, ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type { SessionRequestId } from './types.ts'

/** One tracked human occurrence still pending in an Inbox lane. */
export interface PendingPromptOccurrence {
  /** Prompt request identity carried by the occurrence. */
  readonly requestId: SessionRequestId
  /** Message identity the admitted rewrite must repeat. */
  readonly messageId: MessageId
  /** Lane that currently holds the occurrence. */
  readonly target: InboxTarget
  /** Current index inside that lane. */
  readonly index: number
}

/** One claimed human occurrence awaiting its entered-step admission. */
export interface ClaimedPromptOccurrence {
  /** Prompt request identity carried by the claimed occurrence. */
  readonly requestId: SessionRequestId
  /** Message identity the admitted rewrite must repeat. */
  readonly messageId: MessageId
  /** Claim and entered-step evidence for the occurrence. */
  readonly window: AdmissionWindow
}

/** Recoverable prompt-admission facts folded from one Session log. */
export interface PromptAdmissionState {
  /**
   * Admitted prompt request ids in admission order.
   *
   * One entry per admitted prompt is the retry-idempotency fact; the list is
   * linear in prompts, not in events, and cannot be discarded without rescanning.
   */
  readonly admitted: readonly SessionRequestId[]
  /** Human occurrences still pending in the two Inbox lanes. */
  readonly pending: readonly PendingPromptOccurrence[]
  /** Claimed human occurrences that a step may still admit. */
  readonly claimed: readonly ClaimedPromptOccurrence[]
  /** Turn currently open, or 0 between Turns. */
  readonly openTurn: number
}

const sessionSeqSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  .transform(brandNumber<SessionSeq>)
const requestIdSchema = z.string().min(1).transform(brandString<SessionRequestId>)
const messageIdSchema = z.string().min(1).transform(brandString<MessageId>)
const inboxTargetSchema = z.union([z.literal('next-turn'), z.literal('next-step')])

const pendingOccurrenceSchema: z.ZodType<PendingPromptOccurrence> = z.object({
  requestId: requestIdSchema,
  messageId: messageIdSchema,
  target: inboxTargetSchema,
  index: z.number().int().nonnegative(),
}).strict()

const claimedOccurrenceSchema: z.ZodType<ClaimedPromptOccurrence> = z.object({
  requestId: requestIdSchema,
  messageId: messageIdSchema,
  window: z.object({
    claimSeq: sessionSeqSchema.nullable(),
    claimTurn: z.number().int().nonnegative().nullable(),
    stepStartSeq: sessionSeqSchema.nullable(),
  }).strict(),
}).strict()

const promptAdmissionStateSchema: z.ZodType<PromptAdmissionState> = z.object({
  admitted: z.array(requestIdSchema).readonly(),
  pending: z.array(pendingOccurrenceSchema).readonly(),
  claimed: z.array(claimedOccurrenceSchema).readonly(),
  openTurn: z.number().int().nonnegative(),
}).strict() as z.ZodType<PromptAdmissionState>

/** Empty admission state before the first relevant event. */
const EMPTY_PROMPT_ADMISSION: PromptAdmissionState = {
  admitted: [],
  pending: [],
  claimed: [],
  openTurn: 0,
}

/**
 * Read the request identity a human occurrence carries.
 * @param message - pending or admitted user message.
 * @returns the non-empty request id, or `undefined` when the message carries none.
 */
function requestIdOf(message: UserMessage): SessionRequestId | undefined {
  if (!('rpcId' in message.source)) return undefined
  const rpcId: unknown = message.source.rpcId
  return typeof rpcId === 'string' && rpcId !== '' ? rpcId as SessionRequestId : undefined
}

/**
 * Fold one committed Inbox splice into pending and claimed occurrences.
 * @param state - state before the splice.
 * @param event - committed `agent/inbox/spliced` event.
 * @returns the advanced state, or the same reference when nothing tracked changed.
 */
function applySplice(
  state: PromptAdmissionState,
  event: Extract<SessionEvent, { type: 'agent/inbox/spliced' }>,
): PromptAdmissionState {
  const splice = event.data
  const removedCount = splice.removedCount ?? 0
  const end = splice.start + removedCount
  if (!Number.isSafeInteger(splice.start) || splice.start < 0
    || !Number.isSafeInteger(removedCount) || removedCount < 0) {
    throw new Error(`invalid persisted inbox splice at session seq ${event.seq}`)
  }
  const kind = inboxSpliceKind(splice)
  const replacedIds = new Set(splice.inserted.map(message => message.id))
  const pending: PendingPromptOccurrence[] = []
  const claimed = state.claimed.filter(item => !replacedIds.has(item.messageId))
  let changed = claimed.length !== state.claimed.length
  for (const item of state.pending) {
    if (item.target !== splice.target) {
      pending.push(item)
      continue
    }
    if (item.index >= splice.start && item.index < end) {
      changed = true
      // A claim enters the entered-step window; cancellation and replacement
      // consume the occurrence without authorizing a later copy.
      if (kind === 'claim' && state.openTurn > 0) {
        claimed.push({
          requestId: item.requestId,
          messageId: item.messageId,
          window: claimAdmissionWindow(state.openTurn, event.seq),
        })
      }
      continue
    }
    if (item.index >= end) {
      const index = item.index + splice.inserted.length - removedCount
      if (index !== item.index) {
        changed = true
        pending.push({ ...item, index })
        continue
      }
    }
    pending.push(item)
  }
  for (const [offset, message] of splice.inserted.entries()) {
    if (!isHumanInboxOccurrence(message)) continue
    const requestId = requestIdOf(message)
    if (requestId === undefined) continue
    changed = true
    pending.push({
      requestId,
      messageId: message.id,
      target: splice.target,
      index: splice.start + offset,
    })
  }
  return changed ? { ...state, pending, claimed } : state
}

/**
 * Fold one committed `user/message` into admitted identities.
 * @param state - state before the message.
 * @param event - committed `user/message` event.
 * @returns the advanced state, or the same reference when nothing tracked changed.
 */
function applyMessage(
  state: PromptAdmissionState,
  event: Extract<SessionEvent, { type: 'user/message' }>,
): PromptAdmissionState {
  const message = event.data
  const claimedIndex = state.claimed.findIndex(item => item.messageId === message.id)
  let admitted = state.admitted
  let claimed = state.claimed
  let pending = state.pending
  let changed = false
  if (claimedIndex >= 0) {
    const item = state.claimed[claimedIndex]
    /* v8 ignore next 2 -- claimedIndex comes from findIndex over the same dense array; unreachable under the projection contract. */
    if (item === undefined) throw new Error('prompt admission claim index lost its candidate')
    // A human source is the ordinary admission; a rewritten source needs the
    // claim's entered-step window and the same message identity.
    if (message.source.kind === 'user' || admitsRewrite(item.window, message, event.seq, {
      messageId: item.messageId,
      correlation: item.requestId,
    })) {
      claimed = claimed.filter((_, index) => index !== claimedIndex)
      changed = true
      if (message.source.kind !== 'user' && !admitted.includes(item.requestId)) {
        admitted = [...admitted, item.requestId]
      }
    }
  }
  if (message.source.kind === 'user') {
    const requestId = requestIdOf(message)
    if (requestId !== undefined && !admitted.includes(requestId)) {
      admitted = [...admitted, requestId]
      changed = true
    }
    const pendingIndex = pending.findIndex(item => item.messageId === message.id)
    if (pendingIndex >= 0) {
      pending = pending.filter((_, index) => index !== pendingIndex)
      changed = true
    }
  }
  return changed ? { ...state, admitted, pending, claimed } : state
}

/**
 * Fold one committed Session event into prompt-admission facts.
 *
 * Deterministic and synchronous: no I/O, models, tools, or Cordis hooks.
 * @param state - state before the event.
 * @param event - next committed Session event.
 * @returns the advanced state; the same reference for unrelated events.
 */
export function applyPromptAdmission(state: PromptAdmissionState, event: SessionEvent): PromptAdmissionState {
  switch (event.type) {
    case 'turn/start':
      return state.openTurn === event.data.turn ? state : { ...state, openTurn: event.data.turn }
    case 'turn/end':
      if (state.openTurn === 0 && state.claimed.length === 0) return state
      return { ...state, openTurn: 0, claimed: [] }
    case 'step/start': {
      if (state.claimed.length === 0) return state
      let changed = false
      const claimed = state.claimed.map((item) => {
        if (item.window.stepStartSeq !== null) return item
        const window = advanceAdmissionWindow(item.window, event)
        if (window === item.window) return item
        changed = true
        return { ...item, window }
      })
      return changed ? { ...state, claimed } : state
    }
    case 'step/end':
      return state.claimed.length === 0 ? state : { ...state, claimed: [] }
    case 'agent/inbox/spliced':
      return applySplice(state, event)
    case 'user/message':
      return applyMessage(state, event)
    default:
      return state
  }
}

/** Private Host projection definition for prompt-admission identities. */
export const promptAdmissionProjectionDefinition: ProjectionDefinition<'promptAdmission', PromptAdmissionState> = {
  key: 'promptAdmission',
  stateVersion: 1,
  stateSchema: promptAdmissionStateSchema,
  init: (): PromptAdmissionState => EMPTY_PROMPT_ADMISSION,
  apply: applyPromptAdmission,
}

/** Synchronous domain reader over the registered prompt-admission projection. */
export class PromptAdmissionReader {
  private handle: ProjectionHandle<PromptAdmissionState> | undefined

  /**
   * Register the projection before exposing {@link admitted}.
   * @param ctx - Host context exposing the Session projection registry.
   * @returns when the registration is ready.
   */
  async initialize(ctx: Context): Promise<void> {
    this.handle = await ctx.sessionProjections.register<'promptAdmission', PromptAdmissionState>(
      promptAdmissionProjectionDefinition,
    )
  }

  /**
   * Whether one prompt request is already admitted or owns a live claim.
   *
   * A claimed occurrence that has not yet been admitted is in flight: an
   * overlapping retry must not bind or insert a second copy, but the claim is
   * not a permanent admission and ends at step or Turn close.
   * @param session - live Session whose log was prepared and folded.
   * @param requestId - client-minted prompt identity.
   * @returns whether the request is admitted or currently claimed.
   */
  acceptedOrInFlight(session: Session, requestId: SessionRequestId): boolean {
    if (this.handle === undefined) throw new Error('prompt-admission projection is not initialized')
    const state = this.handle.stateOf(session)
    return state.admitted.includes(requestId)
      || state.claimed.some(item => item.requestId === requestId)
  }

  /**
   * Whether one prompt request is already admitted in this Session.
   * @param session - live Session whose log was prepared and folded.
   * @param requestId - client-minted prompt identity.
   * @returns whether the request id is recorded as admitted.
   */
  admitted(session: Session, requestId: SessionRequestId): boolean {
    if (this.handle === undefined) throw new Error('prompt-admission projection is not initialized')
    return this.handle.stateOf(session).admitted.includes(requestId)
  }
}

export { NO_ADMISSION_WINDOW }
