/** Chat-owned segmentation and incremental summaries over materialized Node inputs. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  ConversationGroupDefinition, ConversationGroupInput, GroupKey, GroupSnapshot,
  GroupUpdate, NodeKey, NodeReference, RenderEntry,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatConversationViewNode, ChatNode } from '../contract/chat-nodes.ts'
import type { ProcessActivitySummary, ProcessGroupData } from '../contract/process-groups.ts'
import { hasAssistantReplyContent } from '../contract/assistant-content.ts'
import { isVisibleChatNode } from '../contract/chat-visibility.ts'
import { isAtOrOutside, isProcessTail } from '../contract/group-tree.ts'
import { processActivity } from './process-activity.ts'

type ProcessInput = ConversationGroupInput<ChatConversationViewNode>

function turnOf(node: ChatNode): number | undefined {
  const location = node.location
  return location.kind === 'turn' || location.kind === 'step' ? location.turn.turn : undefined
}

function reasoning(node: ChatNode): boolean {
  return node.kind === 'assistant-step'
    && node.data.blocks.some(block => block.kind === 'reasoning' && block.text.trim() !== '')
}

function reply(node: ChatNode): boolean {
  return node.kind === 'assistant-step' && hasAssistantReplyContent(node.data.blocks)
}

function sameSummary(left: ProcessActivitySummary, right: ProcessActivitySummary): boolean {
  return left.running === right.running && left.runningDetail === right.runningDetail
    && left.preparing === right.preparing
    && left.contribution?.key === right.contribution?.key
    && left.contribution?.kind === right.contribution?.kind
    && left.contribution?.anchorSeq === right.contribution?.anchorSeq
    && left.counts.length === right.counts.length && left.counts.every((value, index) =>
    value.kind === right.counts[index]?.kind && value.count === right.counts[index].count)
}

function sameMembers(left: readonly NodeReference[], right: readonly NodeReference[]): boolean {
  return left.length === right.length && left.every((value, index) =>
    value.key === right[index]?.key && value.groupPart === right[index].groupPart)
}

function structureChanged(previous: ChatNode | undefined, current: ChatNode): boolean {
  if (!isVisibleChatNode(current) && (previous === undefined || !isVisibleChatNode(previous))) return false
  return previous === undefined || previous.kind !== current.kind
    || turnOf(previous) !== turnOf(current)
    || isVisibleChatNode(previous) !== isVisibleChatNode(current)
    || previous.groupTree !== current.groupTree
    || reasoning(previous) !== reasoning(current) || reply(previous) !== reply(current)
}

function readNode(input: ProcessInput, key: NodeKey): ChatNode {
  const node = input.readNode(key) as ChatNode | undefined
  if (node === undefined) throw new Error(`Chat grouping input is missing Node ${key}`)
  return node
}

/** One group's members and cached summary, refreshed together when its content changes. */
class ProcessGroup {
  private nodes: readonly ChatNode[] = []
  snapshot: GroupSnapshot<ProcessGroupData>

  constructor(
    readonly key: GroupKey,
    readonly turn: number,
    readonly members: readonly NodeReference[],
    /** Members appended from the Turn's process tail; always the final members. */
    readonly tailCount = 0,
  ) {
    this.snapshot = { key, members, data: { turn, closed: false, summary: { counts: [], running: undefined, runningDetail: '' } } }
  }

  refresh(input: ProcessInput, closed: boolean): void {
    const nodes = this.members.map(member => readNode(input, member.key))
    const unchanged = nodes.length === this.nodes.length && nodes.every((node, index) => node === this.nodes[index])
    const previous = this.snapshot.data
    const activity = unchanged && previous.closed === closed ? previous.summary : processActivity(nodes)
    const summary = closed ? { counts: activity.counts, running: undefined, runningDetail: '' } : activity
    this.nodes = nodes
    if (previous.closed !== closed || !sameSummary(previous.summary, summary)) {
      this.snapshot = {
        key: this.key, members: this.members,
        data: { turn: this.turn, closed, summary },
      }
    }
  }
}

