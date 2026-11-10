import { Service, type Context } from '@deepseek-ai/cordis'
import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConversationAttachment } from '../contract/attachments.ts'

const EMPTY_ATTACHMENTS: readonly ConversationAttachment[] = []

/**
 * Registry of Session-attached cards contributed by business plugins.
 *
 * Each entry is scoped to the displayed Session identity and carries a stable
 * card id and a durable anchor. The Chat target resolves the anchor against its
 * own loaded timeline; this registry only owns registration and per-Session
 * publication, so a card's position never becomes registry state.
 */
export class ConversationAttachmentRegistry {
  private readonly entries = new Map<string, ConversationAttachment>()
  private readonly bySession = new Map<SessionId, readonly ConversationAttachment[]>()
  private readonly sources = new Map<SessionId, ObservableSnapshot<readonly ConversationAttachment[]>>()
  private readonly listeners = new Set<(sessionId: SessionId) => void>()

  /** @param ctx - Context whose effects own contributed attachments. */
  constructor(private readonly ctx: Context) {
    Object.defineProperty(this, Service.tracker, {
      value: { property: 'ctx' },
    })
  }

  /**
   * Register one card for the caller's lifetime.
   * @param attachment - stable card identity, displayed Session, side, and anchor.
   * @returns idempotent disposer.
   */
  register(attachment: ConversationAttachment): () => void {
    assertAttachment(attachment)
    const key = attachmentKey(attachment.sessionId, attachment.id)
    if (this.entries.has(key)) {
      throw new Error(
        `uiConversation.attachments.register: card "${attachment.id}" is already registered for this Session`,
      )
    }
    const stored = Object.freeze({
      ...attachment,
      anchor: Object.freeze({ ...attachment.anchor }),
    }) satisfies ConversationAttachment
    const dispose = this.ctx.effect(() => {
      this.entries.set(key, stored)
      this.publish(attachment.sessionId)
      return () => {
        if (this.entries.get(key) !== stored) return
        this.entries.delete(key)
        this.publish(attachment.sessionId)
      }
    }, `uiConversation.attachments.register(${JSON.stringify(attachment.id)})`)
    return () => { void dispose() }
  }

  /**
   * Observe the cards registered for one displayed Session.
   * @param sessionId - displayed Session identity.
   * @returns identity-stable source of that Session's cards in registration order.
   */
  source(sessionId: SessionId): ObservableSnapshot<readonly ConversationAttachment[]> {
    let source = this.sources.get(sessionId)
    if (source === undefined) {
      const entry: ObservableSnapshot<readonly ConversationAttachment[]> = {
        getSnapshot: () => this.bySession.get(sessionId) ?? EMPTY_ATTACHMENTS,
        subscribe: (listener) => {
          const notify = (changed: SessionId): void => {
            if (changed === sessionId) listener()
          }
          this.listeners.add(notify)
          return () => { this.listeners.delete(notify) }
        },
      }
      source = entry
      this.sources.set(sessionId, entry)
    }
    return source
  }

  /** Publish one changed Session's stable array and notify its subscribers. */
  private publish(sessionId: SessionId): void {
    const next = [...this.entries.values()].filter(attachment => attachment.sessionId === sessionId)
    if (next.length === 0) this.bySession.delete(sessionId)
    else this.bySession.set(sessionId, next)
    notifySubscribers(this.listeners, '[ui-conversation] conversation attachments', sessionId)
  }
}

function attachmentKey(sessionId: SessionId, id: string): string {
  return `${sessionId}\u0000${id}`
}

function assertAttachment(attachment: ConversationAttachment): void {
  if (attachment.id.trim() === '') {
    throw new Error('uiConversation.attachments.register: card id must be non-empty')
  }
  const { anchor } = attachment
  if (!Number.isInteger(anchor.turn) || anchor.turn < 0) {
    throw new Error(`uiConversation.attachments.register: card "${attachment.id}" has an invalid turn`)
  }
  switch (anchor.kind) {
    case 'turn-start':
    case 'turn-end':
      return
    case 'event':
      if (!Number.isInteger(anchor.seq) || anchor.seq < 0) {
        throw new Error(`uiConversation.attachments.register: card "${attachment.id}" has an invalid event seq`)
      }
      return
    case 'tool-call':
      if (anchor.callId.trim() === '') {
        throw new Error(`uiConversation.attachments.register: card "${attachment.id}" has an empty tool call id`)
      }
      return
    default:
      throw new Error(`uiConversation.attachments.register: card "${attachment.id}" has an unknown anchor kind`)
  }
}
