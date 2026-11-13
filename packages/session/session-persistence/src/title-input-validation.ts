/**
 * Cold-read validation for the two required title-input event kinds.
 *
 * A session file can only be interpreted safely when every frozen input
 * reference in `session/title-from-input` and
 * `session/title-llm-request-from-input` names the admission evidence it
 * claims: a real human `user/message`, or a claimed human Inbox occurrence
 * whose same-id rewrite entered the first step of the claim's Turn. This
 * module proves that from the same log, using the shared pure admission policy.
 *
 * The check runs only for a log that contains one of these events, so older
 * logs keep their current read behavior. It performs one temporary fold of the
 * Inbox lanes and claims, and remembers admission facts only for the exact
 * `admittedSeq` values the log's new events reference — it is not a persistent
 * index and keeps no history beyond the live lanes and claims it must fold to
 * validate those references. Storage errors are raised as plain `Error`; the
 * storage-contract wrapper classifies them as corruption.
 *
 * @module @deepseek-ai/dsh-session-persistence/title-input-validation
 */

import { SessionSeq } from '@deepseek-ai/dsh-session'
import {
  advanceAdmissionWindow,
  admitsRewrite,
  claimAdmissionWindow,
  inboxCorrelationOf,
  inboxSpliceKind,
} from '@deepseek-ai/dsh-session/inbox-admission'
import type {
  AdmissionWindow,
  InboxMessage,
  InboxSpliceView,
} from '@deepseek-ai/dsh-session/inbox-admission'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** The durable event fields this validator reads without depending on Agent/Title packages. */
interface StoredEventRecord {
  readonly type: string
  readonly seq: SessionSeq
  readonly data: unknown
}

/** One parsed input reference with its admission-order sort key. */
type ParsedInputRef =
  | { readonly kind: 'message'; readonly messageSeq: number; readonly sortSeq: number }
  | {
    readonly kind: 'origin'
    readonly originalInboxSeq: number
    readonly messageId: string
    readonly claimSeq: number
    readonly admittedSeq: number
    readonly sortSeq: number
  }

/** One live pending occurrence of the temporary Inbox fold. */
interface PendingOccurrence {
  readonly messageId: string
  readonly originalInboxSeq: SessionSeq
  readonly correlation: string | undefined
  readonly target: string
  index: number
}

/** One claimed occurrence and the window proving whether its rewrite may enter. */
interface ClaimedOccurrence extends PendingOccurrence {
  readonly window: AdmissionWindow
}

/** The admission evidence remembered for one referenced `user/message` seq. */
interface AdmissionFact {
  readonly originalInboxSeq: SessionSeq
  readonly messageId: string
  readonly claimSeq: SessionSeq | null
  readonly rewrite: boolean
}

/** The two new event kinds this gate validates. */
const TITLE_FROM_INPUT = 'session/title-from-input'
const TITLE_LLM_REQUEST_FROM_INPUT = 'session/title-llm-request-from-input'