/** One Turn's grouping result and member lookup; summaries stay with their groups. */
class TurnGroups {
  private groups = new Map<GroupKey, ProcessGroup>()
  private membership = new Map<NodeKey, GroupKey>()
  private roots = new Map<NodeKey, readonly RenderEntry[]>()

  constructor(readonly turn: number) {}

  references(key: NodeKey): readonly RenderEntry[] {
    return this.roots.get(key) ?? []
  }

  snapshots(): GroupSnapshot<ProcessGroupData>[] {
    return [...this.groups.values()].map(group => group.snapshot)
  }

  refresh(input: ProcessInput, changed: ReadonlySet<NodeKey>): GroupSnapshot<ProcessGroupData>[] {
    const dirty = new Set<GroupKey>()
    for (const node of changed) {
      const group = this.membership.get(node)
      if (group !== undefined) dirty.add(group)
    }
    const ended = input.timeline.turns.get(this.turn)?.status === 'closed'
    if (ended) {
      for (const group of this.groups.values()) {
        if (!group.snapshot.data.closed) dirty.add(group.key)
      }
    }
    const upserts: GroupSnapshot<ProcessGroupData>[] = []
    for (const key of dirty) {
      const group = this.groups.get(key) as ProcessGroup
      const previous = group.snapshot
      group.refresh(input, previous.data.closed || ended)
      if (group.snapshot !== previous) upserts.push(group.snapshot)
    }
    return upserts
  }

  rebuild(input: ProcessInput, added: ReadonlySet<NodeKey>): { upserts: GroupSnapshot<ProcessGroupData>[]; removes: GroupKey[] } {
    const roots = new Map<NodeKey, readonly RenderEntry[]>()
    const groups = new Map<GroupKey, ProcessGroup>()
    const membership = new Map<NodeKey, GroupKey>()
    // Snapshot before this rebuild, captured before a reused group mutates its snapshot.
    const baseline = new Map<GroupKey, GroupSnapshot<ProcessGroupData> | undefined>()
    let pending: NodeReference[] = []
    const emit = (key: NodeKey, entry: RenderEntry): void => {
      roots.set(key, [...roots.get(key) ?? [], entry])
    }
    const flush = (closed: boolean): void => {
      const first = pending[0]
      if (first === undefined) return
      const retained = this.extendedGroup(pending, added)
      const key = retained?.key ?? brandString<GroupKey>(JSON.stringify(['process', first.key, first.groupPart ?? null]))
      const previous = this.groups.get(key)
      if (!baseline.has(key)) baseline.set(key, previous?.snapshot)
      const group = previous !== undefined && sameMembers(previous.members, pending)
        ? previous : new ProcessGroup(key, this.turn, pending)
      group.refresh(input, closed || input.timeline.turns.get(this.turn)?.status === 'closed')
      groups.set(group.key, group)
      emit(first.key, { kind: 'group', key: group.key })
      for (const member of pending) membership.set(member.key, group.key)
      pending = []
    }
    const turnKeys = input.readTurn(this.turn)
    const tailKeys = new Set<NodeKey>()
    const flowKeys: NodeKey[] = []
    for (const key of turnKeys) {
      if (isProcessTail(readNode(input, key))) tailKeys.add(key)
      else flowKeys.push(key)
    }
    let previous: NodeKey | undefined
    let lastFlowKey: NodeKey | undefined
    let lastResponseKey: NodeKey | undefined
    for (const key of flowKeys) {
      const position = readPosition(input, key)
      // Tail Nodes are transparent to segmentation: compare against the nearest
      // non-tail predecessor so a real separator between them still splits.
      let predecessor = position.previous
      while (predecessor !== undefined && tailKeys.has(predecessor)) {
        predecessor = readPosition(input, predecessor).previous
      }
      if (previous !== undefined && predecessor !== previous) flush(true)
      previous = key
      lastFlowKey = key
      const node = readNode(input, key)
      if (isAtOrOutside(node, 'process')) {
        flush(true)
        emit(key, { kind: 'node', key })
      } else if (node.kind === 'assistant-step') {
        // One Node, two rows: reasoning joins the step run, a reply stands outside it.
        if (reasoning(node)) pending.push({ kind: 'node', key, groupPart: 'reasoning' })
        if (reply(node)) {
          flush(true)
          emit(key, { kind: 'node', key, groupPart: 'response' })
          lastResponseKey = key
        }
      } else pending.push({ kind: 'node', key })
    }
    // Tail Nodes join the trailing group, so only content outside the Turn closes it.
    flush(lastFlowKey !== undefined && followedByOutside(input, lastFlowKey, tailKeys))
    if (tailKeys.size > 0) this.appendTail(input, groups, membership, roots, baseline, tailKeys, lastResponseKey)
    const upserts: GroupSnapshot<ProcessGroupData>[] = []
    for (const group of groups.values()) {
      if (group.snapshot !== baseline.get(group.key)) upserts.push(group.snapshot)
    }
    const removes = [...this.groups.keys()].filter(key => !groups.has(key))
    this.groups = groups
    this.membership = membership
    this.roots = roots
    return { upserts, removes }
  }

