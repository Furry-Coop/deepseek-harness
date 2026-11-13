/**
 * Log-backed session title service, deterministic fallback, and provider contract.
 * @module @deepseek-ai/dsh-session-title
 */

import { Context, FiberState, Service, type Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { assertNever, deepFreeze } from '@deepseek-ai/dsh-util-values'
import type {
  Session,
  SessionEvent,
} from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition, ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-agent'
import {
  advanceAdmissionWindow,
  admitsRewrite,
  claimAdmissionWindow,
  inboxCorrelationOf,
  inboxSpliceKind,
} from '@deepseek-ai/dsh-agent/inbox-admission'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { UserMessage } from '@deepseek-ai/dsh-llm/types'
export type {
  SessionTitleEventData,
  SessionTitleFromInputEventData,
  SessionTitleGeneratedSource,
  SessionTitleInputEntry,
  SessionTitleInputRef,
  SessionTitleModelIdentity,
  SessionTitleSnapshot,
  SessionTitleSource,
  SessionTitleUserMessage,
  TitleClaimedOccurrence,
  TitlePendingOccurrence,
  TitleProjection,
} from './types.ts'
import { fallbackSessionTitle, normalizeSessionTitle } from './normalize.ts'
import type {
  SessionTitleEventData,
  SessionTitleFromInputEventData,
  SessionTitleInputEntry,
  SessionTitleInputRef,
  SessionTitleModelIdentity,
  SessionTitleSnapshot,
  SessionTitleSource,
  SessionTitleUserMessage,
  TitleClaimedOccurrence,
  TitleInputState,
  TitlePendingOccurrence,
} from './types.ts'

/** Identifies one session-title provider registration. */
export type SessionTitleProviderId = Branded<'SessionTitleProviderId'>

/**
 * Brand a raw provider id.
 * @param id - stable non-empty provider identifier supplied by a plugin.
 * @returns the same string with the session-title provider brand.
 */
export function SessionTitleProviderId(id: string): SessionTitleProviderId {
  return id as SessionTitleProviderId
}

export { fallbackSessionTitle, normalizeSessionTitle, truncateTitleUtf8 } from './normalize.ts'

/** Required deterministic fallback and accepted-title limits. */
export interface Config {
  /** Maximum whitespace-delimited words in the built-in fallback. */
  readonly fallbackMaxWords: number
  /** Maximum UTF-8 bytes in the built-in fallback. */
  readonly fallbackMaxBytes: number
  /** Maximum UTF-8 bytes in any accepted title. */
  readonly maxTitleBytes: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionTitle: SessionTitleService
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Latest-wins session title snapshot. Log-only: it never enters the model
     * surface or derived history.
     */
    'session/title': SessionTitleEventData
    /**
     * Latest-wins title derived from at least one claimed human Inbox
     * occurrence. Log-only: it never enters the model surface or derived
     * history, and it carries exact frozen input refs instead of `messageSeqs`.
     */
    'session/title-from-input': SessionTitleFromInputEventData
  }
}

/**
 * Rejection of an explicit user title whose text normalizes to empty — the
 * one {@link SessionTitleService.rename} failure that blames the input.
 * Callers translating rename failures onto a wire (`title-invalid`) narrow on
 * this class; liveness and disposal failures stay plain `Error`s.
 */
export class SessionTitleInvalidError extends Error {
  override readonly name = 'SessionTitleInvalidError'
}

/** Automatic generation cadence owned by a registered provider. */
export type SessionTitleAutomaticMode = 'first-prompt' | 'all-prompts'

/** Immutable input supplied to one title-provider call. */
export interface SessionTitleProviderRequest {
  /** Live session being titled. */
  readonly session: Session
  /** All eligible human messages through this generation revision. */
  readonly messages: readonly SessionTitleUserMessage[]
  /** Exact input references parallel to {@link messages}, frozen by the service. */
  readonly inputRefs: readonly SessionTitleInputRef[]
  /** Exact current logged main-request route, when one has been recorded. */
  readonly route?: SessionTitleModelIdentity
  /**
   * Latest accepted title captured at invocation, including an accepted
   * fallback whose event may follow the last eligible message. Absent before
   * any title is accepted. The provider decides whether and how to use it.
   */
  readonly currentTitle?: SessionTitleSnapshot
  /** Cancellation for supersession, disposal, timeout composition, or the explicit caller. */
  readonly signal: AbortSignal
}

/** Provider output before service-owned normalization and log acceptance. */
export interface SessionTitleProviderResult {
  /** Proposed title text. */
  readonly title: string
  /** Exact seqs from `request.messages` used by this result. */
  readonly messageSeqs: readonly SessionSeq[]
  /** Auxiliary LLM route, when generation used a model. */
  readonly model?: SessionTitleModelIdentity
}

/** One optional asynchronous title implementation registered with the service. */
export interface SessionTitleProvider {
  /** Stable id of the provider recorded with the title. */
  readonly id: SessionTitleProviderId
  /** When new human prompts start automatic generation. */
  readonly automatic: SessionTitleAutomaticMode
  /**
   * Produce one title revision.
   * @param request - message snapshot, current title, current route, session, and cancellation.
   * @returns proposed title plus exact input seqs and the optional provider/model route used to generate it.
   */
  generate(request: SessionTitleProviderRequest): Promise<SessionTitleProviderResult>
}

