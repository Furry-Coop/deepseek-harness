/**
 * Recover the caller input a recorded runtime rewrote during pre-step.
 *
 * A Host rewrite keeps the human occurrence's message identity and request
 * correlation but replaces its source kind, so the admitted `user/message`
 * no longer carries the caller text. The durable proof of that text is the
 * Inbox insertion the claim removed. This module folds the projected Session
 * (through the shared replay parser, so sequence coordinates match the events
 * the runtime actually wrote) far enough to pair the insertion with a genuine
 * claim, the entered step of the same Turn, and the same-id admission, then
 * returns the original content for replay drivers that must send what the
 * human actually sent.
 *
 * Only the caller's own occurrence qualifies: the insertion must carry the
 * human source kind, and the admission must pass the shared
 * `@deepseek-ai/dsh-session/inbox-admission` policy, including its exact
 * correlation comparison — a caller source with no request id is legal and
 * matches an admission that also carries none. Effective text never becomes
 * caller input, and a producer that merely reuses an id cannot supply one.
 *
 * @module @deepseek-ai/dsh-session-snapshot/rewritten-input
 */

import { SessionSeq } from '@deepseek-ai/dsh-session'
import {
  advanceAdmissionWindow,
  admitsRewrite,
  claimAdmissionWindow,
  inboxCorrelationOf,
  inboxSpliceKind,
  isHumanInboxOccurrence,
  type AdmissionWindow,
  type InboxMessage,
} from '@deepseek-ai/dsh-session/inbox-admission'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'

/** One recovered caller input and the Turn that admitted its rewrite. */
export interface RewrittenCallerInput {
  /** Turn whose entered step admitted the rewrite. */
  readonly turn: number
  /** Content blocks of the human Inbox occurrence the rewrite replaced. */
  readonly content: readonly Readonly<Record<string, unknown>>[]
}

/**
 * The envelope fields this fold consumes. The replay parser supplies exact
 * sequence numbers and expands packed rows before they reach this view.
 */
interface SessionRow {
  readonly type: string
  readonly seq: number
  readonly data: unknown
}

/** One pending human occurrence in an Inbox lane; `undefined` keeps another producer's slot. */
interface PendingOccurrence {
  readonly messageId: string
  readonly correlation: string | null
  readonly content: readonly Readonly<Record<string, unknown>>[]
  readonly originalInboxSeq: ReturnType<typeof SessionSeq>
}

/** One claimed occurrence that a step in its Turn may still admit. */
interface ClaimedOccurrence extends PendingOccurrence {
  readonly window: AdmissionWindow
}

/** A lane holds one slot per pending message so claim indices stay exact. */
type LaneSlot = PendingOccurrence | null

function rowObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function rowNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
  return value
}

function rowString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

