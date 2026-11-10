/** One resolved Session-attachment card row shared by root, group, and tool seats. */
import type { ConversationAttachmentSide } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatAttachmentPlacement } from './attachments.ts'
import type { ChatAttachmentHost, ChatFlowSlotProps } from '../contract/slots.ts'
import css from './ChatAttachmentRow.module.css'

interface AttachmentSideGroup {
  readonly side: ConversationAttachmentSide
  readonly placements: readonly ChatAttachmentPlacement[]
}

/**
 * Split one site's cards by side, preserving registration order.
 * @param placements - cards resolved at this site.
 * @returns one group per side, in first-appearance order.
 */
function sideGroups(placements: readonly ChatAttachmentPlacement[]): readonly AttachmentSideGroup[] {
  const groups = new Map<ConversationAttachmentSide, ChatAttachmentPlacement[]>()
  for (const placement of placements) {
    const side = placement.attachment.side
    const group = groups.get(side)
    if (group === undefined) groups.set(side, [placement])
    else group.push(placement)
  }
  return [...groups.entries()].map(([side, placements]) => ({ side, placements }))
}

/**
 * How one row's cards are laid out: a row whose cards all use the measured
 * blank leaves the flow entirely, while any in-Turn card keeps it in place.
 * @param placements - cards grouped onto one side.
 * @returns `side` only when every card in the row stands in the blank.
 */
function rowHost(placements: readonly ChatAttachmentPlacement[]): ChatAttachmentHost {
  return placements.every(placement => placement.host === 'side') ? 'side' : 'inline'
}

/**
 * Render the attachment occurrences resolved at one site.
 *
 * Every card keeps its stable identity, owner data, and its own layout host:
 * the view assigns `host` per card, so an active `auto` card still reaches the
 * blank when a historical `inline` card resolves to the same side and the same
 * site. Cards at one site are split by side, so a card on each side keeps its
 * own stack in registration order, and a row with both hosts keeps its in-Turn
 * card in the flow while the side card leaves it.
 * @param props - resolved placements at this site and the flow's child renderer.
 * @returns one row per side, or null for an empty group.
 */
export function ChatAttachmentRow({ placements, renderSlot }: {
  readonly placements: readonly ChatAttachmentPlacement[]
  readonly renderSlot: ChatFlowSlotProps['renderSlot']
}) {
  const groups = sideGroups(placements)
  if (groups.length === 0) return null
  return (
    <>
      {groups.map(group => (
        <div
          key={group.side}
          className={css.row}
          data-chat-attachment-row=""
          data-chat-attachment-side={group.side}
          data-chat-attachment-host={rowHost(group.placements)}
        >
          <div className={css.cards} data-chat-attachment-stack="">
            {group.placements.map(placement => (
              <div
                key={placement.attachment.id}
                className={css.card}
                data-chat-attachment={placement.attachment.id}
                data-chat-attachment-host={placement.host ?? 'inline'}
                data-chat-attachment-site={placement.site}
                data-chat-attachment-side={placement.attachment.side}
                data-chat-attachment-turn={placement.turn}
                data-chat-attachment-seq={placement.seq}
                data-chat-attachment-target={placement.targetNodeKey}
                data-chat-attachment-part={placement.targetPart}
                data-chat-attachment-group={placement.targetGroupKey}
                data-chat-attachment-call={placement.targetCallId}
              >
                {renderSlot('conversation.chat.attachment', {
                  attachment: placement.attachment,
                  site: placement.site,
                  turn: placement.turn,
                  ...placement.seq === undefined ? {} : { seq: placement.seq },
                  ...placement.targetCallId === undefined ? {} : { targetCallId: placement.targetCallId },
                }, { entryKey: placement.attachment.id })}
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  )
}
