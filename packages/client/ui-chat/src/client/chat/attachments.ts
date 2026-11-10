import type {
  ConversationAttachment as Attachment, NodeReference, RenderEntry, TurnLocation,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SessionSeq, type SessionSeq as SessionSeqValue } from '@deepseek-ai/dsh-session/types'
import type { ChatConversationViewNode } from '../contract/chat-nodes.ts'
import type { ChatAttachmentHost, ChatAttachmentSite } from '../contract/slots.ts'

/** One resolved attachment occurrence in the Chat row sequence. */
export interface ChatAttachmentPlacement {
  readonly attachment: Readonly<Attachment>
  readonly site: ChatAttachmentSite
  /** Turn identity whose durable boundaries anchor this card. */
  readonly turn: number
  /**
   * Durable sequence the resolved site stands at. A precise tool row reports
   * the row's own durable source event only; a transient or synthetic anchor
   * position is never reported as a durable seq.
   */
  readonly seq?: SessionSeqValue
  /**
   * Root-entry insertion position. `null` for a row-hosted card — a Tool
   * call's own row, a Step's visible entry, or its owning process group —
   * which a native seat renders instead of a synthetic root row.
   */
  readonly index: number | null
  /** Target tool call for a precise `tool-call` site. */
  readonly targetCallId?: string
  /**
   * Unique target Node reference for a row-hosted card. `targetPart` names the
   * rendered part when one Node is presented twice (an Assistant reply's
   * reasoning run and its response row), so only that entry hosts the card.
   */
  readonly targetNodeKey?: string
  readonly targetPart?: string
  /** Owning process group whose visible entry hosts the card. */
  readonly targetGroupKey?: string
  /**
   * Where this card is laid out: the measured blank beside the content column,
   * or its position inside the flow. Assigned by the view after resolution.
   */
  host?: ChatAttachmentHost
}

/** Inputs needed to resolve every attachment against the displayed Chat window. */
export interface ChatAttachmentScene {
  readonly attachments: readonly Attachment[]
  readonly entries: readonly RenderEntry[]
  readonly turns: ReadonlyMap<number, TurnLocation>
  readonly nodes: readonly ChatConversationViewNode[]
  readonly nodeOf: (key: string) => ChatConversationViewNode | undefined
  /** Members of one grouped root entry, when the displayed view groups Nodes. */
  readonly groupMembers: (key: string) => readonly NodeReference[] | undefined
}

interface TurnRow {
  readonly index: number
  /** Durable source event seq this row presents, when it declares one. */
  readonly sourceSeq: number | undefined
}

interface ToolCallNode extends ChatConversationViewNode {
  readonly kind: 'tool-call'
  readonly data: { readonly root: { readonly callId: string } }
}

type ToolTargets = ReadonlyMap<number, ReadonlyMap<string, ToolTarget>>

/**
 * One callId's loaded Tool Nodes inside a Turn.
 *
 * A repeated callId in the same Turn names more than one row, so no single row
 * can be claimed as the target; the card then keeps the Turn's visible start.
 */
type ToolTarget =
  | { readonly kind: 'one'; readonly node: ToolCallNode }
  | { readonly kind: 'ambiguous' }

const NO_PLACEMENTS: readonly ChatAttachmentPlacement[] = []

/**
 * Resolve attachment anchors against the loaded Chat timeline.
 *
 * A Turn that is not loaded has no place to mount: the card is omitted until a
 * history page supplies it. A loaded Turn whose exact anchor cannot be
 * resolved — an event whose loaded row declares another durable seq, a missing
 * callId, a callId outside the declared Turn, or a callId carried by more than
 * one loaded row — falls back to that Turn's visible first entry.
 *
 * An `event` anchor first matches a loaded root row that declares that durable
 * seq as its own source. A `step/start` has no row of its own, so it next
 * matches a loaded Step whose `start.seq` is that seq and mounts at that Step's
 * visible entry — its first visible row — which the native process group and
 * whole-Turn entry keep reachable while those surfaces are folded. A seq with
 * neither is the Turn's start entry. The row's sortable `anchorSeq` may be a
 * transient or synthetic fraction and is never compared with a durable seq.
 * A tool-call target is resolved only by the loaded Tool Node's own callId;
 * ordinal adjacency or the first duplicate is never used as a substitute.
 * @param scene - registered cards plus the displayed rows, Turns, and Nodes.
 * @returns placement per mountable card, in registration order.
 */