/** Title text the writer normalized: non-empty, trimmed, one line, no controls. */
const NORMALIZED_TITLE_CONTROL = /[\u0000-\u001F\u007F-\u009F]/u
const NORMALIZED_TITLE_REPEATED_WHITESPACE = /\s{2,}/u

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function expectRecord(value: unknown, subject: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${subject} must be an object`)
  return value
}

function expectSeq(value: unknown, subject: string): number {
  if (!isSeq(value)) throw new Error(`${subject} must be a non-negative safe integer`)
  return value
}

function expectPositiveSeq(value: unknown, subject: string): number {
  const seq = expectSeq(value, subject)
  if (seq <= 0) throw new Error(`${subject} must be a positive integer`)
  return seq
}

function expectNonEmptyString(value: unknown, subject: string): string {
  if (!isNonEmptyString(value)) throw new Error(`${subject} must be a non-empty string`)
  return value
}

function expectLaneTarget(value: unknown): string {
  if (value !== 'next-turn' && value !== 'next-step') {
    throw new Error('an inbox splice target must be "next-turn" or "next-step"')
  }
  return value
}

function asStoredEvent(event: SessionEvent): StoredEventRecord {
  return { type: event.type, seq: event.seq, data: event.data }
}

function isTitleInputType(type: string): boolean {
  return type === TITLE_FROM_INPUT || type === TITLE_LLM_REQUEST_FROM_INPUT
}

/** A title the producer normalized; the gate rejects an unnormalized or empty one. */
function expectNormalizedTitle(value: unknown, subject: string): void {
  if (!isNonEmptyString(value)) throw new Error(`${subject} title must be a non-empty string`)
  if (value !== value.trim()
    || NORMALIZED_TITLE_CONTROL.test(value)
    || NORMALIZED_TITLE_REPEATED_WHITESPACE.test(value)) {
    throw new Error(`${subject} title must be normalized non-empty text`)
  }
}

function expectModelIdentity(value: unknown, subject: string): void {
  const identity = expectRecord(value, subject)
  expectNonEmptyString(identity['provider'], `${subject}.provider`)
  expectNonEmptyString(identity['model'], `${subject}.model`)
}

/** A generated title source; an explicit user pin is not valid for either new event. */
function expectGeneratedSource(value: unknown, subject: string): void {
  const source = expectRecord(value, subject)
  switch (source['kind']) {
    case 'fallback':
      return
    case 'provider':
      expectNonEmptyString(source['provider'], `${subject}.provider`)
      if (source['model'] !== undefined) expectModelIdentity(source['model'], `${subject}.model`)
      return
    default:
      throw new Error(`${subject} source must be "fallback" or "provider"`)
  }
}

/**
 * Parse and validate one event's `inputRefs`: non-empty, unique, ordered, at
 * least one origin, and every cited seq strictly before the event itself.
 * @param value - raw `inputRefs` field.
 * @param eventSeq - seq of the event that cites them.
 * @param subject - event label for diagnostics.
 * @returns the parsed references in admission order.
 */
function expectInputRefs(value: unknown, eventSeq: SessionSeq, subject: string): ParsedInputRef[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${subject} inputRefs must be a non-empty array`)
  }
  const refs: ParsedInputRef[] = []
  let previous = -1
  let hasOrigin = false
  for (const entry of value) {
    const ref = expectRecord(entry, `${subject} inputRefs[]`)
    switch (ref['kind']) {
      case 'message': {
        const messageSeq = expectSeq(ref['messageSeq'], `${subject} inputRefs[].messageSeq`)
        if (messageSeq >= eventSeq) throw new Error(`${subject} inputRefs[].messageSeq must be before the event`)
        if (messageSeq <= previous) throw new Error(`${subject} inputRefs must be unique and ordered`)
        previous = messageSeq
        refs.push({ kind: 'message', messageSeq, sortSeq: messageSeq })
        break
      }
      case 'origin': {
        const originalInboxSeq = expectSeq(ref['originalInboxSeq'], `${subject} inputRefs[].originalInboxSeq`)
        const claimSeq = expectPositiveSeq(ref['claimSeq'], `${subject} inputRefs[].claimSeq`)
        const admittedSeq = expectPositiveSeq(ref['admittedSeq'], `${subject} inputRefs[].admittedSeq`)
        const messageId = expectNonEmptyString(ref['messageId'], `${subject} inputRefs[].messageId`)
        if (originalInboxSeq >= claimSeq || claimSeq >= admittedSeq) {
          throw new Error(`${subject} inputRefs[] must order originalInboxSeq < claimSeq < admittedSeq`)
        }
        if (admittedSeq >= eventSeq) throw new Error(`${subject} inputRefs[].admittedSeq must be before the event`)
        if (admittedSeq <= previous) throw new Error(`${subject} inputRefs must be unique and ordered`)
        previous = admittedSeq
        hasOrigin = true
        refs.push({ kind: 'origin', originalInboxSeq, messageId, claimSeq, admittedSeq, sortSeq: admittedSeq })
        break
      }
      default:
        throw new Error(`${subject} inputRefs[].kind must be "message" or "origin"`)
    }
  }
  if (!hasOrigin) throw new Error(`${subject} must cite at least one origin input`)
  return refs
}

