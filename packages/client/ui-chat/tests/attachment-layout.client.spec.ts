// @vitest-environment jsdom
/** Side cards appear only when the measured blank beside the content can hold one. */
import { describe, expect, it } from 'vitest'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { ConversationAttachment } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatAttachmentHost } from '../src/client/contract/slots.ts'
import {
  ATTACHMENT_SIDE_CARD_WIDTH, ATTACHMENT_SIDE_GAP, assignAttachmentHosts,
  attachmentLayoutFor, measureChatAttachmentLayout,
} from '../src/client/chat/attachment-layout.ts'
import type { ChatAttachmentPlacement } from '../src/client/chat/attachments.ts'

const MINIMUM_BLANK = ATTACHMENT_SIDE_CARD_WIDTH + ATTACHMENT_SIDE_GAP

function placement(
  id: string,
  side: 'left' | 'right',
  presentation?: ConversationAttachment['presentation'],
): ChatAttachmentPlacement {
  return {
    attachment: {
      id,
      sessionId: SessionId('layout'),
      side,
      anchor: { kind: 'turn-start', turn: 1 },
      ...presentation === undefined ? {} : { presentation },
    },
    site: 'turn-start',
    turn: 1,
    seq: SessionSeq(1),
    index: 0,
  }
}

function hosts(
  placements: readonly ChatAttachmentPlacement[],
  layout: 'side' | 'inline',
): Record<string, ChatAttachmentHost | undefined> {
  return Object.fromEntries(assignAttachmentHosts(placements, layout).map(entry => [entry.attachment.id, entry.host]))
}

function box(padding: string): { scrollport: HTMLDivElement; column: HTMLDivElement } {
  const scrollport = document.createElement('div')
  scrollport.style.paddingLeft = padding
  scrollport.style.paddingRight = padding
  const column = document.createElement('div')
  document.body.append(scrollport)
  scrollport.append(column)
  return { scrollport, column }
}

describe('Chat attachment layout', () => {
  it('places a card beside the content only when the blank holds it and its clearance', () => {
    expect(attachmentLayoutFor(MINIMUM_BLANK - 1)).toBe('inline')
    expect(attachmentLayoutFor(MINIMUM_BLANK)).toBe('side')
  })

  it('measures half the blank between the column and the scrollport content box', () => {
    const { scrollport, column } = box('32px')
    Object.defineProperty(scrollport, 'clientWidth', { configurable: true, value: 1_000 })
    Object.defineProperty(column, 'offsetWidth', { configurable: true, value: 520 })
    // (1000 - 64 - 520) / 2 = 208, less than the 232 a card needs.
    expect(measureChatAttachmentLayout(scrollport, column)).toBe('inline')
    Object.defineProperty(column, 'offsetWidth', { configurable: true, value: 400 })
    // (1000 - 64 - 400) / 2 = 268, which fits.
    expect(measureChatAttachmentLayout(scrollport, column)).toBe('side')
  })

  it('treats an unreadable padding as no padding instead of an unusable blank', () => {
    const { scrollport, column } = box('')
    Object.defineProperty(scrollport, 'clientWidth', { configurable: true, value: 1_000 })
    Object.defineProperty(column, 'offsetWidth', { configurable: true, value: 520 })
    expect(measureChatAttachmentLayout(scrollport, column)).toBe('side')
  })
})

describe('Chat attachment hosts', () => {
  it('gives each side its own blank while one auto card resolves there', () => {
    expect(hosts([placement('left', 'left'), placement('right', 'right')], 'side'))
      .toEqual({ left: 'side', right: 'side' })
  })

  it('keeps an explicit inline entry inside the flow without consuming the side', () => {
    // The business marks historical entries inline; the active card (auto)
    // still reaches the blank on that side.
    expect(hosts([
      placement('history', 'left', 'inline'),
      placement('active', 'left'),
    ], 'side')).toEqual({ history: 'inline', active: 'side' })
  })

  it('keeps two auto cards on one side in the flow so they cannot cover each other', () => {
    expect(hosts([placement('first', 'left'), placement('second', 'left')], 'side'))
      .toEqual({ first: 'inline', second: 'inline' })
  })

  it('keeps every card inline when the viewport has no measured blank', () => {
    expect(hosts([placement('left', 'left'), placement('right', 'right')], 'inline'))
      .toEqual({ left: 'inline', right: 'inline' })
  })
})
