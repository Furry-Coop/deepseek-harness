// @vitest-environment jsdom
/**
 * The Session-row badge seat through the real slot renderer and the host badge
 * Factory: one registered row, one ordinary row whose contributions return
 * nothing, several plugins sharing one container, and withdrawal. Proves the
 * host structure around the shared width budget, the native time cell, and the
 * row's own click.
 */
import { act, cleanup, within } from '@testing-library/react'
import { SlotTestRuntime, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionRowBadgeOwnerProps } from '../src/client/contract/slots.ts'
import { SessionNodeItem } from '../src/client/rows/Rows.tsx'
import { SessionRowBadge } from '../src/client/SessionRowBadge.tsx'
import type { SessionNode } from '../src/client/tree.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate({ ...en, ...commonEn }) as never

const nodesRow: SessionNode = {
  id: 'session-nodes' as SessionNode['id'],
  title: 'Nodes row', blank: false, running: false,
  runningSubagentCount: 0, completed: false, updatedAt: 0, pinned: false, archived: false,
}
const ordinaryRow: SessionNode = { ...nodesRow, id: 'session-ordinary' as SessionNode['id'], title: 'Ordinary row' }

async function bench() {
  const runtime = await SlotTestRuntime.create()
  const onOpen = vi.fn()
  await runtime.root.declare({ 'sidebar.session.row.badge': { kind: 'list', scope: 'root' } }, ({ renderSlot }) => {
    // Only the badge seat is routed to the real renderer here; the row's other
    // child seats are irrelevant to this layout and stay unmounted.
    const rowSlot = ((key: string, owner: object, opts?: object) => key === 'sidebar.session.row.badge'
      ? renderSlot(key, owner as never, opts as never)
      : null) as never
    return (
      <div>
        <div data-testid="nodes-row">
          <SessionNodeItem node={nodesRow} currentId={undefined} now={0} onOpen={onOpen}
            onRenameRequest={() => {}} renderSlot={rowSlot} t={t} />
        </div>
        <div data-testid="ordinary-row">
          <SessionNodeItem node={ordinaryRow} currentId={undefined} now={0} onOpen={onOpen}
            onRenameRequest={() => {}} renderSlot={rowSlot} t={t} />
        </div>
      </div>
    )
  })
  await runtime.mount({
    inject: ['slots'],
    apply(ctx) {
      ctx.slots.registerFactory({ name: 'sidebar.session.badge', scope: 'root' }, SessionRowBadge)
    },
  })
  const view = runtime.renderRoot()
  const first = await runtime.mount({
    inject: ['slots'],
    apply(ctx) {
      ctx.slots.register(
        { name: 'sidebar.session.row.badge', id: 'nodes', order: 100 },
        ({ sessionId, renderFactorySlot }: SessionRowBadgeOwnerProps & PropsRenderFactories) => sessionId === nodesRow.id
          ? renderFactorySlot('sidebar.session.badge', { text: 'Nodes', title: 'Nodes 模式' })
          : null,
      )
    },
  })
  await act(async () => {})
  return { runtime, view, onOpen, first }
}

describe('Session-row badge seat', () => {
  it('marks the registered row, leaves an ordinary row with no badge box, and keeps the row click', async () => {
    const { runtime, view, onOpen } = await bench()
    const marked = within(view.getByTestId('nodes-row'))
    const badge = marked.getByText('Nodes')
    expect(badge.getAttribute('title')).toBe('Nodes 模式')
    expect(badge.getAttribute('aria-label')).toBe('Nodes 模式')
    // The badge sits before the native relative time inside a host container.
    const time = marked.getByText('now')
    expect(badge.compareDocumentPosition(time) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    const ordinary = within(view.getByTestId('ordinary-row'))
    expect(ordinary.queryByText('Nodes')).toBeNull()
    // The slot anchor still exists (layout-neutral), but contains no host badge.
    const anchor = view.getByTestId('ordinary-row').querySelector('[data-slot="sidebar.session.row.badge"]')
    expect(anchor).not.toBeNull()
    expect(anchor?.querySelectorAll('*')).toHaveLength(0)

    badge.click()
    expect(onOpen).toHaveBeenCalledWith(nodesRow.id)
    await runtime.dispose()
  })

  it('shares one host container across several plugins and clears it on withdrawal', async () => {
    const { runtime, view, first } = await bench()
    const second = await runtime.mount({
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.register(
          { name: 'sidebar.session.row.badge', id: 'second', order: 200 },
          ({ sessionId, renderFactorySlot }: SessionRowBadgeOwnerProps & PropsRenderFactories) => sessionId === nodesRow.id
            ? renderFactorySlot('sidebar.session.badge', {
              text: 'A very long plugin badge label that must be clipped',
              title: 'Complete long explanation',
            })
            : null,
        )
      },
    })
    await act(async () => {})
    const marked = within(view.getByTestId('nodes-row'))
    expect(marked.getByText('Nodes')).toBeTruthy()
    const long = marked.getByText('A very long plugin badge label that must be clipped')
    expect(long.getAttribute('title')).toBe('Complete long explanation')
    // Both plugins render inside the same host container (the shared budget).
    const container = marked.getByText('Nodes').parentElement?.parentElement
    expect(container).toBe(long.parentElement?.parentElement)
    expect(container?.querySelectorAll('span')).toHaveLength(2)

    await act(async () => { await second.dispose() })
    expect(marked.queryByText('A very long plugin badge label that must be clipped')).toBeNull()
    await act(async () => { await first.dispose() })
    expect(marked.queryByText('Nodes')).toBeNull()
    await runtime.dispose()
  })
})
