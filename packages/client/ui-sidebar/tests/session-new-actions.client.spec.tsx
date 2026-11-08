// @vitest-environment jsdom
/**
 * The New Session action group through the RC1 shell, the real slot renderer,
 * and the host action Factory: no contribution, one, several, withdrawal, the
 * last standard row's radius, repeated clicks, failed reports, and the row's
 * own lifetime. Proves the shell structure and the standard row behavior, not
 * only the registration count.
 */
import { StrictMode, createElement, type ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { allowAllAccess, makeTranslate, SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { NewSessionActionRow } from '../src/client/NewSessionAction.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

/**
 * Boot the package over the slot test runtime with the shell and the
 * frame-wide overlay rendered, so rows and their failure notice run through
 * the production registration path.
 * @returns the runtime, the shared Workspace action spy, and the shell view.
 */
async function bench() {
  const runtime = await SlotTestRuntime.create()
  const startSession = vi.fn()
  runtime.ctx.provide('shortcuts', { catalog: createSnapshotStore([]) } as never)
  runtime.ctx.provide('layout', { toggleSidebar: vi.fn(), selectPanel: vi.fn() })
  runtime.ctx.provide('uiWorkspace', { startSession } as never)
  const locale = new LocaleRuntime(runtime.ctx)
  locale.setLocale('en')
  locale.register('common', { zh: commonZh, en: commonEn })
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.root.declare({
    'sidebar': { kind: 'single', scope: 'root' },
    'shell.overlay': { kind: 'list', scope: 'root' },
  }, ({ renderSlot }) => (
    <>
      {renderSlot('sidebar', { collapsed: false, width: 300, drawer: false })}
      {renderSlot('shell.overlay', {})}
    </>
  ))
  await runtime.mount({ inject: [...inject], apply })
  const view = runtime.renderRoot()
  return { runtime, startSession, view }
}

/**
 * Register one action entry rendering the host's standard row.
 * @param runtime - the mounted bench runtime.
 * @param id - entry id.
 * @param label - row text.
 * @param order - list order.
 * @param invoked - the entry's business callback.
 * @param extra - optional sibling content rendered beside the standard row.
 * @returns the entry's disposable handle.
 */
async function addAction(
  runtime: SlotTestRuntime,
  id: string,
  label: string,
  order: number,
  invoked: () => void | Promise<void>,
  extra?: () => ReactNode,
) {
  return await runtime.mount({
    inject: ['slots'],
    apply(ctx) {
      ctx.slots.register(
        { name: 'sidebar.session.new.action', id, order, inject: () => ({}) },
        ({ wide, renderFactorySlot }) => (
          <>
            {renderFactorySlot('sidebar.new-session.action', { wide, label, onInvoke: invoked })}
            {extra?.()}
          </>
        ),
      )
    },
  })
}

/** The action list's rendered container, or null while unoccupied. */
function actions(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="sidebar.session.new.action"]')
}

/** Rows inside the group's accessible container. */
function groupRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="group"] button')]
}

