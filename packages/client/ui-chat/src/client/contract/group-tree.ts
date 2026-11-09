import type { ChatConversationViewNode } from './chat-nodes.ts'

/**
 * Chat group-tree positions from the outermost inward; a Node at a position
 * also has the effect of every inner position.
 * - `exchange`: the Node's Turn opens an exchange, the run of Turns that lasts
 *   until the next opening Turn.
 * - `input`: the Node is an input of its Turn. An input before the Turn's
 *   process is the Turn's opening input; a later one is interleaved and keeps
 *   the whole Turn open.
 * - `turn`: the Node stays in its Turn outside the Turn's process disclosure.
 * - `process`: the Node stays in the process disclosure outside step runs.
 * - `tail`: the Node joins the Turn's last process segment as its final member,
 *   after that segment's other members and before a reply that ended it, whatever
 *   its `anchorSeq`. It neither starts, splits, nor closes an existing segment; a
 *   Turn with no process segment places it in a segment of its own, before the
 *   Turn's final reply when one exists and otherwise at its own anchor.
 * - absent: the Node joins the step run around it.
 *
 * The Definition that builds a Node chooses its position, and step runs, the
 * process disclosure, and Turn inputs are selected by position. An
 * `assistant-step` Node places its rows without one: its reasoning row joins
 * the step run and its reply row stands outside it.
 *
 * Whole-Turn folding also exempts reply rows: with the default Replies After
 * Collapse choice every `assistant-step` reply row stays visible, and with
 * Final answer only just the final answer's reply row does. Reasoning rows
 * stay in the folded process in both choices.
 */
export type ChatGroupTree = 'exchange' | 'input' | 'turn' | 'process' | 'tail'

const DEPTH: Readonly<Record<ChatGroupTree, number>> = { exchange: 0, input: 1, turn: 2, process: 3, tail: 4 }

/**
 * Test whether a Node stands at a group-tree position or outside it.
 * @param node - Chat Node.
 * @param position - group-tree position to compare against.
 * @returns whether the Node's position is `position` or an outer one.
 */
export function isAtOrOutside(node: Pick<ChatConversationViewNode, 'groupTree'>, position: ChatGroupTree): boolean {
  return node.groupTree !== undefined && DEPTH[node.groupTree] <= DEPTH[position]
}

/**
 * Test whether a Node joins its Turn's process tail.
 * @param node - Chat Node, when one is materialized.
 * @returns whether the Node declares the `tail` position.
 */
export function isProcessTail(node: Pick<ChatConversationViewNode, 'groupTree'> | undefined): boolean {
  return node?.groupTree === 'tail'
}
