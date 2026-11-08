// @vitest-environment jsdom
/**
 * The Session-row badge seat through the RC1 native row entry, the real slot
 * renderer, and the host badge Factory: one registered row beside every native
 * row seat, ordinary rows whose contributions return nothing, several plugins
 * sharing one container, withdrawal, archived and compact rows, blank and
 * search exclusion, and the badge surviving the hover/menu/focus swap of the
 * resting cell.
 */
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import type { RenderResult } from '@testing-library/react'
import { SlotTestRuntime, allowAllAccess, contextMenuHook, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionRowBadgeOwnerProps } from '../src/client/contract/slots.ts'
import { SearchResultItem, SessionNodeItem } from '../src/client/rows/Rows.tsx'
import { SessionRowBadge } from '../src/client/SessionRowBadge.tsx'
import type { SearchResultNode, SessionNode } from '../src/client/tree.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
beforeEach(() => { vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(any-hover: hover)' })) })
afterEach(() => { vi.unstubAllGlobals() })

const t = makeTranslate(en, commonEn) as never
/** A row lands outside the Slot renderer here, so the trigger hook never opens a menu. */
const useContextMenu = contextMenuHook(() => {})

const nodesRow: SessionNode = {
  id: 'session-nodes' as SessionNode['id'],
  title: 'Nodes row', blank: false, running: false,
  runningSubagentCount: 0, completed: false, updatedAt: 0, pinned: false, archived: false,
}
const ordinaryRow: SessionNode = { ...nodesRow, id: 'session-ordinary' as SessionNode['id'], title: 'Ordinary row' }
const pendingRow: SessionNode = {
  ...nodesRow, id: 'session-pending' as SessionNode['id'], title: 'Pending row', pendingInteraction: 'approval',
}
const archivedRow: SessionNode = { ...nodesRow, id: 'session-archived' as SessionNode['id'], title: 'Archived row', archived: true }
const blankRow: SessionNode = { ...nodesRow, id: 'session-blank' as SessionNode['id'], title: '', blank: true }
const markedIds = new Set([nodesRow.id, pendingRow.id, archivedRow.id, blankRow.id])

/** Native row seats the badge must coexist with. */
function LeadingEntry() {
  return <span data-testid="leading-entry" />
}

function TrailingEntry() {
  return <span data-testid="trailing-entry" />
}

/** One plugin's contribution: only the marked rows carry its label. */
function NodesBadgeEntry({ sessionId, renderFactorySlot }: SessionRowBadgeOwnerProps & PropsRenderFactories) {
  return markedIds.has(sessionId)
    ? renderFactorySlot('sidebar.session.badge', { text: 'Nodes', title: 'Nodes mode' })
    : null
}

function LongBadgeEntry({ sessionId, renderFactorySlot }: SessionRowBadgeOwnerProps & PropsRenderFactories) {
  return sessionId === nodesRow.id
    ? renderFactorySlot('sidebar.session.badge', {
      text: 'A very long plugin badge label that must be clipped',
      title: 'Complete long explanation',
    })
    : null
}

function PlainBadgeEntry({ sessionId, renderFactorySlot }: SessionRowBadgeOwnerProps & PropsRenderFactories) {
  return sessionId === nodesRow.id
    ? renderFactorySlot('sidebar.session.badge', { text: 'Plain' })
    : null
}

/**
 * Mount the real row component through the real slot registry: the root frame
 * declares the row seats and routes them to the renderer, the host Factory is
 * registered, and the native row contributions fill the decorative seats.
 * @param options - `markedOpenMenu` renders that row with its menu open.
 * @returns the runtime, root view, row-open spy, and the first plugin handle.
 */
async function bench(options: { markedOpenMenu?: SessionNode['id'] | undefined } = {}) {
  const runtime = await SlotTestRuntime.create()
  const onOpen = vi.fn()
  await runtime.root.declare({
    'sidebar.session.row.leading': { kind: 'list', scope: 'root', inline: true },
    'sidebar.session.row.badge': { kind: 'list', scope: 'root' },
    'sidebar.session.row.trailing': { kind: 'list', scope: 'root', inline: true },
    'sidebar.session.row.hover': { kind: 'list', scope: 'root' },
  }, ({ renderSlot }) => {
    // Only the declared seats reach the real renderer; the row's action list is
    // not part of this bench and must not dispatch through an undeclared key.
    const rowSlot = ((key: string, owner: object, opts?: object) => key === 'sidebar.session.row.leading'
      || key === 'sidebar.session.row.badge'
      || key === 'sidebar.session.row.trailing'
      || key === 'sidebar.session.row.hover'
      ? renderSlot(key as never, owner as never, opts as never)
      : null) as never
    const row = (testId: string, node: SessionNode) => (
      <div data-testid={testId}>
        <SessionNodeItem
          node={node}
          currentId={undefined}
          now={0}
          onOpen={onOpen}
          onRenameRequest={() => {}}
          renderSlot={rowSlot}
          openSessionMenu={() => {}}
          useContextMenu={useContextMenu}
          useContextMenuTarget={select => select(options.markedOpenMenu === node.id
            ? { kind: 'session', value: { sessionId: node.id, displayTitle: node.title } }
            : null)}
          useSessionAccess={allowAllAccess.useSessionAccess}
          t={t}
        />
      </div>
    )
    return (
      <div>
        {row('nodes-row', nodesRow)}
        {row('ordinary-row', ordinaryRow)}
        {row('pending-row', pendingRow)}
        {row('archived-row', archivedRow)}
        {row('blank-row', blankRow)}
      </div>
    )
  })
  await runtime.mount({
    inject: ['slots'],
    apply(ctx) {
      ctx.slots.registerFactory({ name: 'sidebar.session.badge', scope: 'root' }, SessionRowBadge)
    },
  })
  const first = await runtime.mount({
    inject: ['slots'],
    apply(ctx) {
      ctx.slots.register({ name: 'sidebar.session.row.leading', id: 'test-leading', order: 10 }, LeadingEntry)
      ctx.slots.register({ name: 'sidebar.session.row.trailing', id: 'test-trailing', order: 10 }, TrailingEntry)
      ctx.slots.register({ name: 'sidebar.session.row.badge', id: 'nodes', order: 100 }, NodesBadgeEntry)
    },
  })
  const view = runtime.renderRoot()
  await act(async () => {})
  return { runtime, view, onOpen, first }
}

/** The row element whose test-id wrapper names it. */
function rowOf(view: RenderResult, testId: string): HTMLElement {
  return within(view.getByTestId(testId)).getByRole('treeitem')
}

describe('Session-row badge seat', () => {
  it('marks the registered row before the native time and keeps the whole-row click', async () => {
    const { runtime, view, onOpen } = await bench()
    const marked = within(view.getByTestId('nodes-row'))
    const badge = marked.getByText('Nodes')
    expect(badge.getAttribute('title')).toBe('Nodes mode')
    expect(badge.getAttribute('aria-label')).toBe('Nodes mode')
    // The badge sits in its own host container before the native resting cell,
    // so the time-label swap cannot take it away.
    const time = marked.getByText('now')
    expect(badge.compareDocumentPosition(time) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(badge.closest('[class*="rowResting"]')).toBeNull()
    expect(badge.closest('[data-slot="sidebar.session.row.badge"]')).not.toBeNull()

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
        ctx.slots.register({ name: 'sidebar.session.row.badge', id: 'second', order: 200 }, LongBadgeEntry)
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
    expect(container?.querySelectorAll('[class*="rowBadge"]')).toHaveLength(2)

    await second.dispose()
    expect(marked.queryByText('A very long plugin badge label that must be clipped')).toBeNull()
    await first.dispose()
    expect(marked.queryByText('Nodes')).toBeNull()
    await runtime.dispose()
  })

  it('keeps the badge outside the resting cell while hover, an open menu, and keyboard focus swap that cell', async () => {
    const { runtime, view } = await bench({ markedOpenMenu: nodesRow.id })
    const row = rowOf(view, 'nodes-row')
    const badge = within(row).getByText('Nodes')
    // The native resting cell is present and owns the time; the badge is its
    // previous sibling, not its child, so `display: none` on `.rowResting`
    // (hover, menu, keyboard focus) cannot hide it.
    const resting = row.querySelector('[class*="rowResting"]')
    expect(resting).not.toBeNull()
    expect(resting?.textContent).toContain('now')
    expect(resting?.contains(badge)).toBe(false)
    expect(row.className).toContain('menuOpen')

    fireEvent.pointerEnter(row)
    expect(row.contains(badge)).toBe(true)
    expect(badge.closest('[class*="rowResting"]')).toBeNull()

    row.focus()
    expect(document.activeElement).toBe(row)
    expect(row.contains(badge)).toBe(true)
    // The action strip shares the row with the badge rather than replacing it.
    expect(row.querySelector('[class*="rowActions"]')).not.toBeNull()
    await runtime.dispose()
  })

  it('keeps the badge beside every native row seat in one row budget', async () => {
    const { runtime, view } = await bench()
    const row = rowOf(view, 'nodes-row')
    const leading = row.querySelector('[data-testid="leading-entry"]')
    expect(leading).not.toBeNull()
    expect(row.firstElementChild?.contains(leading)).toBe(true)
    const badge = within(row).getByText('Nodes')
    const container = badge.parentElement?.parentElement as HTMLElement
    expect(container.className).toContain('rowBadges')
    expect(container.previousElementSibling?.textContent).toBe('Nodes row')
    const resting = container.nextElementSibling as HTMLElement
    expect(resting.className).toContain('rowResting')
    expect(resting.textContent).toContain('now')
    expect(resting.querySelector('[data-testid="trailing-entry"]')).not.toBeNull()
    const actions = resting.nextElementSibling as HTMLElement
    expect(actions.className).toContain('rowActions')
    expect(actions.querySelector('button')).not.toBeNull()
    await runtime.dispose()
  })

  it('keeps the badge before archived time and compact status, and off blank rows', async () => {
    const { runtime, view } = await bench()
    // An archived row still shows its time and trailing seat, so the badge
    // stays before them while the leading cell remains blank.
    const archived = within(view.getByTestId('archived-row'))
    const archivedBadge = archived.getByText('Nodes')
    const archivedTime = archived.getByText('now')
    expect(archivedBadge.compareDocumentPosition(archivedTime) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(view.getByTestId('archived-row').querySelector('[data-seat="sidebar.session.row.leading"]')).toBeNull()
    const archivedRowElement = rowOf(view, 'archived-row')
    expect(archivedRowElement.querySelector('[class*="rowResting"]')?.querySelector('[data-testid="trailing-entry"]')).not.toBeNull()

    // A compact pending label replaces the time; the badge keeps its slot and
    // the native status cell stays hidden from assistive technology.
    const pending = within(view.getByTestId('pending-row'))
    const pendingBadge = pending.getByText('Nodes')
    const compact = pending.getByText('Approval')
    expect(pendingBadge.compareDocumentPosition(compact) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(compact.getAttribute('aria-hidden')).toBe('true')

    // A blank provisional row has neither a time cell nor a badge seat.
    const blank = within(view.getByTestId('blank-row'))
    expect(blank.queryByText('Nodes')).toBeNull()
    expect(blank.queryByText('now')).toBeNull()
    expect(view.getByTestId('blank-row').querySelector('[data-slot="sidebar.session.row.badge"]')).toBeNull()
    await runtime.dispose()
  })

  it('renders no badge on a search result row', async () => {
    const { runtime } = await bench()
    const result: SearchResultNode = {
      id: nodesRow.id, title: 'Unrelated result', workspace: 'Workspace', running: false,
      runningSubagentCount: 0, completed: false, archived: false,
    }
    const view = render(<SearchResultItem result={result} currentId={undefined}
      onOpen={vi.fn()} onUnarchive={vi.fn()} useSessionAccess={allowAllAccess.useSessionAccess} t={t} />)
    expect(view.container.textContent).not.toContain('Nodes')
    expect(view.container.querySelector('[data-slot="sidebar.session.row.badge"]')).toBeNull()
    await runtime.dispose()
  })

  it('falls back to the visible text when no complete explanation is supplied', async () => {
    const { runtime, view } = await bench()
    const plain = await runtime.mount({
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.register({ name: 'sidebar.session.row.badge', id: 'plain', order: 300 }, PlainBadgeEntry)
      },
    })
    await act(async () => {})
    const badge = within(view.getByTestId('nodes-row')).getByText('Plain')
    expect(badge.getAttribute('aria-label')).toBe('Plain')
    expect(badge.getAttribute('title')).toBeNull()
    await plain.dispose()
    await runtime.dispose()
  })
})