function contentBlocks(value: unknown, label: string): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a content array`)
  return value.map((block, index) => rowObject(block, `${label}[${index}]`))
}

/** The identity view of one spliced message, whatever its producer. */
function involvedMessage(value: unknown, label: string): InboxMessage {
  const message = rowObject(value, label)
  const source = rowObject(message.source, `${label} source`)
  return {
    id: rowString(message.id, `${label} id`),
    source: {
      kind: rowString(source.kind, `${label} source.kind`),
      ...'rpcId' in source ? { rpcId: source.rpcId } : {},
    },
  }
}

/** Read the caller evidence of one insertion, or `null` for any other producer. */
function occurrenceOf(
  value: unknown,
  seq: ReturnType<typeof SessionSeq>,
): PendingOccurrence | null {
  const message = rowObject(value, 'agent/inbox/spliced inserted message')
  const identity = involvedMessage(message, 'agent/inbox/spliced inserted message')
  if (!isHumanInboxOccurrence(identity)) return null
  return {
    messageId: identity.id,
    correlation: inboxCorrelationOf(identity) ?? null,
    content: contentBlocks(message.content, `agent/inbox/spliced inserted message ${identity.id} content`),
    originalInboxSeq: seq,
  }
}

/**
 * Recover the caller content of every Turn whose admitted message is a Host
 * rewrite of its claimed human Inbox occurrence.
 *
 * A row that does not pair a human insertion with a claim, an entered step in
 * the claim's Turn, and the shared admission policy contributes nothing. The
 * caller correlation is compared exactly as recorded, including the legal
 * case where both the occurrence and the admission carry none.
 *
 * @param log - complete projected Session artifact, header first.
 * @returns recovered caller inputs in admission order; one per rewritten Turn.
 * @throws when the artifact is malformed, a splice or content payload is
 * invalid, a claimed identity is admitted without admission evidence, or one
 * Turn admits more than one rewritten caller input.
 */
export function recoverRewrittenCallerInputs(log: string): readonly RewrittenCallerInput[] {
  const rows: readonly SessionRow[] = parseSessionLog(log)
  const lanes: Record<'next-turn' | 'next-step', LaneSlot[]> = { 'next-turn': [], 'next-step': [] }
  let claimed: ClaimedOccurrence[] = []
  const recovered: RewrittenCallerInput[] = []
  let openTurn = 0

  for (const row of rows) {
    const seq = SessionSeq(row.seq)
    const data = (): Record<string, unknown> => rowObject(row.data, `${row.type} at session seq ${seq}`)
    switch (row.type) {
      case 'turn/start':
        openTurn = rowNumber(data().turn, 'turn/start turn')
        break
      case 'turn/end':
        openTurn = 0
        claimed = []
        break
      case 'step/end':
        claimed = []
        break
      case 'step/start': {
        if (claimed.length === 0) break
        const turn = rowNumber(data().turn, 'step/start turn')
        const step = rowNumber(data().step, 'step/start step')
        const event = { type: 'step/start' as const, seq, time: 0, data: { turn, step } }
        claimed = claimed.map(item => ({ ...item, window: advanceAdmissionWindow(item.window, event) }))
        break
      }
      case 'agent/inbox/spliced': {
        const splice = data()
        const target = splice.target
        if (target !== 'next-turn' && target !== 'next-step') {
          throw new Error(`agent/inbox/spliced at session seq ${seq} has an invalid target`)
        }
        const lane = lanes[target]
        const start = rowNumber(splice.start, 'agent/inbox/spliced start')
        const removedCount = splice.removedCount === undefined
          ? 0 : rowNumber(splice.removedCount, 'agent/inbox/spliced removedCount')
        if (!Array.isArray(splice.inserted)) {
          throw new Error(`agent/inbox/spliced at session seq ${seq} has no inserted array`)
        }
        if (start > lane.length || start + removedCount > lane.length) {
          throw new Error(`agent/inbox/spliced at session seq ${seq} removes beyond its lane`)
        }
        const insertedMessages = splice.inserted.map((message) => {
          return involvedMessage(message, 'agent/inbox/spliced inserted message')
        })
        const kind = inboxSpliceKind({
          start,
          removedCount,
          inserted: insertedMessages,
          ...splice.outcome === 'canceled' ? { outcome: 'canceled' as const } : {},
        })
        const removed = lane.splice(start, removedCount, ...splice.inserted.map((message) => {
          return occurrenceOf(message, seq)
        }))
        if (kind !== 'claim' || openTurn === 0) break
        for (const occurrence of removed) {
          if (occurrence === null) continue
          claimed.push({ ...occurrence, window: claimAdmissionWindow(openTurn, seq) })
        }
        break
      }
      case 'user/message': {
        if (claimed.length === 0) break
        const message = data()
        const messageId = rowString(message.id, 'user/message id')
        const claimIndex = claimed.findIndex(item => item.messageId === messageId)
        if (claimIndex < 0) break
        const occurrence = claimed[claimIndex] as ClaimedOccurrence
        const admitted = involvedMessage(message, `user/message ${messageId}`)
        if (admitted.source.kind === 'user') {
          claimed.splice(claimIndex, 1)
          break
        }
        const isRewrite = admitsRewrite(occurrence.window, admitted, seq, {
          messageId: occurrence.messageId,
          correlation: occurrence.correlation,
        })
        if (!isRewrite) {
          throw new Error(
            `user/message "${messageId}" at session seq ${seq} replaced a claimed human occurrence `
            + 'without the claim, entered-step, and correlation evidence admission requires',
          )
        }
        claimed.splice(claimIndex, 1)
        if (recovered.some(entry => entry.turn === openTurn)) {
          throw new Error(`Turn ${openTurn} admitted more than one rewritten caller input`)
        }
        recovered.push({ turn: openTurn, content: occurrence.content })
        break
      }
      default:
        break
    }
  }
  return recovered
}