  /**
   * Append tail Nodes to the Turn's final segment; a Turn without one gets a
   * segment of its own, placed before the Turn's final reply when there is one.
   */
  private appendTail(
    input: ProcessInput,
    groups: Map<GroupKey, ProcessGroup>,
    membership: Map<NodeKey, GroupKey>,
    roots: Map<NodeKey, readonly RenderEntry[]>,
    baseline: Map<GroupKey, GroupSnapshot<ProcessGroupData> | undefined>,
    tailKeys: ReadonlySet<NodeKey>,
    lastResponseKey: NodeKey | undefined,
  ): void {
    const members: NodeReference[] = [...tailKeys].map(key => ({ kind: 'node', key }))
    const first = members[0] as NodeReference
    const last = [...groups.values()].at(-1)
    if (last !== undefined) {
      const appended = new ProcessGroup(last.key, this.turn, [...last.members, ...members], members.length)
      appended.refresh(input, last.snapshot.data.closed)
      groups.set(appended.key, appended)
      for (const member of members) membership.set(member.key, appended.key)
      return
    }
    const key = brandString<GroupKey>(JSON.stringify(['process', first.key, first.groupPart ?? null]))
    if (!baseline.has(key)) baseline.set(key, this.groups.get(key)?.snapshot)
    const group = new ProcessGroup(key, this.turn, members, members.length)
    group.refresh(input, input.timeline.turns.get(this.turn)?.status === 'closed')
    groups.set(key, group)
    for (const member of members) membership.set(member.key, key)
    const entry: RenderEntry = { kind: 'group', key }
    if (lastResponseKey === undefined) roots.set(first.key, [entry])
    else roots.set(lastResponseKey, [entry, ...roots.get(lastResponseKey) ?? []])
  }

  private extendedGroup(members: readonly NodeReference[], added: ReadonlySet<NodeKey>): ProcessGroup | undefined {
    // Reuse identity only while the complete old group remains between newly visible members.
    const offset = members.findIndex(member => !added.has(member.key))
    const first = members[offset]
    if (first === undefined) return undefined
    const key = this.membership.get(first.key)
    const previous = key === undefined ? undefined : this.groups.get(key)
    if (previous === undefined) return undefined
    const before = previous.members.slice(0, previous.members.length - previous.tailCount)
    if (offset + before.length > members.length) return undefined
    for (let index = 0; index < before.length; index++) {
      const retained = before[index] as NodeReference
      const after = members[offset + index] as NodeReference
      if (retained.key !== after.key || retained.groupPart !== after.groupPart) return undefined
    }
    for (let index = offset + before.length; index < members.length; index++) {
      if (!added.has((members[index] as NodeReference).key)) return undefined
    }
    return previous
  }
}

function readPosition(input: ProcessInput, key: NodeKey) {
  const position = input.readPosition(key)
  if (position === undefined) throw new Error(`Chat grouping order is missing position for Node ${key}`)
  return position
}

/** Whether content outside the Turn follows `key` once its own tail Nodes are skipped. */
function followedByOutside(
  input: ProcessInput,
  key: NodeKey,
  tailKeys: ReadonlySet<NodeKey>,
): boolean {
  let next = readPosition(input, key).next
  while (next !== undefined && tailKeys.has(next)) next = readPosition(input, next).next
  return next !== undefined
}