/** The exact model-visible auxiliary request fields recorded with a title-LLM request. */
function expectAuditMessages(value: unknown, subject: string): void {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error(`${subject} messages must contain exactly one user message`)
  }
  const message = expectRecord(value[0], `${subject} messages[0]`)
  if (message['role'] !== 'user') throw new Error(`${subject} messages[0] must be a user message`)
  expectNonEmptyString(message['id'], `${subject} messages[0].id`)
  const content = message['content']
  if (!Array.isArray(content) || content.length !== 1) {
    throw new Error(`${subject} messages[0].content must contain exactly one text block`)
  }
  const block = expectRecord(content[0], `${subject} messages[0].content[0]`)
  if (block['type'] !== 'text' || typeof block['text'] !== 'string') {
    throw new Error(`${subject} messages[0].content[0] must be a text block`)
  }
  const source = expectRecord(message['source'], `${subject} messages[0].source`)
  if (source['kind'] !== 'dsh-session-title-llm') {
    throw new Error(`${subject} messages[0].source.kind must be "dsh-session-title-llm"`)
  }
}

/**
 * Validate one new title event's payload and return its parsed references.
 * @param type - the event type (`session/title-from-input` or its LLM-request sibling).
 * @param eventSeq - seq of the event.
 * @param data - raw event payload.
 * @returns the parsed input references.
 */
function parseTitleEventData(type: string, eventSeq: SessionSeq, data: unknown): ParsedInputRef[] {
  const subject = `${type} at seq ${eventSeq}`
  const payload = expectRecord(data, subject)
  if (type === TITLE_FROM_INPUT) {
    expectNormalizedTitle(payload['title'], subject)
    expectGeneratedSource(payload['source'], `${subject} source`)
    return expectInputRefs(payload['inputRefs'], eventSeq, subject)
  }
  expectNonEmptyString(payload['titleProvider'], `${subject} titleProvider`)
  expectModelIdentity(payload['route'], `${subject} route`)
  if (typeof payload['system'] !== 'string') throw new Error(`${subject} system must be a string`)
  expectAuditMessages(payload['messages'], subject)
  expectPositiveSeq(payload['maxTokens'], `${subject} maxTokens`)
  if (payload['reasoningEffort'] !== undefined) {
    expectNonEmptyString(payload['reasoningEffort'], `${subject} reasoningEffort`)
  }
  return expectInputRefs(payload['inputRefs'], eventSeq, subject)
}

/** Parse one inserted/pending user message into the fields admission decisions read. */
function parseInboxMessage(value: unknown, subject: string): InboxMessage {
  const message = expectRecord(value, subject)
  const id = expectNonEmptyString(message['id'], `${subject}.id`)
  const source = expectRecord(message['source'], `${subject}.source`)
  const kind = expectNonEmptyString(source['kind'], `${subject}.source.kind`)
  return {
    id,
    source: Object.hasOwn(source, 'rpcId')
      ? { kind, rpcId: source['rpcId'] }
      : { kind },
  }
}

/** Parse one splice payload into the structural view the shared policy consumes. */
function parseSplice(value: unknown): InboxSpliceView {
  const splice = expectRecord(value, 'agent/inbox/spliced')
  const start = expectSeq(splice['start'], 'agent/inbox/spliced.start')
  const removedCount = splice['removedCount'] === undefined
    ? 0
    : expectSeq(splice['removedCount'], 'agent/inbox/spliced.removedCount')
  const inserted = splice['inserted']
  if (!Array.isArray(inserted)) throw new Error('agent/inbox/spliced.inserted must be an array')
  const parsed = inserted.map(entry => parseInboxMessage(entry, 'agent/inbox/spliced.inserted[]'))
  if (splice['outcome'] !== undefined && splice['outcome'] !== 'canceled') {
    throw new Error('agent/inbox/spliced.outcome must be "canceled" when present')
  }
  return splice['outcome'] === 'canceled'
    ? { start, removedCount, inserted: parsed, outcome: 'canceled' }
    : { start, removedCount, inserted: parsed }
}