/** Extract the exact text of one message, or undefined when it has no visible text. */
function titleTextOf(message: UserMessage): string | undefined {
  const content = message.content
  const text = content
    .filter((block): block is Extract<(typeof content)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
  return normalizeSessionTitle(text, Number.MAX_SAFE_INTEGER).length === 0 ? undefined : text
}

/** Defensive copy of a logged title source (the snapshot must not alias log-owned objects). */
function copySessionTitleSource(source: SessionTitleSource): SessionTitleSource {
  switch (source.kind) {
    case 'fallback': return { kind: 'fallback' }
    case 'provider': return {
      kind: 'provider',
      provider: source.provider,
      ...(source.model === undefined ? {} : { model: { ...source.model } }),
    }
    case 'user': return { kind: 'user' }
    /* v8 ignore next -- closed-union exhaustiveness guard */
    default: return assertNever(source, 'SessionTitleSource')
  }
}

/** Defensive copy of one frozen input reference. */
function copySessionTitleInputRef(ref: SessionTitleInputRef): SessionTitleInputRef {
  switch (ref.kind) {
    case 'message': return { kind: 'message', messageSeq: ref.messageSeq }
    case 'origin': return {
      kind: 'origin',
      originalInboxSeq: ref.originalInboxSeq,
      messageId: ref.messageId,
      claimSeq: ref.claimSeq,
      admittedSeq: ref.admittedSeq,
    }
    /* v8 ignore next -- closed-union exhaustiveness guard */
    default: return assertNever(ref, 'SessionTitleInputRef')
  }
}

/** Service-owned resolved limits. */
interface ResolvedConfig {
  readonly fallbackMaxWords: number
  readonly fallbackMaxBytes: number
  readonly maxTitleBytes: number
}

/** One exact provider registration generation. */
interface ProviderRegistration {
  readonly provider: SessionTitleProvider
  readonly active: Set<Promise<unknown>>
  closing: boolean
}

/** Automatic work waiting for the matching main-request header. */
interface PendingAutomaticWork {
  readonly registration: ProviderRegistration
  readonly revision: number
  readonly throughSeq: SessionSeq
}

/** Provider call currently allowed to commit for one session. */
interface ActiveProviderWork extends PendingAutomaticWork {
  readonly controller: AbortController
  readonly signal: AbortSignal
}

/** Mutable concurrency state scoped to one live session. */
interface SessionTitleWorkState {
  revision: number
  fallback?: Promise<SessionTitleSnapshot | undefined>
  pending?: PendingAutomaticWork
  active?: ActiveProviderWork
}

/** Validate one positive integer configuration field. */
function assertPositiveInteger(name: keyof Config, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`session-title: ${name} must be a positive integer`)
  }
}

const EMPTY_TITLE_INPUT: TitleInputState = {
  first: null,
  count: 0,
  lastSeq: null,
  pending: [],
  claimed: [],
  openTurn: 0,
}

const messageSeqSchema = zod.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(SessionSeq)
const messageIdSchema: ZodType<MessageId> = zod.string().min(1)
  .transform(value => brandString<MessageId>(value))
const sessionTitleInputRefSchema: ZodType<SessionTitleInputRef> = zod.discriminatedUnion('kind', [
  zod.object({ kind: zod.literal('message'), messageSeq: messageSeqSchema }).strict(),
  zod.object({
    kind: zod.literal('origin'),
    originalInboxSeq: messageSeqSchema,
    messageId: messageIdSchema,
    claimSeq: messageSeqSchema,
    admittedSeq: messageSeqSchema,
  }).strict(),
]) as ZodType<SessionTitleInputRef>

const sessionTitleInputEntrySchema: ZodType<SessionTitleInputEntry> = zod.object({
  seq: messageSeqSchema,
  text: zod.string(),
  ref: sessionTitleInputRefSchema,
}).strict()

const titlePendingOccurrenceSchema: ZodType<TitlePendingOccurrence> = zod.object({
  messageId: messageIdSchema,
  originalInboxSeq: messageSeqSchema,
  text: zod.string(),
  correlation: zod.string().nullable(),
  target: zod.union([zod.literal('next-turn'), zod.literal('next-step')]),
  index: zod.number().int().nonnegative(),
}).strict()

const titleClaimedOccurrenceSchema: ZodType<TitleClaimedOccurrence> = zod.object({
  messageId: messageIdSchema,
  originalInboxSeq: messageSeqSchema,
  text: zod.string(),
  correlation: zod.string().nullable(),
  window: zod.object({
    claimSeq: messageSeqSchema.nullable(),
    claimTurn: zod.number().int().nonnegative().nullable(),
    stepStartSeq: messageSeqSchema.nullable(),
  }).strict(),
}).strict()