describe('New Session action group', () => {
  it('keeps the native single button when nothing contributes', async () => {
    const { runtime, view } = await bench()
    expect(actions()).toBeNull()
    expect(document.querySelector('[role="group"]')).toBeNull()
    const native = view.getAllByRole('button', { name: 'New session' }).at(-1)!
    expect(native.parentElement?.className).toMatch(/newSessionGroup/)
    expect(native.parentElement?.className).not.toMatch(/grouped/)
    await runtime.dispose()
  })

  it('groups one, then several, then restores the native button on withdrawal', async () => {
    const { runtime, view } = await bench()
    const invoked: string[] = []
    const first = await addAction(runtime, 'first', 'Nodes session', 20, () => { invoked.push('first') })
    await act(async () => {})
    expect(actions()?.closest('[role="group"]')?.getAttribute('aria-label')).toBe('New session methods')
    expect(groupRows()).toHaveLength(1)
    expect(groupRows()[0]!.textContent).toBe('Nodes session')
    groupRows()[0]!.click()
    await act(async () => {})
    expect(invoked).toEqual(['first'])

    const second = await addAction(runtime, 'second', 'More session', 30, () => { invoked.push('second') })
    await act(async () => {})
    expect(groupRows()).toHaveLength(2)

    await act(async () => { await second.dispose() })
    expect(groupRows()).toHaveLength(1)
    await act(async () => { await first.dispose() })
    expect(actions()).toBeNull()
    const native = view.getAllByRole('button', { name: 'New session' }).at(-1)!
    expect(native.parentElement?.className).not.toMatch(/grouped/)
    await runtime.dispose()
  })

  it('rounds only the last standard action, ignoring an extra sibling in the same entry', async () => {
    const { runtime } = await bench()
    const first = await addAction(runtime, 'first', 'First action', 20, () => {})
    const second = await addAction(runtime, 'second', 'Second action', 30, () => {}, () => <div data-extra />)
    await act(async () => {})
    const buttons = groupRows()
    expect(buttons).toHaveLength(2)
    // The factory renders each occurrence without a layout wrapper, so the
    // standard rows are DOM siblings; the trailing extra node never becomes
    // the "last action" the radius selector targets.
    const last = [...document.querySelectorAll<HTMLElement>('[role="group"] button:last-of-type')]
    expect(last).toHaveLength(1)
    expect(last[0]).toBe(buttons[1])
    await act(async () => { await first.dispose(); await second.dispose() })
    await runtime.dispose()
  })

  it('runs one invocation at a time and accepts the next click after it settles', async () => {
    const { runtime } = await bench()
    const gate = Promise.withResolvers<undefined>()
    const invoked = vi.fn(() => gate.promise)
    await addAction(runtime, 'busy', 'Busy action', 20, invoked)
    await act(async () => {})
    const row = groupRows()[0]!
    row.click()
    await act(async () => {})
    expect(invoked).toHaveBeenCalledOnce()
    expect(row.getAttribute('aria-busy')).toBe('true')
    // The pending guard drops a second click while the first still runs.
    row.click()
    await act(async () => {})
    expect(invoked).toHaveBeenCalledOnce()
    gate.resolve(undefined)
    await act(async () => { await Promise.resolve(undefined); await Promise.resolve(undefined) })
    expect(row.getAttribute('aria-busy')).toBe('false')
    row.click()
    await act(async () => {})
    expect(invoked).toHaveBeenCalledTimes(2)
    await runtime.dispose()
  })

  it('reports a rejection through the shell notice, which outlives the contribution', async () => {
    const { runtime } = await bench()
    const action = await addAction(runtime, 'reject', 'Rejecting action', 20, () => Promise.reject(new Error('policy unavailable')))
    await act(async () => {})
    groupRows()[0]!.click()
    await act(async () => {})
    const alert = document.querySelector('[role="alert"]')
    expect(alert?.textContent).toBe('Extra New Session action failed: policy unavailable')

    // The banner lives in the frame-wide overlay: removing the row keeps it.
    await act(async () => { await action.dispose() })
    expect(actions()).toBeNull()
    expect(document.querySelector('[role="alert"]')).toBe(alert)
    await runtime.dispose()
  })

  it('drops a late rejection once its contribution is withdrawn', async () => {
    const { runtime, startSession, view } = await bench()
    const gate = Promise.withResolvers<undefined>()
    const action = await addAction(runtime, 'pending', 'Pending action', 20, () => gate.promise)
    await act(async () => {})
    groupRows()[0]!.click()
    await act(async () => {})
    await act(async () => { await action.dispose() })
    gate.reject(new Error('late failure'))
    await act(async () => { await Promise.resolve(undefined); await Promise.resolve(undefined) })
    expect(document.querySelector('[role="alert"]')).toBeNull()
    // The native upper button still works normally.
    const native = view.getAllByRole('button', { name: 'New session' }).at(-1) as HTMLElement
    native.click()
    expect(startSession).toHaveBeenCalledOnce()
    await runtime.dispose()
  })

  it('does not report a late rejection after the shell is released', async () => {
    const { runtime } = await bench()
    const gate = Promise.withResolvers<undefined>()
    await addAction(runtime, 'released', 'Released action', 20, () => gate.promise)
    await act(async () => {})
    groupRows()[0]!.click()
    await act(async () => {})
    // dispose() runs its own act scope; the release settles before the rejection arrives.
    const disposal = runtime.dispose()
    gate.reject(new Error('late failure after release'))
    await disposal
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })
})

describe('NewSessionActionRow presentation', () => {
  const translate = makeTranslate(en, commonEn)
  const neverHook = (() => { throw new Error('the row reads no global hook') }) as never

  /**
   * Props of one row occurrence: the entry input, the framework seats the row
   * consumes, and the standard props it never reads.
   * @param overrides - occurrence input overrides.
   * @returns the row element.
   */
  function row(overrides: {
    rail?: boolean
    disabled?: boolean
    onInvoke?: () => void | Promise<void>
  } = {}) {
    const props = {
      wide: overrides.rail !== true,
      label: 'Extra action',
      disabled: overrides.disabled,
      onInvoke: overrides.onInvoke ?? (() => {}),
      reportFailure: vi.fn(),
      useFactorySlot: ((_name: string, fallback: unknown) => fallback) as never,
      renderFactorySlot: (() => null) as never,
      t: translate,
      useResource: neverHook,
      useContextMenu: neverHook,
      usePanelInfo: neverHook,
      useWorkspaces: neverHook,
      useSessions: neverHook,
      useSessionStatus: neverHook,
      useSessionRetainInfo: neverHook,
      ...allowAllAccess,
    } as FactoryComponentPropsOf<'sidebar.new-session.action'>
    return createElement(NewSessionActionRow, props)
  }

  it('keeps the label as the accessible name in the collapsed rail and as visible text when wide', () => {
    render(row({ rail: true }))
    const railRow = screen.getByRole('button', { name: 'Extra action' })
    expect(railRow.getAttribute('title')).toBe('Extra action')
    cleanup()
    render(row())
    const wideRow = screen.getByRole('button', { name: 'Extra action' })
    expect(wideRow.getAttribute('title')).toBeNull()
    expect(wideRow.textContent).toBe('Extra action')
  })

  it('refuses invocation while the entry disables it', async () => {
    const invoked = vi.fn()
    render(row({ disabled: true, onInvoke: invoked }))
    fireEvent.click(screen.getByRole('button', { name: 'Extra action' }))
    await act(async () => { await Promise.resolve(undefined) })
    expect(invoked).not.toHaveBeenCalled()
  })

  it('stays clickable under StrictMode effect replay', async () => {
    const invoked = vi.fn()
    render(createElement(StrictMode, null, row({ onInvoke: invoked })))
    fireEvent.click(screen.getByRole('button', { name: 'Extra action' }))
    await act(async () => { await Promise.resolve(undefined) })
    expect(invoked).toHaveBeenCalledOnce()
  })
})
