// @vitest-environment jsdom
/**
 * The New Session action group through the real slot renderer and the host
 * action Factory: no contribution, one, several, withdrawal, failed reports,
 * and the row's own lifetime. Proves the shell structure and the standard row
 * behavior, not only the registration count.
 */
import { StrictMode, createElement, type ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { NewSessionActionRow } from '../src/client/NewSessionAction.tsx'

afterEach(cleanup)

async function bench() {
  const runtime = await SlotTestRuntime.create()
  const startSession = vi.fn()
  runtime.ctx.provide('shortcuts', { catalog: createSnapshotStore([]) } as never)
  runtime.ctx.provide('layout', { toggleSidebar: vi.fn() })
  runtime.ctx.provide('uiWorkspace', { startSession } as never)
  const locale = new LocaleRuntime(runtime.ctx)
  locale.register('common', { zh: commonZh, en: commonEn })
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.root.declare({
    'sidebar': { kind: 'single', scope: 'root' },
    'shell.overlay': { kind: 'list', scope: 'root' },
  }, ({ renderSlot }) => (
    <>
      {renderSlot('sidebar', { collapsed: false, width: 300 })}
      {renderSlot('shell.overlay', {})}
    </>
  ))
  await runtime.mount({ inject: [...inject], apply })
  const view = runtime.renderRoot()
  const slot = { container: view.container, view }
  return { runtime, locale, startSession, view, slot }
}

/** Register one action entry that renders the host's standard row. */
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
            {renderFactorySlot('sidebar.new-session.action', { wide, label, disabled: false, onInvoke: invoked })}
            {extra?.()}
          </>
        ),
      )
    },
  })
}

function toolbar(slot: { readonly container: HTMLElement }): HTMLElement {
  return slot.container.querySelector('[data-slot="sidebar.session.new.action"]') as HTMLElement
}