const titleInputStateSchema: ZodType<TitleInputState> = zod.object({
  first: sessionTitleInputEntrySchema.nullable(),
  count: zod.number().int().nonnegative(),
  lastSeq: messageSeqSchema.nullable(),
  pending: zod.array(titlePendingOccurrenceSchema).readonly(),
  claimed: zod.array(titleClaimedOccurrenceSchema).readonly(),
  openTurn: zod.number().int().nonnegative(),
}).strict().superRefine((state, context) => {
  const empty = state.first === null && state.lastSeq === null && state.count === 0
  const populated = state.first !== null
    && state.lastSeq !== null
    && state.count > 0
    && state.first.seq <= state.lastSeq
  if (!empty && !populated) {
    context.addIssue({
      code: 'custom',
      message: 'title input state must pair its count with first and last message seqs',
    })
  }
})

/** One fold step: the advanced aggregate and the input this event admitted, if any. */
interface TitleInputStep {
  readonly state: TitleInputState
  readonly admitted?: SessionTitleInputEntry
}

/** Fold one Inbox splice into the title's pending and claimed occurrences. */
function advanceTitleSplice(
  state: TitleInputState,
  event: Extract<SessionEvent, { type: 'agent/inbox/spliced' }>,
): TitleInputStep {
  const splice = event.data
  const removedCount = splice.removedCount ?? 0
  const end = splice.start + removedCount
  if (!Number.isSafeInteger(splice.start) || splice.start < 0
    || !Number.isSafeInteger(removedCount) || removedCount < 0) {
    throw new Error(`invalid persisted inbox splice at session seq ${event.seq}`)
  }
  const kind = inboxSpliceKind(splice)
  const replacedIds = new Set(splice.inserted.map(message => message.id))
  const pending: TitlePendingOccurrence[] = []
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
          messageId: item.messageId,
          originalInboxSeq: item.originalInboxSeq,
          text: item.text,
          correlation: item.correlation,
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
    if (message.source.kind !== 'user') continue
    const text = titleTextOf(message)
    if (text === undefined) continue
    changed = true
    pending.push({
      messageId: message.id,
      originalInboxSeq: event.seq,
      text,
      correlation: inboxCorrelationOf(message) ?? null,
      target: splice.target,
      index: splice.start + offset,
    })
  }
  return changed ? { state: { ...state, pending, claimed } } : { state }
}

/** Fold one admitted message into the title aggregate. */
function advanceTitleMessage(
  state: TitleInputState,
  event: Extract<SessionEvent, { type: 'user/message' }>,
): TitleInputStep {
  const message = event.data
  const claimedIndex = state.claimed.findIndex(item => item.messageId === message.id)
  let pending = state.pending
  let claimed = state.claimed
  let admitted: SessionTitleInputEntry | undefined
  if (claimedIndex >= 0) {
    const item = state.claimed[claimedIndex]
    /* v8 ignore next 2 -- claimedIndex comes from findIndex over the same dense array; unreachable under the projection contract. */
    if (item === undefined) throw new Error('title input claim index lost its candidate')
    // A human source is the ordinary admission; a rewritten source needs the
    // claim's entered-step window, the same identity, and the same correlation.
    const rewritten = message.source.kind !== 'user'
      && item.window.claimSeq !== null
      && admitsRewrite(item.window, message, event.seq, {
        messageId: item.messageId,
        correlation: item.correlation,
      })
    if (message.source.kind === 'user' || rewritten) {
      claimed = claimed.filter((_, index) => index !== claimedIndex)
      if (rewritten && item.window.claimSeq !== null) {
        admitted = {
          seq: event.seq,
          text: item.text,
          ref: {
            kind: 'origin',
            originalInboxSeq: item.originalInboxSeq,
            messageId: item.messageId,
            claimSeq: item.window.claimSeq,
            admittedSeq: event.seq,
          },
        }
      }
    }
  }
  if (message.source.kind === 'user') {
    pending = pending.filter(item => item.messageId !== message.id)
    const text = titleTextOf(message)
    if (text !== undefined) {
      admitted = { seq: event.seq, text, ref: { kind: 'message', messageSeq: event.seq } }
    }
  }
  if (admitted === undefined) {
    const changed = pending !== state.pending || claimed !== state.claimed
    return changed ? { state: { ...state, pending, claimed } } : { state }
  }
  return {
    state: {
      ...state,
      pending,
      claimed,
      first: state.first ?? admitted,
      count: state.count + 1,
      lastSeq: event.seq,
    },
    admitted,
  }
}

/**
 * Advance the title-input aggregate by one committed event.
 *
 * Claims and admissions use the shared Inbox admission policy; the title
 * aggregate keeps only its own first/count, pending occurrence text, and the
 * bounded claim window.
 * @param state - aggregate before the event.
 * @param event - next committed Session event.
 * @returns the advanced aggregate and the input this event admitted, if any.
 */
function advanceTitleInput(state: TitleInputState, event: SessionEvent): TitleInputStep {
  switch (event.type) {
    case 'turn/start':
      return state.openTurn === event.data.turn
        ? { state }
        : { state: { ...state, openTurn: event.data.turn } }
    case 'turn/end':
      return state.openTurn === 0 && state.claimed.length === 0
        ? { state }
        : { state: { ...state, openTurn: 0, claimed: [] } }
    case 'step/start': {
      if (state.claimed.length === 0) return { state }
      let changed = false
      const claimed = state.claimed.map((item) => {
        if (item.window.stepStartSeq !== null) return item
        const window = advanceAdmissionWindow(item.window, event)
        if (window === item.window) return item
        changed = true
        return { ...item, window }
      })
      return changed ? { state: { ...state, claimed } } : { state }
    }
    case 'step/end':
      return state.claimed.length === 0 ? { state } : { state: { ...state, claimed: [] } }
    case 'agent/inbox/spliced':
      return advanceTitleSplice(state, event)
    case 'user/message':
      return advanceTitleMessage(state, event)
    default:
      return { state }
  }
}

