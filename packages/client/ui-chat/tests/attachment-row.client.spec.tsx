// @vitest-environment jsdom
/** One attachment row keeps every card's own layout host at one resolved site. */
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { ConversationAttachment } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ChatAttachmentRow } from '../src/client/chat/ChatAttachmentRow.tsx'
import type { ChatAttachmentPlacement } from '../src/client/chat/attachments.ts'
import type { ChatFlowSlotProps } from '../src/client/contract/slots.ts'

const SESSION = SessionId('attachment-row')

function placement(
  id: string,
  side: 'left' | 'right',
  host: 'side' | 'inline',
  presentation?: ConversationAttachment['presentation'],
): ChatAttachmentPlacement {
  return {
    attachment: {
      id,
      sessionId: SESSION,
      side,
      anchor: { kind: 'turn-start', turn: 1 },
      ...presentation === undefined ? {} : { presentation },
    },
    site: 'tool-call',
    turn: 1,
    seq: SessionSeq(7),
    index: null,
    targetNodeKey: `node-${id}`,
    host,
  }
}

const renderSlot: ChatFlowSlotProps['renderSlot'] = (name: string, owner: object) => {
  if (name !== 'conversation.chat.attachment') throw new Error(`unexpected Chat child Slot: ${name}`)
  return <span data-testid="card-body">{(owner as { readonly attachment: ConversationAttachment }).attachment.id}</span>
}

function cardIds(row: Element): readonly (string | null)[] {
  return [...row.querySelectorAll('[data-chat-attachment]')]
    .map(card => card.getAttribute('data-chat-attachment'))
}

function cardHosts(row: Element): readonly (string | null)[] {
  return [...row.querySelectorAll('[data-chat-attachment]')]
    .map(card => card.getAttribute('data-chat-attachment-host'))
}

describe('Chat attachment layout', () => {
  it('keeps the auto host on its own card when the inline history card is registered first', () => {
    const { container } = render(<ChatAttachmentRow
      placements={[placement('history', 'left', 'inline', 'inline'), placement('active', 'left', 'side')]}
      renderSlot={renderSlot} />)
    const rows = [...container.querySelectorAll('[data-chat-attachment-row]')]
    expect(rows).toHaveLength(1)
    expect(rows[0]?.getAttribute('data-chat-attachment-side')).toBe('left')
    // The row stays in flow for its in-Turn card; the active card keeps `side`.
    expect(rows[0]?.getAttribute('data-chat-attachment-host')).toBe('inline')
    expect(cardIds(rows[0] as Element)).toEqual(['history', 'active'])
    expect(cardHosts(rows[0] as Element)).toEqual(['inline', 'side'])
  })

  it('keeps the same card hosts when the auto card is registered first', () => {
    const { container } = render(<ChatAttachmentRow
      placements={[placement('active', 'left', 'side'), placement('history', 'left', 'inline', 'inline')]}
      renderSlot={renderSlot} />)
    const rows = [...container.querySelectorAll('[data-chat-attachment-row]')]
    expect(rows).toHaveLength(1)
    expect(rows[0]?.getAttribute('data-chat-attachment-host')).toBe('inline')
    expect(cardIds(rows[0] as Element)).toEqual(['active', 'history'])
    expect(cardHosts(rows[0] as Element)).toEqual(['side', 'inline'])
  })

  it('marks a row out of flow only when every card in it uses the blank', () => {
    const { container } = render(<ChatAttachmentRow
      placements={[placement('active', 'left', 'side'), placement('second', 'left', 'side')]}
      renderSlot={renderSlot} />)
    const rows = [...container.querySelectorAll('[data-chat-attachment-row]')]
    expect(rows).toHaveLength(1)
    expect(rows[0]?.getAttribute('data-chat-attachment-host')).toBe('side')
    expect(cardHosts(rows[0] as Element)).toEqual(['side', 'side'])
  })

  it('renders one row per side with each card in registration order', () => {
    const { container } = render(<ChatAttachmentRow
      placements={[placement('right', 'right', 'side'), placement('left', 'left', 'side')]}
      renderSlot={renderSlot} />)
    const rows = [...container.querySelectorAll('[data-chat-attachment-row]')]
    expect(rows.map(row => row.getAttribute('data-chat-attachment-side'))).toEqual(['right', 'left'])
    expect(rows.map(row => row.getAttribute('data-chat-attachment-host'))).toEqual(['side', 'side'])
    expect(rows.map(row => cardIds(row))).toEqual([['right'], ['left']])
  })
})