/**
 * Validate the input references of one new title event against the folded log.
 * @param refs - parsed references in admission order.
 * @param facts - admission evidence remembered for referenced `admittedSeq` values.
 * @param humanSeqs - seqs proven to be human `user/message` events.
 */
function assertReferences(
  refs: readonly ParsedInputRef[],
  facts: ReadonlyMap<SessionSeq, AdmissionFact>,
  humanSeqs: ReadonlySet<SessionSeq>,
  subject: string,
): void {
  for (const ref of refs) {
    if (ref.kind === 'message') {
      if (!humanSeqs.has(SessionSeq(ref.messageSeq))) {
        throw new Error(`${subject} cites message seq ${ref.messageSeq}, which is not a human user/message`)
      }
      continue
    }
    const admittedSeq = SessionSeq(ref.admittedSeq)
    const fact = facts.get(admittedSeq)
    if (fact === undefined) {
      throw new Error(`${subject} cites admitted seq ${ref.admittedSeq}, which is not an admitted rewrite`)
    }
    if (!fact.rewrite
      || fact.originalInboxSeq !== SessionSeq(ref.originalInboxSeq)
      || fact.claimSeq !== SessionSeq(ref.claimSeq)
      || fact.messageId !== ref.messageId) {
      throw new Error(`${subject} origin ref at admitted seq ${ref.admittedSeq} does not match its claim and admission`)
    }
  }
}

/**
 * Fold the Inbox lanes and claims of one log and validate every new title
 * event's frozen references.
 * @param events - the complete decoded event log, in seq order.
 * @param directSeqs - referenced human `user/message` seqs.
 * @param admittedSeqs - referenced origin `admittedSeq` values.
 */