/**
 * Collect eligible title inputs from a session log, in admission order.
 * The full eligible prefix is only materialized for one provider generation,
 * so it is scanned from the log at execution time rather than retained by
 * the bounded `titleInput` projection.
 * @param events - the session event log.
 * @param throughSeq - optional inclusive upper seq bound.
 * @returns eligible messages with the exact input references the service freezes.
 */
function collectSessionTitleInputs(
  events: readonly SessionEvent[],
  throughSeq?: SessionSeq,
): { messages: SessionTitleUserMessage[]; inputRefs: SessionTitleInputRef[] } {
  let state = EMPTY_TITLE_INPUT
  const messages: SessionTitleUserMessage[] = []
  const inputRefs: SessionTitleInputRef[] = []
  for (const event of events) {
    if (throughSeq !== undefined && event.seq > throughSeq) break
    const step = advanceTitleInput(state, event)
    state = step.state
    if (step.admitted === undefined) continue
    messages.push({ seq: step.admitted.seq, text: step.admitted.text })
    inputRefs.push(step.admitted.ref)
  }
  return { messages, inputRefs }
}

/**
 * Resolve the provider's selected request seqs to the exact frozen references.
 * @param messages - provider request messages.
 * @param inputRefs - exact refs parallel to `messages`.
 * @param messageSeqs - exact seqs the provider selected from `messages`.
 * @returns the matching input references, in the provider's order.
 * @throws when a selected seq is not one of the request's inputs.
 */
export function selectSessionTitleInputRefs(
  messages: readonly SessionTitleUserMessage[],
  inputRefs: readonly SessionTitleInputRef[],
  messageSeqs: readonly SessionSeq[],
): SessionTitleInputRef[] {
  if (messages.length !== inputRefs.length) {
    throw new Error('session-title request messages and input refs are not parallel')
  }
  if (messageSeqs.length === 0) {
    throw new Error('session-title provider must select at least one source message seq')
  }
  const refs: SessionTitleInputRef[] = []
  let previous = -1
  for (const seq of messageSeqs) {
    const index = messages.findIndex(message => message.seq === seq)
    if (index < 0) throw new Error('session-title provider selected a seq outside the request')
    if (index <= previous) {
      throw new Error('session-title provider messageSeqs must be unique and ordered seqs from the request')
    }
    const ref = inputRefs[index]
    if (ref === undefined) {
      throw new Error('session-title request input refs are not parallel to its messages')
    }
    refs.push(ref)
    previous = index
  }
  return refs
}

const titleViewSchema: ZodType<string | null> = zod.string().min(1).nullable()

/** Latest logged title text and its client view. */
export const titleProjectionDefinition = {
  key: 'title',
  stateVersion: 2,
  stateSchema: titleViewSchema,
  init: () => null,
  apply: (state, event) => (event.type === 'session/title' || event.type === 'session/title-from-input'
    ? event.data.title
    : state),
  wire: {
    viewSchema: titleViewSchema,
    view: state => state,
  },
} satisfies ProjectionDefinition<'title', string | null>

/**
 * Fold the latest logged title without consulting mutable metadata.
 * @param events - live or persisted session log.
 * @returns the latest immutable title snapshot, or `undefined`.
 */
export function foldSessionTitle(events: readonly SessionEvent[]): SessionTitleSnapshot | undefined {
  const event = events.findLast(item => item.type === 'session/title' || item.type === 'session/title-from-input')
  if (event === undefined) return undefined
  if (event.type === 'session/title') {
    return deepFreeze({
      title: event.data.title,
      messageSeqs: [...event.data.messageSeqs],
      source: copySessionTitleSource(event.data.source),
      eventSeq: event.seq,
      updatedAt: event.time,
    })
  }
  return deepFreeze({
    title: event.data.title,
    messageSeqs: [],
    inputRefs: event.data.inputRefs.map(copySessionTitleInputRef),
    source: copySessionTitleSource(event.data.source),
    eventSeq: event.seq,
    updatedAt: event.time,
  })
}

/** Log-backed title fold plus asynchronous fallback generation. */
export class SessionTitleService extends Service {
  static inject = ['sessions', 'sessionProjections', 'agents']
  static Config: z<Config> = z.object({
    fallbackMaxWords: z.number().step(1).min(1).required(),
    fallbackMaxBytes: z.number().step(1).min(1).required(),
    maxTitleBytes: z.number().step(1).min(1).required(),
  })

