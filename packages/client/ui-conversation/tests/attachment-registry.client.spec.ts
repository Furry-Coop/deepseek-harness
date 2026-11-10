/** Session attachment registration is scoped, observable, and removed with its owner. */
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { ConversationAttachment } from '../src/client/contract/attachments.ts'
import { ConversationAttachmentRegistry } from '../src/client/conversation/attachment-registry.ts'

const SESSION = SessionId('attachment-session')
const OTHER = SessionId('attachment-other')

function fixture() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  return { ctx, registry: new ConversationAttachmentRegistry(ctx) }
}

function card(over: Partial<ConversationAttachment> = {}): ConversationAttachment {
  return {
    id: 'left-card',
    sessionId: SESSION,
    side: 'left',
    anchor: { kind: 'turn-start', turn: 2 },
    ...over,
  }
}

describe('Conversation attachment registrations', () => {
  it('publishes cards only to the displayed Session source', () => {
    const { registry } = fixture()
    const source = registry.source(SESSION)
    const other = registry.source(OTHER)
    const changed = vi.fn()
    const otherChanged = vi.fn()
    source.subscribe(changed)
    other.subscribe(otherChanged)
    const initial = source.getSnapshot()
    expect(initial).toEqual([])
    expect(source.getSnapshot()).toBe(initial)

    registry.register(card())
    expect(source.getSnapshot()).toEqual([expect.objectContaining({ id: 'left-card', sessionId: SESSION })])
    expect(changed).toHaveBeenCalledOnce()
    expect(otherChanged).not.toHaveBeenCalled()
    expect(other.getSnapshot()).toEqual([])
  })

  it('keeps one card id per Session and allows the same id elsewhere', () => {
    const { registry } = fixture()
    registry.register(card())
    expect(() => registry.register(card())).toThrow('already registered')
    expect(() => registry.register(card({ sessionId: OTHER }))).not.toThrow()
    expect(registry.source(OTHER).getSnapshot()).toHaveLength(1)
  })

  it('rejects malformed anchors before registering', () => {
    const { registry } = fixture()
    expect(() => registry.register(card({ id: ' ' }))).toThrow('non-empty')
    expect(() => registry.register(card({ anchor: { kind: 'turn-start', turn: -1 } }))).toThrow('invalid turn')
    expect(() => registry.register(card({
      anchor: { kind: 'event', turn: 2, seq: -1 as SessionSeq },
    }))).toThrow('invalid event seq')
    // A durable event seq is an integer; a transient fraction is not one.
    expect(() => registry.register(card({
      anchor: { kind: 'event', turn: 2, seq: 6.25 as SessionSeq },
    }))).toThrow('invalid event seq')
    expect(() => registry.register(card({
      anchor: { kind: 'tool-call', turn: 2, callId: ' ' },
    }))).toThrow('empty tool call id')
  })

  it('removes the card when its owning effect is disposed', () => {
    const { registry } = fixture()
    const source = registry.source(SESSION)
    const changed = vi.fn()
    source.subscribe(changed)
    const dispose = registry.register(card())
    const first = source.getSnapshot()
    dispose()
    dispose()
    expect(source.getSnapshot()).toEqual([])
    expect(source.getSnapshot()).not.toBe(first)
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('publishes a second card on the same side without disturbing the first', () => {
    const { registry } = fixture()
    const source = registry.source(SESSION)
    registry.register(card())
    const first = source.getSnapshot()
    registry.register(card({ id: 'right-card', side: 'right' }))
    const second = source.getSnapshot()
    expect(second).toHaveLength(2)
    expect(second[0]).toBe(first[0])
    expect(second[1]).toMatchObject({ id: 'right-card', side: 'right' })
  })
})
