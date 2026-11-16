/**
 * `surface/order` records a full permutation of the current surface nodes. It
 * moves positions only: node identities, recorded message bytes, and the
 * append-only log stay untouched, and replay applies the same order.
 */

import { describe, expect, it } from 'vitest'
import {
  Session,
  SessionId,
  SessionSeq,
  foldSurface,
} from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** A session whose surface holds one message per supplied text, in append order. */
function sessionWith(texts: readonly string[]): Session {
  const session = Session.create(SessionId('surface-order'))
  for (const text of texts) {
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
  }
  return session
}

/** Model-visible text in current derived order. */
function texts(session: Session): string[] {
  return session.deriveMessages().flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
}

/** The current surface permutation that moves the last node first after the head. */
function swapTail(session: Session): SessionSeq[] {
  const nodes = session.surface.nodes
  return [nodes[0]!, ...nodes.slice(1).reverse()]
}

describe('surface/order', () => {
  it('reorders current nodes without touching identities, content, or membership', () => {
    const session = sessionWith(['one', 'two', 'three'])
    const order = swapTail(session)
    const before = session.deriveMessages()
    const replaceGeneration = session.surface.replaceGeneration
    const contentGeneration = session.surface.contentGeneration

    const event = session.append('surface/order', { nodes: order })

    expect(event.seq).toBe(3)
    expect([...session.surface.nodes]).toEqual(order)
    const after = session.deriveMessages()
    expect(after).toHaveLength(before.length)
    // Identity, not equality: the same recorded messages, moved.
    expect(after[0]).toBe(before[0])
    expect(after[1]).toBe(before[2])
    expect(after[2]).toBe(before[1])
    expect(texts(session)).toEqual(['one', 'three', 'two'])
    expect(session.surface.replaceGeneration).toBe(replaceGeneration + 1)
    expect(session.surface.contentGeneration).toBe(contentGeneration + 1)
    expect(session.snapshotEvents().filter(candidate => candidate.type === 'surface/order')).toEqual([event])
    // The ordering event adds no message of its own.
    expect(session.deriveMessages()).toHaveLength(3)
  })

  it('replays the same order from the log alone', () => {
    const session = sessionWith(['one', 'two', 'three'])
    session.append('surface/order', { nodes: swapTail(session) })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'four' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    const reopened = Session.create(SessionId('surface-order-reopened'), session.snapshotEvents())
    expect([...reopened.surface.nodes]).toEqual([...session.surface.nodes])
    expect(texts(reopened)).toEqual(['one', 'three', 'two', 'four'])
    expect(foldSurface(session.snapshotEvents()).nodes).toEqual([...session.surface.nodes])
  })

  it('appends after the permuted tail and resolves replacements in the current order', () => {
    const session = sessionWith(['one', 'two', 'three'])
    // A detached copy: the live surface array is rewritten in place by later events.
    const nodes = [...session.surface.nodes]
    const reordered = [nodes[0]!, nodes[2]!, nodes[1]!]
    session.append('surface/order', { nodes: reordered })

    const appended = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'four' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect([...session.surface.nodes]).toEqual([...reordered, appended.seq])

    // The endpoints follow the current order, so naming them in recorded-seq
    // order spans nothing and must be refused.
    expect(() => session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'merged' }], source: { kind: 'user' },
    }), {
      surfaceOp: { op: 'replace', startSeq: nodes[1]!, endSeq: nodes[2]! },
      sourceEventSeqs: [nodes[1]!, nodes[2]!],
    })).toThrow(/is after end seq/)

    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'merged' }], source: { kind: 'user' },
    }), {
      surfaceOp: { op: 'replace', startSeq: nodes[2]!, endSeq: nodes[1]! },
      sourceEventSeqs: [nodes[2]!, nodes[1]!],
    })
    expect(texts(session)).toEqual(['one', 'merged', 'four'])
  })

  it.each([
    ['a shorter list', (nodes: readonly SessionSeq[]) => [nodes[0]!], /must permute all 3 current surface nodes/],
    ['an unknown seq', (nodes: readonly SessionSeq[]) => [nodes[0]!, nodes[1]!, SessionSeq(99)], /is not a current surface node/],
    ['a duplicate', (nodes: readonly SessionSeq[]) => [nodes[0]!, nodes[1]!, nodes[1]!], /more than once/],
    ['a moved head', (nodes: readonly SessionSeq[]) => [nodes[1]!, nodes[0]!, nodes[2]!], /must stay at index 0/],
    ['the current order', (nodes: readonly SessionSeq[]) => [nodes[0]!, nodes[1]!, nodes[2]!], /matches the current surface order/],
  ])('refuses %s', (_label, order, message) => {
    const session = sessionWith(['one', 'two', 'three'])
    const nodes = session.surface.nodes
    const before = session.snapshotEvents()
    expect(() => session.append('surface/order', { nodes: order(nodes) })).toThrow(message)
    expect(session.snapshotEvents()).toHaveLength(before.length)
    expect([...session.surface.nodes]).toEqual([...nodes])
  })

  it('refuses to order an empty surface', () => {
    const session = Session.create(SessionId('surface-order-empty'))
    expect(() => session.append('surface/order', { nodes: [] })).toThrow(/no nodes to reorder/)
  })

  it('refuses a replayed log whose permutation no longer matches the surface', () => {
    const session = sessionWith(['one', 'two'])
    const events: SessionEvent[] = [
      ...session.snapshotEvents(),
      { type: 'surface/order', seq: SessionSeq(2), time: 2, data: { nodes: [SessionSeq(0), SessionSeq(5)] } },
    ]
    expect(() => foldSurface(events)).toThrow(/is not a current surface node/)
    expect(() => Session.create(SessionId('bad-order'), events)).toThrow(/is not a current surface node/)
  })
})