export function resolveChatAttachmentPlacements(scene: ChatAttachmentScene): readonly ChatAttachmentPlacement[] {
  if (scene.attachments.length === 0) return NO_PLACEMENTS
  const rowsByTurn = turnRows(scene)
  const toolTargets = toolCallTargets(scene)
  const placements: ChatAttachmentPlacement[] = []
  for (const attachment of scene.attachments) {
    const placement = resolveOne(scene, attachment, rowsByTurn, toolTargets)
    if (placement !== undefined) placements.push(placement)
  }
  return placements
}

/**
 * Compare two resolved scenes by the facts that place cards.
 * @param left - previous placements.
 * @param right - next placements.
 * @returns whether every card keeps its identity and position.
 */
export function sameChatAttachmentPlacements(
  left: readonly ChatAttachmentPlacement[],
  right: readonly ChatAttachmentPlacement[],
): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (const [index, a] of left.entries()) {
    const b = right[index]
    if (b === undefined) return false
    if (a.attachment !== b.attachment || a.site !== b.site || a.turn !== b.turn
      || a.seq !== b.seq || a.index !== b.index
      || a.targetCallId !== b.targetCallId || a.targetNodeKey !== b.targetNodeKey
      || a.targetPart !== b.targetPart || a.targetGroupKey !== b.targetGroupKey
      || a.host !== b.host) return false
  }
  return true
}

type RowsByTurn = ReadonlyMap<number, readonly TurnRow[]>

function turnRows(scene: ChatAttachmentScene): RowsByTurn {
  const rows = new Map<number, TurnRow[]>()
  for (const [index, entry] of scene.entries.entries()) {
    if (entry.kind !== 'node') continue
    const node = scene.nodeOf(entry.key)
    if (node === undefined) continue
    const location = node.location
    if (location.kind !== 'turn' && location.kind !== 'step') continue
    const turn = location.turn.turn
    let turnRows = rows.get(turn)
    if (turnRows === undefined) {
      turnRows = []
      rows.set(turn, turnRows)
    }
    turnRows.push({ index, sourceSeq: node.sourceSeq })
  }
  return rows
}

function toolCallTargets(scene: ChatAttachmentScene): ToolTargets {
  const needsTargets = scene.attachments.some(attachment => attachment.anchor.kind === 'tool-call')
  if (!needsTargets) return new Map()
  const targets = new Map<number, Map<string, ToolTarget>>()
  for (const node of scene.nodes) {
    if (!isToolCallNode(node)) continue
    const location = node.location
    if (location.kind !== 'turn' && location.kind !== 'step') continue
    let byCall = targets.get(location.turn.turn)
    if (byCall === undefined) {
      byCall = new Map()
      targets.set(location.turn.turn, byCall)
    }
    const callId = node.data.root.callId
    const existing = byCall.get(callId)
    if (existing === undefined) byCall.set(callId, { kind: 'one', node })
    else if (existing.kind === 'one' && existing.node !== node) byCall.set(callId, { kind: 'ambiguous' })
  }
  return targets
}

function isToolCallNode(node: ChatConversationViewNode): node is ToolCallNode {
  if (node.kind !== 'tool-call') return false
  const data: unknown = node.data
  if (typeof data !== 'object' || data === null || !('root' in data)) return false
  const root: unknown = data.root
  return typeof root === 'object' && root !== null && 'callId' in root && typeof root.callId === 'string'
}

/** One rendered entry or group member that references a Node. */
interface EntryReference {
  readonly entry: RenderEntry
  readonly part: string | undefined
}

/**
 * Locate every rendered reference to one Node.
 *
 * A Node may be presented twice — an Assistant reply's reasoning part inside a
 * process group and its response part as a root row — so a row-hosted card
 * claims a position only when exactly one reference names it.
 * @param scene - displayed rows, groups, and Nodes.
 * @param nodeKey - Node whose rendered reference to find.
 * @returns every entry or member reference, in rendered order.
 */
function entryReferences(scene: ChatAttachmentScene, nodeKey: string): readonly EntryReference[] {
  const references: EntryReference[] = []
  for (const entry of scene.entries) {
    if (entry.kind === 'node') {
      if (entry.key === nodeKey) references.push({ entry, part: entry.groupPart })
      continue
    }
    const member = scene.groupMembers(entry.key)?.find(candidate => candidate.key === nodeKey)
    if (member !== undefined) references.push({ entry, part: member.groupPart })
  }
  return references
}

