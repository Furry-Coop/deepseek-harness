import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'

/**
 * Durable position a contributed Session attachment asks to sit at.
 *
 * A Turn identity is the numeric turn recorded by the Session log, never a
 * rendered row index. `event` names one durable log sequence inside that Turn;
 * a host that cannot resolve it uses the same Turn's start entry. `tool-call`
 * names one loaded top-level Tool Node by its callId: the host mounts the card
 * at that exact row when the row is visible, at the owning process group or
 * Turn entry when that content is collapsed, and falls back to the same Turn's
 * start entry when the callId is missing, unloaded, outside the Turn, or
 * carried by more than one loaded row. Row adjacency and the first of several
 * duplicate rows are never used to claim a precise tool-row match.
 */
export type ConversationAttachmentAnchor =
  | { readonly kind: 'turn-start'; readonly turn: number }
  | { readonly kind: 'turn-end'; readonly turn: number }
  | { readonly kind: 'event'; readonly turn: number; readonly seq: SessionSeq }
  | { readonly kind: 'tool-call'; readonly turn: number; readonly callId: string }

/** Preferred side of the conversation content for an attachment card. */
export type ConversationAttachmentSide = 'left' | 'right'

/**
 * How the host lays out one card.
 *
 * `auto` (the default) lets the host use the measured blank beside the content
 * column when that side has capacity, and fall back to the position inside the
 * flow otherwise. `inline` keeps the card inside the flow unconditionally and
 * does not consume that side's blank capacity, so a business can mark its own
 * historical entries while leaving the active card to the host.
 */
export type ConversationAttachmentPresentation = 'auto' | 'inline'

/**
 * One plugin-owned card attached to a position in a displayed Session.
 *
 * `id` is the stable card identity: a card that moves from a running Turn to
 * its real `turn/end` keeps the same id, while `anchor` names the destination.
 * `sessionId` is the Session actually on display; a fork that inherited the
 * same events has a different identity and does not receive this card.
 */
export interface ConversationAttachment {
  readonly id: string
  readonly sessionId: SessionId
  readonly side: ConversationAttachmentSide
  readonly anchor: ConversationAttachmentAnchor
  /** Layout request; omission is the same as `auto`. */
  readonly presentation?: ConversationAttachmentPresentation
}