function foldAndValidate(
  events: readonly SessionEvent[],
  directSeqs: ReadonlySet<number>,
  admittedSeqs: ReadonlySet<number>,
): void {
  const lanes = new Map<string, PendingOccurrence[]>()
  // Every lane's real length counts producer occurrences too; splice coordinates
  // address the complete pending lane, while `lanes` keeps only human entries.
  const laneLengths = new Map<string, number>()
  let claimed: ClaimedOccurrence[] = []
  let openTurn = 0
  const facts = new Map<SessionSeq, AdmissionFact>()
  const humanSeqs = new Set<SessionSeq>()

  for (const event of events) {
    const record = asStoredEvent(event)
    switch (record.type) {
      case 'turn/start': {
        const payload = expectRecord(record.data, 'turn/start')
        const turn = expectSeq(payload['turn'], 'turn/start.turn')
        if (turn !== openTurn) openTurn = turn
        break
      }
      case 'turn/end':
        openTurn = 0
        claimed = []
        break
      case 'step/start': {
        if (claimed.length === 0) break
        claimed = claimed.flatMap((item) => {
          const window = advanceAdmissionWindow(item.window, event)
          return window.claimSeq === null ? [] : [{ ...item, window }]
        })
        break
      }
      case 'step/end':
        claimed = []
        break
      case 'agent/inbox/spliced': {
        const splice = parseSplice(record.data)
        const target = expectLaneTarget(expectRecord(record.data, 'agent/inbox/spliced')['target'])
        const lane = lanes.get(target) ?? []
        const laneLength = laneLengths.get(target) ?? 0
        const removedCount = splice.removedCount ?? 0
        const end = splice.start + removedCount
        if (end > laneLength) {
          throw new Error(`agent/inbox/spliced at seq ${record.seq} removes past the ${target} lane`)
        }
        const kind = inboxSpliceKind(splice)
        const replacedIds = new Set(splice.inserted.map(message => message.id))
        claimed = claimed.filter(item => !replacedIds.has(item.messageId))
        const nextLane: PendingOccurrence[] = []
        for (const item of lane) {
          if (item.index >= splice.start && item.index < end) {
            // A claim opens a window for the occurrence exactly at the removed position.
            if (kind === 'claim' && openTurn > 0) {
              claimed.push({ ...item, window: claimAdmissionWindow(openTurn, record.seq) })
            }
            continue
          }
          if (item.index >= end) {
            nextLane.push({ ...item, index: item.index + splice.inserted.length - removedCount })
            continue
          }
          nextLane.push(item)
        }
        for (const [offset, message] of splice.inserted.entries()) {
          if (message.source.kind !== 'user') continue
          nextLane.push({
            messageId: message.id,
            originalInboxSeq: record.seq,
            correlation: inboxCorrelationOf(message),
            target,
            index: splice.start + offset,
          })
        }
        laneLengths.set(target, laneLength - removedCount + splice.inserted.length)
        lanes.set(target, nextLane)
        break
      }
      case 'user/message': {
        const message = parseInboxMessage(record.data, 'user/message')
        // Only a committed splice changes the authoritative Inbox. A user/message
        // that merely repeats a pending id does not remove that occurrence; a
        // later real claim must still find it.
        const admittedIndex = claimed.findIndex(item => item.messageId === message.id)
        if (admittedIndex >= 0) {
          const item = claimed[admittedIndex]
          if (item === undefined) throw new Error(`user/message at seq ${record.seq} lost its claim`)
          const rewritten = admitsRewrite(item.window, message, record.seq, {
            messageId: item.messageId,
            correlation: item.correlation ?? null,
          })
          if (message.source.kind === 'user' || rewritten) {
            claimed = claimed.filter((_, index) => index !== admittedIndex)
            if (admittedSeqs.has(record.seq)) {
              facts.set(record.seq, {
                originalInboxSeq: item.originalInboxSeq,
                messageId: item.messageId,
                claimSeq: item.window.claimSeq,
                rewrite: rewritten,
              })
            }
          }
        }
        if (directSeqs.has(record.seq) && message.source.kind === 'user') humanSeqs.add(record.seq)
        break
      }
      case TITLE_FROM_INPUT:
      case TITLE_LLM_REQUEST_FROM_INPUT: {
        const refs = parseTitleEventData(record.type, record.seq, record.data)
        assertReferences(refs, facts, humanSeqs, `${record.type} at seq ${record.seq}`)
        break
      }
      default:
        break
    }
  }
}

/**
 * Validate the two new required title-input events in one decoded stored log.
 *
 * Performs no work when the log contains neither event, preserving every
 * existing read path. A referenced human message, an unclaimed rewrite, a
 * consumed claim window, a mismatched id or correlation, an unordered or
 * duplicated selection, and a malformed audit request all raise an `Error`
 * that the storage-contract wrapper turns into `SessionPersistenceCorruptionError`.
 *
 * @param events - the complete decoded event log, in seq order.
 * @throws {Error} when a new title event's payload or references are inconsistent.
 */
export function validateTitleInputEvents(events: readonly SessionEvent[]): void {
  let directSeqs: Set<number> | undefined
  let admittedSeqs: Set<number> | undefined
  for (const event of events) {
    const record = asStoredEvent(event)
    if (!isTitleInputType(record.type)) continue
    const refs = parseTitleEventData(record.type, record.seq, record.data)
    directSeqs ??= new Set()
    admittedSeqs ??= new Set()
    for (const ref of refs) {
      if (ref.kind === 'message') directSeqs.add(ref.messageSeq)
      else admittedSeqs.add(ref.admittedSeq)
    }
  }
  if (directSeqs === undefined || admittedSeqs === undefined) return
  foldAndValidate(events, directSeqs, admittedSeqs)
}