function inStep(node: ChatConversationViewNode | undefined, turn: number, step: number): boolean {
  if (node === undefined || node.visibility !== 'visible') return false
  const location = node.location
  return location.kind === 'step' && location.turn.turn === turn && location.step.step === step
}

/**
 * Resolve a loaded `step/start` to that Step's visible entry.
 *
 * The first rendered entry holding a visible row of the Step wins: a Node entry
 * hosts the card at that row, while a process group hosts it at the group's
 * visible entry, which stays reachable while the group is folded.
 * @param scene - displayed rows, groups, and Nodes.
 * @param turn - owning Turn.
 * @param startSeq - durable `step/start` seq.
 * @returns the unique target entry, or undefined when the Step has no loaded row.
 */
function stepEntryTarget(
  scene: ChatAttachmentScene,
  turn: TurnLocation,
  startSeq: number,
): Pick<ChatAttachmentPlacement, 'targetNodeKey' | 'targetPart' | 'targetGroupKey'> | undefined {
  const step = turn.steps.find(candidate => candidate.start?.seq === startSeq)
  if (step === undefined) return undefined
  for (const entry of scene.entries) {
    if (entry.kind === 'node') {
      if (!inStep(scene.nodeOf(entry.key), turn.turn, step.step)) continue
      return {
        targetNodeKey: entry.key,
        ...entry.groupPart === undefined ? {} : { targetPart: entry.groupPart },
      }
    }
    const members = scene.groupMembers(entry.key)
    if (!members?.some(member => inStep(scene.nodeOf(member.key), turn.turn, step.step))) continue
    return { targetGroupKey: entry.key }
  }
  return undefined
}

function resolveOne(
  scene: ChatAttachmentScene,
  attachment: Attachment,
  rowsByTurn: RowsByTurn,
  toolTargets: ToolTargets,
): ChatAttachmentPlacement | undefined {
  const { anchor } = attachment
  const turn = scene.turns.get(anchor.turn)
  if (turn === undefined) return undefined
  const rows = rowsByTurn.get(anchor.turn)
  if (rows === undefined || rows.length === 0) return undefined
  const first = rows[0]
  const last = rows.at(-1)
  if (first === undefined || last === undefined) return undefined
  const startSeq = turn.start?.seq ?? turn.end?.seq
  if (startSeq === undefined) return undefined
  const start: ChatAttachmentPlacement = {
    attachment,
    site: 'turn-start',
    turn: anchor.turn,
    seq: startSeq,
    index: first.index,
  }
  switch (anchor.kind) {
    case 'turn-start':
      return start
    case 'turn-end':
      return turn.status === 'closed' && turn.end !== undefined
        ? { attachment, site: 'turn-end', turn: anchor.turn, seq: turn.end.seq, index: last.index + 1 }
        : start
    case 'event': {
      const exact = rows.find(row => row.sourceSeq === anchor.seq)
      if (exact !== undefined) {
        return { attachment, site: 'event', turn: anchor.turn, seq: anchor.seq, index: exact.index }
      }
      // A `step/start` has no row of its own; the loaded Step's visible entry
      // carries it and the native group/Turn disclosures keep it reachable.
      const stepEntry = stepEntryTarget(scene, turn, anchor.seq)
      if (stepEntry !== undefined) {
        return {
          attachment,
          site: 'event',
          turn: anchor.turn,
          seq: anchor.seq,
          index: null,
          ...stepEntry,
        }
      }
      // A durable event with no loaded row or Step boundary that declares it
      // stays at the Turn's confirmed entry rather than guessing from row order.
      return start
    }
    case 'tool-call': {
      const target = toolTargets.get(anchor.turn)?.get(anchor.callId)
      // A missing, unloaded, or duplicated callId has no single owning row.
      if (target === undefined || target.kind !== 'one') return start
      const references = entryReferences(scene, target.node.key)
      // A row presented more than once cannot claim one position.
      if (references.length !== 1) return start
      const reference = references[0]
      if (reference === undefined) return start
      return {
        attachment,
        site: 'tool-call',
        turn: anchor.turn,
        ...target.node.sourceSeq === undefined ? {} : { seq: SessionSeq(target.node.sourceSeq) },
        index: null,
        targetCallId: anchor.callId,
        targetNodeKey: target.node.key,
        ...reference.part === undefined ? {} : { targetPart: reference.part },
      }
    }
    default:
      return start
  }
}
