/** Side-blank versus in-Turn placement of Session attachment cards. */
import type { ConversationAttachmentSide } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatAttachmentLayout } from '../contract/attachment-layout.ts'
import type { ChatAttachmentPlacement } from './attachments.ts'

/** Resolved box of one side card inside the content column. */
export interface ChatSideAttachmentGeometry {
  /** Distance from the column's padding edge to the card's border-box top. */
  readonly top: number
  /** Block-size cap for a card taller than the column; `null` keeps its natural size. */
  readonly maxBlockSize: number | null
}

/**
 * Place one side card inside the column's content box.
 *
 * A card whose bottom would pass the content end moves up until that end holds
 * it; the natural anchor is where its attachment row sits, never the previous
 * clamped top. A card taller than the content box keeps its top at the content
 * start and reports the cap its consumer applies for internal scrolling. The
 * clamp stays inside the column, which lies inside the root's content-sized
 * clip, so a side card never crosses the transcript's clipped bottom.
 * @param anchorTop - attachment row top relative to the column's padding edge.
 * @param cardHeight - natural border-box height of the card.
 * @param containerHeight - height of the column's content box.
 * @returns the card's top and, when it must scroll internally, its block-size cap.
 */
export function resolveSideAttachmentGeometry(
  anchorTop: number,
  cardHeight: number,
  containerHeight: number,
): ChatSideAttachmentGeometry {
  const top = Math.min(Math.max(anchorTop, 0), Math.max(0, containerHeight - cardHeight))
  return {
    top,
    maxBlockSize: cardHeight > containerHeight ? Math.max(0, containerHeight) : null,
  }
}

/** Width one side card needs in the blank beside the content column. */
export const ATTACHMENT_SIDE_CARD_WIDTH = 200
/** Clearance between the content column and a side card. */
export const ATTACHMENT_SIDE_GAP = 32

/**
 * Choose the card layout from the blank actually available beside the content.
 *
 * CSS cannot decide this: the content width is a `clamp()` of the conversation
 * width and a user preference, so the remaining blank is a comparison of two
 * dynamic lengths rather than a media breakpoint.
 * @param availableGutter - blank width between the column edge and the scrollport.
 * @returns `side` when a card and its clearance fit, otherwise `inline`.
 */
export function attachmentLayoutFor(availableGutter: number): ChatAttachmentLayout {
  return availableGutter >= ATTACHMENT_SIDE_CARD_WIDTH + ATTACHMENT_SIDE_GAP ? 'side' : 'inline'
}

/**
 * Measure the blank beside the content column.
 *
 * The column is centered in the scrollport's content box, so half the
 * difference is the blank on each side. The measurement reads layout widths
 * rather than client rectangles because it runs inside the viewport owner's
 * size observation, which must not trigger row geometry reads.
 * @param scrollport - element owning the scrollport and its side padding.
 * @param column - content column centered inside the scrollport.
 * @returns the layout the current blank can host.
 */
export function measureChatAttachmentLayout(
  scrollport: HTMLElement,
  column: HTMLElement,
): ChatAttachmentLayout {
  const style = getComputedStyle(scrollport)
  const inlinePadding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight)
  const contentWidth = scrollport.clientWidth - (Number.isFinite(inlinePadding) ? inlinePadding : 0)
  return attachmentLayoutFor((contentWidth - column.offsetWidth) / 2)
}

/**
 * Assign each resolved card's layout for the current viewport.
 *
 * Only `auto` cards compete for one side's measured blank: a side hosts at
 * most one of them, because a second one would stand at a nearby anchor
 * without a measured gap. A card the business marked `inline` never consumes
 * that capacity and never moves to the blank, so historical entries can stay
 * inside their Turn while the active card keeps the side.
 * @param placements - resolved placements for the displayed Session.
 * @param layout - the measured blank layout for the viewport.
 * @returns the same placements with `host` assigned.
 */
export function assignAttachmentHosts(
  placements: readonly ChatAttachmentPlacement[],
  layout: ChatAttachmentLayout,
): readonly ChatAttachmentPlacement[] {
  const autoCounts = new Map<ConversationAttachmentSide, number>()
  for (const placement of placements) {
    if (placement.attachment.presentation === 'inline') continue
    const side = placement.attachment.side
    autoCounts.set(side, (autoCounts.get(side) ?? 0) + 1)
  }
  return placements.map((placement): ChatAttachmentPlacement => ({
    ...placement,
    host: layout === 'side' && placement.attachment.presentation !== 'inline'
      && autoCounts.get(placement.attachment.side) === 1
      ? 'side'
      : 'inline',
  }))
}