  private titleInputProjectionHandle!: ProjectionHandle<TitleInputState>
  private readonly config: ResolvedConfig
  private readonly ownerFiber: Fiber
  private registration: ProviderRegistration | undefined
  private readonly work = new Map<Session, SessionTitleWorkState>()
  private readonly lifetime = new AbortController()
  private readonly inFlight = new Set<Promise<unknown>>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'sessionTitle')
    this.ownerFiber = ctx.fiber
    const candidate: unknown = config
    if (candidate === null || typeof candidate !== 'object') {
      throw new Error('session-title: configuration is required')
    }
    const value = candidate as Config
    assertPositiveInteger('fallbackMaxWords', value.fallbackMaxWords)
    assertPositiveInteger('fallbackMaxBytes', value.fallbackMaxBytes)
    assertPositiveInteger('maxTitleBytes', value.maxTitleBytes)
    if (value.fallbackMaxBytes > value.maxTitleBytes) {
      throw new Error('session-title: fallbackMaxBytes must not exceed maxTitleBytes')
    }
    this.config = deepFreeze({ ...value })
  }

  protected async [Service.init](): Promise<void> {
    const ctx = this.ctx
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('session-title service disposed'))
      if (this.registration !== undefined) this.registration.closing = true
      this.registration = undefined
      for (const state of this.work.values()) {
        delete state.pending
        state.active?.controller.abort(new Error('session-title service disposed'))
      }
      await this.drain(this.inFlight)
      this.work.clear()
    }, 'sessionTitle lifecycle')

    // oxlint-disable-next-line typescript/no-misused-promises -- session/event reports rejected observer promises without awaiting them.
    ctx.on('session/event', (session, event) => {
      switch (event.type) {
        case 'user/message':
          return this.onUserMessage(session, event)
        case 'request/header':
          this.onRequestHeader(session, event)
          break
        default:
          break
      }
    })
    ctx.on('llm/stream', (options, next) => {
      this.onMainRequest(options)
      return next()
    }, { global: true, prepend: true })
    ctx.on('session/disposed', (session) => {
      const state = this.work.get(session)
      if (state === undefined) return
      state.active?.controller.abort(new Error('session disposed during title generation'))
      this.work.delete(session)
    })

    await ctx.sessionProjections.register(titleProjectionDefinition)

    this.titleInputProjectionHandle = await ctx.sessionProjections.register<'titleInput', TitleInputState>({
      key: 'titleInput',
      stateVersion: 4,
      stateSchema: titleInputStateSchema,
      init: () => EMPTY_TITLE_INPUT,
      apply: (state, event) => advanceTitleInput(state, event).state,
    })
  }

  /**
   * Read the latest folded title from one live or replayed session.
   * @param session - session whose log is the title source of truth.
   * @returns latest title snapshot, or `undefined` before eligible input.
   */
  get(session: Session): SessionTitleSnapshot | undefined {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    return foldSessionTitle(session.snapshotEvents())
  }

  /**
   * Accept an explicit user title. Appends a `session/title` event with the
   * `user` source, which pins the title: in-flight automatic generation is
   * superseded and later user messages schedule none (an explicit
   * {@link SessionTitleService.refresh} remains the deliberate unpin).
   * @param session - exact live session to rename.
   * @param title - raw user input; normalized before acceptance.
   * @returns the accepted title snapshot.
   * @throws {SessionTitleInvalidError} when the title normalizes to empty.
   * @throws {Error} when the session is not live or the service is disposed.
   */
  rename(session: Session, title: string): SessionTitleSnapshot {
    this.assertServiceActive()
    if (this.ctx.sessions.get(session.id) !== session) {
      throw new Error(`session "${session.id}" is not live in this store`)
    }
    const normalized = normalizeSessionTitle(title, this.config.maxTitleBytes)
    if (normalized.length === 0) {
      throw new SessionTitleInvalidError('session title must contain visible characters')
    }
    const state = this.stateFor(session)
    this.supersede(state, 'user rename superseded automatic title generation')
    session.append('session/title', {
      title: normalized,
      messageSeqs: [],
      source: { kind: 'user' },
    })
    const snapshot = this.get(session)
    /* v8 ignore next -- unreachable: the append above just committed a session/title event. */
    if (snapshot === undefined) throw new Error('renamed title failed to fold')
    return snapshot
  }

  /**
   * Explicitly retry the registered provider, or materialize the built-in
   * fallback when no provider is registered.
   * @param session - exact live session to refresh.
   * @param signal - optional caller cancellation.
   * @returns latest accepted title, or `undefined` when no eligible text exists.
   */
  async refresh(session: Session, signal?: AbortSignal): Promise<SessionTitleSnapshot | undefined> {
    signal?.throwIfAborted()
    this.assertServiceActive()
    if (this.ctx.sessions.get(session.id) !== session) {
      throw new Error(`session "${session.id}" is not live in this store`)
    }
    const registration = this.registration
    const input = this.titleInputOf(session)
    if (registration === undefined || registration.closing || input.lastSeq === null) {
      // Explicit refresh is the unpin even without a provider: a standing
      // user title must not short-circuit ensureFallback into a no-op, so
      // re-derive and append the fallback over it when one is derivable.
      const current = this.get(session)
      const first = input.first
      if (current?.source.kind === 'user' && first !== null) {
        this.appendFallback(session, first)
        signal?.throwIfAborted()
        return this.get(session)
      }
      const fallback = await this.ensureFallback(session)
      signal?.throwIfAborted()
      return fallback
    }
    const state = this.stateFor(session)
    const revision = this.supersede(state, 'explicit title refresh superseded older generation')
    const work = this.activate({
      registration,
      revision,
      throughSeq: input.lastSeq,
    }, state, signal)
    const config = session.requestHeader()?.config
    const route = config === undefined ? undefined : { provider: config.provider, model: config.model }
    return this.startProvider(session, work, route)
  }

  /**
   * Register the sole optional title provider. Disposal aborts its pending and
   * active work; a replacement may register once disposal has started, and the
   * closing provider's late results never commit.
   * @param provider - provider identity, cadence, and generation function.
   * @returns exact Cordis effect disposer, which settles after active calls quiesce.
   */
  register(provider: SessionTitleProvider): () => Promise<void> {
    this.validateProvider(provider)
    if (this.registration !== undefined && !this.registration.closing) {
      throw new Error(`session-title provider "${this.registration.provider.id}" is already registered`)
    }
    const registration: ProviderRegistration = {
      provider,
      active: new Set(),
      closing: false,
    }
    const dispose = this.ctx.effect(function* (this: SessionTitleService) {
      this.registration = registration
      yield async () => {
        registration.closing = true
        for (const state of this.work.values()) {
          if (state.pending?.registration === registration) delete state.pending
          if (state.active?.registration === registration) {
            state.active.controller.abort(new Error(`session-title provider "${provider.id}" was disposed`))
          }
        }
        await this.drain(registration.active)
        if (this.registration === registration) this.registration = undefined
      }
    }.bind(this), 'sessionTitle.register()')
    return dispose
  }

  /** Schedule current-provider work; activation-time messages only request the fallback. */
  private async onUserMessage(session: Session, event: Extract<SessionEvent, { type: 'user/message' }>): Promise<void> {
    if (this.ownerFiber.state === FiberState.LOADING) {
      await this.ownerFiber.await()
      if (this.serviceActive() && this.ctx.sessions.get(session.id) === session) await this.ensureFallback(session)
      return
    }
    if (!this.serviceActive()) return
    // The projection registry observes the committed event before this listener,
    // so an admitted rewrite of a claimed human occurrence counts here exactly
    // like a directly admitted human message.
    const input = this.titleInputOf(session)
    if (input.lastSeq !== event.seq) return
    // A user rename pins the title: no automatic revision may override it.
    if (this.get(session)?.source.kind === 'user') return
    const registration = this.registration
    if (registration !== undefined && !registration.closing) {
      const shouldSchedule = registration.provider.automatic === 'all-prompts'
        || (!session.header.isSeeded && session.header.origin !== 'subagent' && input.count === 1 && this.get(session) === undefined)
      if (shouldSchedule) {
        const state = this.stateFor(session)
        const revision = this.supersede(state, 'newer user message superseded title generation')
        state.pending = { registration, revision, throughSeq: event.seq }
      }
    }
    this.defer(async () => {
      try {
        await this.ensureFallback(session)
      } catch (error: unknown) {
        if (!this.serviceActive()) return
        this.ctx.logger.warn(`session "${session.id}": fallback title update failed: ${String(error)}`)
      }
    })
  }

  /** Start pending automatic work only after its exact main-request route is logged. */
  private onRequestHeader(session: Session, event: Extract<SessionEvent, { type: 'request/header' }>): void {
    if (!this.serviceActive()) return
    const state = this.work.get(session)
    const pending = state?.pending
    if (state === undefined || pending === undefined || pending.throughSeq >= event.seq) return
    const route = {
      provider: event.data.header.config.provider,
      model: event.data.header.config.model,
    }
    this.startPending(session, state, pending, route)
  }

  /** Start unchanged-route work from the marked loop request after its header fold is current. */
  private onMainRequest(options: GenerateOptions): void {
    if (!this.serviceActive() || options.sessionId === undefined || !isAgentLoopRequest(options)) return
    const session = this.ctx.sessions.get(options.sessionId)
    const state = session === undefined ? undefined : this.work.get(session)
    const pending = state?.pending
    if (session === undefined || state === undefined || pending === undefined) return
    const boundary = this.ctx.agents.turnBoundaryOf(session).lastStepBoundary
    const route = session.requestHeader()?.config
    if (boundary?.kind !== 'start'
      || route?.provider !== options.provider
      || route.model !== options.model) return
    this.startPending(session, state, pending, { provider: options.provider, model: options.model })
  }

  /** Consume one pending revision and schedule its non-blocking provider call. */
  private startPending(
    session: Session,
    state: SessionTitleWorkState,
    pending: PendingAutomaticWork,
    route: SessionTitleModelIdentity,
  ): void {
    delete state.pending
    this.defer(async () => {
      if (this.registration !== pending.registration
        || pending.registration.closing
        || this.work.get(session) !== state
        || state.revision !== pending.revision) return
      const work = this.activate(pending, state)
      try {
        await this.startProvider(session, work, route)
      } catch (error: unknown) {
        if (work.signal.aborted || !this.serviceActive()) return
        this.ctx.logger.warn(`session "${session.id}": automatic title generation failed: ${String(error)}`)
      }
    })
  }

  /** Start one tracked provider call after publishing its active revision. */
  private startProvider(
    session: Session,
    work: ActiveProviderWork,
    route?: SessionTitleModelIdentity,
  ): Promise<SessionTitleSnapshot | undefined> {
    const run = Promise.resolve().then(() => this.runProvider(session, work, route))
    return this.track(run, work.registration)
  }

  /** Execute and accept one current provider revision. */
  private async runProvider(
    session: Session,
    work: ActiveProviderWork,
    route?: SessionTitleModelIdentity,
  ): Promise<SessionTitleSnapshot | undefined> {
    try {
      this.assertCurrent(session, work)
      await this.ensureFallback(session)
      this.assertCurrent(session, work)
      // One snapshot supplies both inputs: messages stop at the scheduled
      // watermark, while the current title is not bounded by that watermark.
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      const events = session.snapshotEvents()
      const inputs = collectSessionTitleInputs(events, work.throughSeq)
      // The provider observes frozen JSON facts. The service retains these same
      // private canonical arrays and selects refs from them after the await, so a
      // provider cannot alter the input references of the required title record.
      const messages = deepFreeze(inputs.messages.map(entry => ({ ...entry })))
      const inputRefs = deepFreeze(inputs.inputRefs.map(copySessionTitleInputRef))
      const currentTitle = foldSessionTitle(events)
      const request: SessionTitleProviderRequest = Object.freeze({
        session,
        messages,
        inputRefs,
        ...route === undefined ? {} : { route },
        ...currentTitle === undefined ? {} : { currentTitle },
        signal: work.signal,
      })
      const result = await work.registration.provider.generate(request)
      this.assertCurrent(session, work)
      const accepted = this.validateResult(result, messages)
      const selectedRefs = selectSessionTitleInputRefs(messages, inputRefs, accepted.messageSeqs)
      const source = {
        kind: 'provider' as const,
        provider: work.registration.provider.id,
        ...accepted.model === undefined ? {} : { model: accepted.model },
      }
      if (selectedRefs.some(ref => ref.kind === 'origin')) {
        session.append('session/title-from-input', {
          title: accepted.title,
          inputRefs: selectedRefs,
          source,
        })
      } else {
        session.append('session/title', {
          title: accepted.title,
          messageSeqs: [...accepted.messageSeqs],
          source,
        })
      }
      return this.get(session)
    } finally {
      const state = this.work.get(session)
      if (state?.active === work) delete state.active
    }
  }

  /** Validate and normalize provider output against the supplied message snapshot. */
  private validateResult(
    result: unknown,
    messages: readonly SessionTitleUserMessage[],
  ): SessionTitleProviderResult {
    if (result === null || typeof result !== 'object') {
      throw new Error('session-title provider returned an invalid result')
    }
    const candidate = result as Record<string, unknown>
    if (typeof candidate.title !== 'string') throw new Error('session-title provider title must be a string')
    const title = normalizeSessionTitle(candidate.title, this.config.maxTitleBytes)
    if (title.length === 0) throw new Error('session-title provider returned an empty title')
    if (!Array.isArray(candidate.messageSeqs) || candidate.messageSeqs.length === 0) {
      throw new Error('session-title provider must identify at least one source message seq')
    }
    const messageSeqs: SessionSeq[] = []
    const order = new Map(messages.map((message, index) => [message.seq, index]))
    let previous = -1
    for (const seq of candidate.messageSeqs as unknown[]) {
      if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) {
        throw new Error('session-title provider messageSeqs must be unique, ordered seqs from the request')
      }
      const sessionSeq = SessionSeq(seq)
      const index = order.get(sessionSeq)
      if (index === undefined || index <= previous) {
        throw new Error('session-title provider messageSeqs must be unique, ordered seqs from the request')
      }
      messageSeqs.push(sessionSeq)
      previous = index
    }
    const modelCandidate = candidate.model
    let model: SessionTitleModelIdentity | undefined
    if (modelCandidate !== undefined) {
      if (modelCandidate === null || typeof modelCandidate !== 'object') {
        throw new Error('session-title provider result model must contain non-empty provider and model strings')
      }
      const record = modelCandidate as Record<string, unknown>
      if (typeof record.provider !== 'string' || record.provider.length === 0
        || typeof record.model !== 'string' || record.model.length === 0) {
        throw new Error('session-title provider result model must contain non-empty provider and model strings')
      }
      model = { provider: record.provider, model: record.model }
    }
    return {
      title,
      messageSeqs,
      ...(model === undefined ? {} : { model }),
    }
  }

  /** Fail a completion whose provider, revision, session, or signal is stale. */
  private assertCurrent(session: Session, work: ActiveProviderWork): void {
    this.assertServiceActive()
    work.signal.throwIfAborted()
    const state = this.work.get(session)
    /* v8 ignore next -- every supported supersession, provider disposal, and session disposal aborts
     * the work signal before changing this state. */
    if (this.registration !== work.registration
      || state?.active !== work
      || state.revision !== work.revision
      || this.ctx.sessions.get(session.id) !== session) {
      throw new Error('session title generation state changed without cancellation')
    }
  }

  /** Create and publish an active provider call from one fixed revision. */
  private activate(
    pending: PendingAutomaticWork,
    state: SessionTitleWorkState,
    upstream?: AbortSignal,
  ): ActiveProviderWork {
    const controller = new AbortController()
    const signal = upstream === undefined
      ? AbortSignal.any([controller.signal, this.lifetime.signal])
      : AbortSignal.any([controller.signal, this.lifetime.signal, upstream])
    const work: ActiveProviderWork = { ...pending, controller, signal }
    state.active = work
    return work
  }

  /** Abort older active work and reserve the next session-local revision. */
  private supersede(state: SessionTitleWorkState, reason: string): number {
    state.active?.controller.abort(new Error(reason))
    delete state.pending
    state.revision += 1
    return state.revision
  }

  /** Return mutable work state for one session. */
  private stateFor(session: Session): SessionTitleWorkState {
    let state = this.work.get(session)
    if (state === undefined) {
      state = { revision: 0 }
      this.work.set(session, state)
    }
    return state
  }

  private titleInputOf(session: Session): TitleInputState {
    return this.titleInputProjectionHandle.stateOf(session)
  }

  /** Queue detached service work and retain it through service disposal. */
  private defer(task: () => Promise<void>): void {
    const run = Promise.resolve().then(async () => {
      if (!this.serviceActive()) return
      await task()
    })
    void this.track(run)
  }

  /** Retain one promise until settlement for service and optional provider teardown. */
  private track<T>(run: Promise<T>, registration?: ProviderRegistration): Promise<T> {
    this.inFlight.add(run)
    registration?.active.add(run)
    const settled = (): void => {
      this.inFlight.delete(run)
      registration?.active.delete(run)
    }
    void run.then(settled, settled)
    return run
  }

  /** Await every current and settling promise in one lifecycle registry. */
  private async drain(active: Set<Promise<unknown>>): Promise<void> {
    while (active.size > 0) await Promise.allSettled([...active])
  }

  /** Whether the owning plugin fiber can still start or commit title work. */
  private serviceActive(): boolean {
    return !this.lifetime.signal.aborted
      && this.ownerFiber.uid !== null
      && this.ownerFiber.state === FiberState.ACTIVE
  }

  /** Reject work once the owning plugin fiber has begun unloading. */
  private assertServiceActive(): void {
    if (!this.serviceActive()) throw new Error('session-title service disposed')
  }

  /** Reject malformed provider registrations before publishing an effect. */
  private validateProvider(provider: unknown): asserts provider is SessionTitleProvider {
    if (provider === null || typeof provider !== 'object') {
      throw new Error('session-title provider must be an object')
    }
    const candidate = provider as Record<string, unknown>
    if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
      throw new Error('session-title provider id must be a non-empty string')
    }
    if (candidate.automatic !== 'first-prompt' && candidate.automatic !== 'all-prompts') {
      throw new Error('session-title provider automatic mode is invalid')
    }
    if (typeof candidate.generate !== 'function') {
      throw new Error(`session-title provider "${candidate.id}" requires generate()`)
    }
  }

  /**
   * Derive and append the deterministic fallback title over whatever stands
   * (the refresh unpin path: overwriting a pinned user title is the point).
   * Synchronous on purpose — no await may separate derivation from append, so
   * it needs neither ensureFallback's in-flight dedup nor its liveness
   * re-check. An underivable fallback (empty after the caps) appends nothing.
   */
  private appendFallback(session: Session, first: SessionTitleInputEntry): void {
    const title = fallbackSessionTitle(first.text, this.config.fallbackMaxWords, this.config.fallbackMaxBytes)
    if (title.length === 0) return
    if (first.ref.kind === 'origin') {
      session.append('session/title-from-input', {
        title,
        inputRefs: [first.ref],
        source: { kind: 'fallback' },
      })
      return
    }
    session.append('session/title', {
      title,
      messageSeqs: [first.ref.messageSeq],
      source: { kind: 'fallback' },
    })
  }

  /** Create the first deterministic fallback if the session still lacks a title. */
  private async ensureFallback(session: Session): Promise<SessionTitleSnapshot | undefined> {
    this.assertServiceActive()
    const current = this.get(session)
    if (current !== undefined) return current
    const first = this.titleInputOf(session).first
    if (first === null) return undefined
    const title = fallbackSessionTitle(
      first.text,
      this.config.fallbackMaxWords,
      this.config.fallbackMaxBytes,
    )
    if (title.length === 0) return undefined
    const state = this.stateFor(session)
    if (state.fallback !== undefined) return state.fallback
    const fallback = Promise.resolve().then(() => {
      this.assertServiceActive()
      if (this.ctx.sessions.get(session.id) !== session) {
        throw new Error(`session "${session.id}" is not live in this store`)
      }
      const accepted = this.get(session)
      if (accepted !== undefined) return accepted
      if (first.ref.kind === 'origin') {
        session.append('session/title-from-input', {
          title,
          inputRefs: [first.ref],
          source: { kind: 'fallback' },
        })
      } else {
        session.append('session/title', {
          title,
          messageSeqs: [first.ref.messageSeq],
          source: { kind: 'fallback' },
        })
      }
      return this.get(session)
    })
    state.fallback = fallback
    try {
      return await fallback
    } finally {
      delete state.fallback
    }
  }
}

export default SessionTitleService