describe('New Session action group', () => {
  it('keeps the native single button when nothing contributes', async () => {
    const { runtime, slot } = await bench()
    expect(slot.container.querySelector('[data-slot="sidebar.session.new.action"]')).toBeNull()
    const native = slot.view.getAllByRole('button', { name: 'New session' }).at(-1)!
    expect(native.parentElement?.className).toMatch(/newSessionGroup/)
    expect(native.parentElement?.className).not.toMatch(/grouped/)
    await runtime.dispose()
  })

  it('groups one, then several, then restores the native button on withdrawal', async () => {
    const { runtime, slot } = await bench()
    const invoked: string[] = []
    const first = await addAction(runtime, 'first', 'Nodes 新会话', 20, () => { invoked.push('first') })
    await act(async () => {})
    const actions = toolbar(slot)
    expect(actions).not.toBeNull()
    expect(actions.closest('[role="group"]')?.getAttribute('aria-label')).toBe('New session methods')
    const hostRows = slot.container.querySelectorAll('[role="group"] button')
    expect(hostRows).toHaveLength(1)
    expect((hostRows[0] as HTMLElement).textContent).toBe('Nodes 新会话')
    ;(hostRows[0] as HTMLElement).click()
    await act(async () => {})
    expect(invoked).toEqual(['first'])

    const second = await addAction(runtime, 'second', 'More session', 30, () => { invoked.push('second') })
    await act(async () => {})
    expect(slot.container.querySelectorAll('[role="group"] button')).toHaveLength(2)

    await act(async () => { await second.dispose() })
    expect(slot.container.querySelectorAll('[role="group"] button')).toHaveLength(1)
    await act(async () => { await first.dispose() })
    expect(slot.container.querySelector('[data-slot="sidebar.session.new.action"]')).toBeNull()
    const native = slot.view.getAllByRole('button', { name: 'New session' }).at(-1)!
    expect(native.parentElement?.className).not.toMatch(/grouped/)
    await runtime.dispose()
  })

  it('rounds only the last standard action, ignoring an extra sibling in the same entry', async () => {
    const { runtime, slot } = await bench()
    const first = await addAction(runtime, 'first', 'First action', 20, () => {})
    const second = await addAction(runtime, 'second', 'Second action', 30, () => {}, () => <div data-extra />)
    await act(async () => {})
    const buttons = slot.container.querySelectorAll('[role="group"] button')
    expect(buttons).toHaveLength(2)
    // The factory renders each occurrence without a layout wrapper, so the
    // standard rows are DOM siblings; the trailing extra node does not become
    // the "last action" the radius selector targets.
    const last = slot.container.querySelectorAll('[role="group"] button:last-of-type')
    expect(last).toHaveLength(1)
    expect(last[0]).toBe(buttons[1])
    await act(async () => { await first.dispose(); await second.dispose() })
    await runtime.dispose()
  })

  it('reports a rejection through the shell notice, which outlives the contribution', async () => {
    const { runtime, slot } = await bench()
    const action = await addAction(runtime, 'reject', 'Rejecting action', 20, () => Promise.reject(new Error('policy unavailable')))
    await act(async () => {})
    ;(toolbar(slot).querySelector('button') as HTMLElement).click()
    await act(async () => {})
    const alert = document.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('Extra New Session action failed: policy unavailable')

    // The banner lives in the frame-wide overlay: removing the row keeps it.
    await act(async () => { await action.dispose() })
    expect(slot.container.querySelector('[data-slot="sidebar.session.new.action"]')).toBeNull()
    expect(document.querySelector('[role="alert"]')).toBe(alert)
    await runtime.dispose()
  })

  it('drops a late rejection once its contribution is withdrawn', async () => {
    const { runtime, startSession, slot } = await bench()
    const gate = Promise.withResolvers<undefined>()
    const action = await addAction(runtime, 'pending', 'Pending action', 20, () => gate.promise)
    await act(async () => {})
    ;(toolbar(slot).querySelector('button') as HTMLElement).click()
    await act(async () => {})
    await act(async () => { await action.dispose() })
    gate.reject(new Error('late failure'))
    await act(async () => { await Promise.resolve(undefined); await Promise.resolve(undefined) })
    expect(document.querySelector('[role="alert"]')).toBeNull()
    // The native upper button still works normally.
    const native = slot.view.getAllByRole('button', { name: 'New session' }).at(-1) as HTMLElement
    native.click()
    expect(startSession).toHaveBeenCalledOnce()
    await runtime.dispose()
  })

  it('does not report a late rejection after the shell is released', async () => {
    const { runtime, slot } = await bench()
    const gate = Promise.withResolvers<undefined>()
    await addAction(runtime, 'released', 'Released', 20, () => gate.promise)
    await act(async () => {})
    ;(toolbar(slot).querySelector('button') as HTMLElement).click()
    await act(async () => {})
    const disposal = runtime.dispose()
    gate.reject(new Error('late failure after release'))
    await disposal
  })
})

describe('NewSessionActionRow lifetime', () => {
  const rowProps = (overrides = {}) => ({
    wide: true,
    label: 'Action',
    disabled: false,
    onInvoke: () => {},
    reportFailure: vi.fn(),
    useFactorySlot: () => () => null,
    renderFactorySlot: () => null,
    t: (key: string) => key,
    ...overrides,
  }) as never

  it('stays clickable under StrictMode effect replay', () => {
    const invoke = vi.fn()
    render(createElement(StrictMode, null, createElement(NewSessionActionRow, rowProps({ onInvoke: invoke }))))
    fireEvent.click(screen.getByRole('button', { name: 'Action' }))
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('drops a rejection that arrives after unmount', () => {
    const gate = Promise.withResolvers<undefined>()
    const reportFailure = vi.fn()
    const view = render(createElement(NewSessionActionRow, rowProps({ onInvoke: () => gate.promise, reportFailure })))
    fireEvent.click(screen.getByRole('button', { name: 'Action' }))
    view.unmount()
    gate.reject(new Error('late'))
    return Promise.resolve(undefined).then(() => {
      expect(reportFailure).not.toHaveBeenCalled()
    })
  })
})