/** Session-local Turn results; ordinary updates never read other Turns' Node contents. */
export class ProcessState {
  private turns = new Map<number, TurnGroups>()
  private order: readonly NodeKey[] = []
  private pending: GroupUpdate<ProcessGroupData> | null = null

  /**
   * Consume one synchronous Builder input without retaining its readers.
   * @param input - projected Node changes, indexed positions, and Turn lifecycle.
   */
  accept(input: ProcessInput): void {
    if (input.kind === 'replace') {
      const previousKeys = new Set(this.order)
      const added = new Set(input.order.filter(key => !previousKeys.has(key)))
      const turns = new Map<number, TurnGroups>()
      for (const key of input.order) {
        const turn = readPosition(input, key).turn
        if (turn === undefined || turns.has(turn)) continue
        const groups = this.turns.get(turn) ?? new TurnGroups(turn)
        groups.rebuild(input, added)
        turns.set(turn, groups)
      }
      this.turns = turns
      this.order = input.order
      this.pending = {
        entries: this.rootEntries(input),
        groups: { kind: 'replace', snapshots: [...turns.values()].flatMap(turn => turn.snapshots()) },
      }
      return
    }

    const regroup = new Set(input.changedTurnOrders)
    const added = new Set<NodeKey>()
    const changed = new Map<number, Set<NodeKey>>()
    const touch = (turn: number): Set<NodeKey> => {
      let keys = changed.get(turn)
      if (keys === undefined) {
        keys = new Set()
        changed.set(turn, keys)
      }
      return keys
    }
    for (const change of input.changes) {
      const before = change.previous as ChatNode | undefined
      const after = change.current as ChatNode
      const turn = turnOf(after)
      if (before === undefined || !isVisibleChatNode(before)) added.add(after.key as NodeKey)
      if (structureChanged(before, after)) {
        const previousTurn = before === undefined ? undefined : turnOf(before)
        if (previousTurn !== undefined) regroup.add(previousTurn)
        if (turn !== undefined) regroup.add(turn)
      }
      if (turn !== undefined) touch(turn).add(after.key as NodeKey)
    }
    for (const turn of input.changedTurns) touch(turn)

    const upserts: GroupSnapshot<ProcessGroupData>[] = []
    const removes: GroupKey[] = []
    for (const turn of regroup) {
      const groups = this.turns.get(turn) ?? new TurnGroups(turn)
      const update = groups.rebuild(input, added)
      upserts.push(...update.upserts)
      removes.push(...update.removes)
      if (input.readTurn(turn).length === 0) this.turns.delete(turn)
      else this.turns.set(turn, groups)
    }
    for (const [turn, keys] of changed) {
      if (!regroup.has(turn)) upserts.push(...this.turns.get(turn)?.refresh(input, keys) ?? [])
    }
    const reordered = input.order !== this.order || regroup.size > 0
    this.order = input.order
    const installed = new Set(upserts.map(group => group.key))
    this.pending = reordered || upserts.length > 0 || removes.length > 0
      ? {
        ...reordered ? { entries: this.rootEntries(input) } : {},
        groups: { kind: 'apply', upserts, removes: removes.filter(key => !installed.has(key)) },
      }
      : null
  }

  private rootEntries(input: ProcessInput): RenderEntry[] {
    return input.order.flatMap<RenderEntry>((key) => {
      const turn = readPosition(input, key).turn
      if (turn === undefined) return [{ kind: 'node', key }]
      const groups = this.turns.get(turn)
      if (groups === undefined) throw new Error(`Chat grouping order is missing Turn ${turn}`)
      return groups.references(key)
    })
  }

  /**
   * Read pending output without advancing State.
   * @returns the repeatable update for the last input batch.
   */
  output(): GroupUpdate<ProcessGroupData> | null { return this.pending }
}

/** Chat's registered business grouping; presentation modes never enter its State. */
export const processGroupDefinition: ConversationGroupDefinition<ChatConversationViewNode, ProcessState, ProcessGroupData>
  & { readonly target: 'chat' } = {
    kind: 'process-groups', target: 'chat',
    create: () => new ProcessState(),
    update: (context, input) => { context.state.accept(input); return context.state },
    buildGroups: context => context.state.output(),
  }
