/** Subagent menu classification is contributed, observable, and withdrawn as one effect. */
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { SubagentCatalogClassificationInput } from '../src/client/catalog-classification.ts'
import { SubagentCatalogPresentation } from '../src/client/catalog-classification.ts'

const PARENT = SessionId('parent')
const SUPPORT = SessionId('support')
const NORMAL = SessionId('normal')

function fixture() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  return { ctx, menu: new SubagentCatalogPresentation(ctx) }
}

/**
 * A real typed classification Map whose iteration is replaced by a hostile
 * implementation: reading the answer throws before any entry is yielded. The
 * own `has` override preserves the original fixture's reported absence.
 */
function unreadableAnswer(): Map<SessionId, 'support'> {
  const answer = new Map<SessionId, 'support'>()
  Object.defineProperty(answer, 'has', { value: () => false })
  Object.defineProperty(answer, Symbol.iterator, {
    value: () => { throw new Error('unreadable answer') },
  })
  return answer
}

/** A real typed answer whose iteration yields one entry and then throws. */
function halfIteratedAnswer(): Map<SessionId, 'support'> {
  const answer = new Map<SessionId, 'support'>()
  Object.defineProperty(answer, 'has', { value: () => false })
  Object.defineProperty(answer, Symbol.iterator, {
    value: function* () {
      yield [NORMAL, 'support'] as const
      throw new Error('failed after one entry')
    },
  })
  return answer
}

function input(): SubagentCatalogClassificationInput {
  return {
    parentSessionId: PARENT,
    entries: [
      { id: SUPPORT, mode: 'continuable', activity: 'running' },
      { id: NORMAL, mode: 'one-shot', activity: 'inactive' },
    ],
  }
}

describe('Subagent catalog presentation classification', () => {
  it('merges live classifiers in registration order and lets removal restore rows', () => {
    const { menu } = fixture()
    const revision = createSnapshotStore(0)
    const first = vi.fn(() => new Map([[SUPPORT, 'support' as const]]))
    const second = vi.fn(() => new Map([[SUPPORT, 'support' as const], [NORMAL, 'support' as const]]))
    menu.register({ id: 'first', classify: first, revision })
    expect([...menu.classify(input())]).toEqual([[SUPPORT, 'support']])
    const dispose = menu.register({ id: 'second', classify: second, revision })
    // The first contributor wins for an entry both name.
    expect([...menu.classify(input())]).toEqual([[SUPPORT, 'support'], [NORMAL, 'support']])
    dispose()
    expect([...menu.classify(input())]).toEqual([[SUPPORT, 'support']])
  })

  it('treats an undefined classifier answer as unavailable', () => {
    const { menu } = fixture()
    menu.register({
      id: 'unavailable',
      classify: () => undefined,
      revision: createSnapshotStore(0),
    })
    expect(menu.classify(input()).size).toBe(0)
  })

  it('keeps every native entry when a classifier throws', () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const menu = new SubagentCatalogPresentation(ctx)
    const first = vi.fn(() => new Map([[SUPPORT, 'support' as const]]))
    menu.register({ id: 'first', classify: first, revision: createSnapshotStore(0) })
    menu.register({
      id: 'broken',
      classify: () => { throw new Error('classifier failed') },
      revision: createSnapshotStore(0),
    })
    // The healthy contribution still applies; the broken one contributes
    // nothing instead of failing the menu render.
    expect([...menu.classify(input())]).toEqual([[SUPPORT, 'support']])
    expect(first).toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
  })

  it('republishes when a classifier or its evidence changes', () => {
    const { menu } = fixture()
    const revision = createSnapshotStore(0)
    const listener = vi.fn()
    menu.revision.subscribe(listener)
    const dispose = menu.register({ id: 'support', classify: () => undefined, revision })
    expect(listener).toHaveBeenCalled()
    const afterRegister = listener.mock.calls.length
    revision.set(1)
    expect(listener.mock.calls.length).toBe(afterRegister + 1)
    dispose()
    expect(listener.mock.calls.length).toBe(afterRegister + 2)
  })

  it('keeps native rows when a classifier answer cannot be read', () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const menu = new SubagentCatalogPresentation(ctx)
    const healthy = vi.fn(() => new Map([[SUPPORT, 'support' as const]]))
    menu.register({ id: 'healthy', classify: healthy, revision: createSnapshotStore(0) })
    menu.register({
      id: 'unreadable',
      classify: unreadableAnswer,
      revision: createSnapshotStore(0),
    })
    expect([...menu.classify(input())]).toEqual([[SUPPORT, 'support']])
    expect(warn).toHaveBeenCalled()
  })

  it('merges nothing from an answer that fails halfway through iteration', () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const menu = new SubagentCatalogPresentation(ctx)
    menu.register({
      id: 'healthy',
      classify: () => new Map([[SUPPORT, 'support' as const]]),
      revision: createSnapshotStore(0),
    })
    menu.register({
      id: 'half',
      classify: halfIteratedAnswer,
      revision: createSnapshotStore(0),
    })
    // The failing contribution leaves no partial classification behind; the
    // healthy contributor's answer still applies.
    expect([...menu.classify(input())]).toEqual([[SUPPORT, 'support']])
    expect(warn).toHaveBeenCalled()
  })

  it('withdraws a classifier even when its evidence subscription fails to release', () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const menu = new SubagentCatalogPresentation(ctx)
    const dispose = menu.register({
      id: 'stubborn',
      classify: () => new Map([[SUPPORT, 'support' as const]]),
      revision: {
        getSnapshot: () => 0,
        subscribe: () => () => { throw new Error('release failed') },
      },
    })
    expect(menu.classify(input()).size).toBe(1)
    expect(() => { dispose() }).not.toThrow()
    // The dead classifier no longer filters native rows.
    expect(menu.classify(input()).size).toBe(0)
    expect(warn).toHaveBeenCalled()
  })

  it('registration survives a failing classification listener', () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    const menu = new SubagentCatalogPresentation(ctx)
    // The shared observer helper contains listener failures; registration and
    // withdrawal must still complete.
    menu.revision.subscribe(() => { throw new Error('listener failed') })
    const dispose = menu.register({
      id: 'support',
      classify: () => new Map([[SUPPORT, 'support' as const]]),
      revision: createSnapshotStore(0),
    })
    expect(menu.classify(input()).size).toBe(1)
    expect(() => { dispose() }).not.toThrow()
    expect(menu.classify(input()).size).toBe(0)
  })

  it('rejects empty and duplicate classifier ids', () => {
    const { menu } = fixture()
    const revision = createSnapshotStore(0)
    expect(() => menu.register({ id: ' ', classify: () => undefined, revision })).toThrow('non-empty')
    menu.register({ id: 'support', classify: () => undefined, revision })
    expect(() => menu.register({ id: 'support', classify: () => undefined, revision })).toThrow('already registered')
  })
})
