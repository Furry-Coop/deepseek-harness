/** Sidebar shell style contracts shared with its slot-owned controls. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/SidebarRoot.module.css', import.meta.url)), 'utf8')

/**
 * Declarations of one exact selector, keyed by property.
 * @param selector - exact selector text.
 * @returns the normalized declarations, or undefined when absent.
 */
function declarations(selector: string): Map<string, string> | undefined {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
  for (const [, selectorList = '', body = ''] of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectorList.split(',').map(value => value.trim()).includes(selector)) continue
    const found = new Map<string, string>()
    for (const part of body.split(';')) {
      const colon = part.indexOf(':')
      if (colon === -1) continue
      found.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim().replace(/\s+/g, ' '))
    }
    return found
  }
  return undefined
}

describe('SidebarRoot.module.css', () => {
  it('uses a compact expanded navigation gap without shrinking the collapsed rail spacing', () => {
    expect(declarations('.panelList')?.get('gap')).toBe('2px')
    expect(declarations('.collapsed .panelList')?.get('gap')).toBe('12px')
  })

  it('shares and cancels the wide shell trailing padding structurally', () => {
    const root = declarations('.root')
    expect(root?.get('--dsh-sidebar-inline-padding')).toBe('8px')
    expect(root?.get('--dsh-sidebar-row-padding')).toBe('12px')
    expect(root?.get('--dsh-sidebar-label-gap')).toBe('6px')
    expect(root?.get('--dsh-sidebar-paint-inset')).toBe('3px')
    expect(root?.get('padding')).toBe('6px var(--dsh-sidebar-inline-padding)')
    expect(declarations('.regionArea')?.get('margin-left')).toBe('-4px')
    expect(declarations('.regionArea')?.get('padding-left')).toBe('4px')
    expect(declarations('.regionArea')?.get('margin-right')).toBe(
      'calc(-1 * var(--dsh-sidebar-inline-padding))',
    )
    expect(declarations('.collapsed .regionArea')?.get('margin-left')).toBe('0')
    expect(declarations('.collapsed .regionArea')?.get('padding-left')).toBe('0')
    expect(declarations('.collapsed .regionArea')?.get('margin-right')).toBe('0')
  })

  it('keeps the reviewed expanded spacing separate from rail and caption controls', () => {
    expect(declarations('.logoRow')?.get('padding')).toBe('8px 0 8px 8px')
    expect(declarations('.logoRow')?.get('margin-bottom')).toBe('0')
    expect(declarations('.newSession')?.get('margin')).toBe('0 calc(var(--dsh-sidebar-paint-inset) + 1px) 10px')
    expect(declarations('.newSessionContent')?.get('justify-content')).toBe('center')
    expect(declarations(":global(html[data-platform='darwin']:not([data-fullscreen])) .root:not(.collapsed) > .topStrip > .toggle")?.get('transform')).toBe('translateX(4px)')
    expect(css).not.toContain(':not(.fading)')
    expect(declarations(':global([data-windows-titlebar]) .root:not(.collapsed) .newSession')?.has('margin-left')).toBe(false)
    expect(declarations('.topStrip')?.get('height')).toBe('52px')
    expect(declarations('.root.collapsed')?.get('padding')).toBe('18px 10px 6px')
  })

  it('moves the four upper controls while the settings seat only fades', () => {
    const animation = 'rail-in 150ms var(--ds-ease-in-out) backwards'
    for (const selector of [
      '.railIn .iconButton',
      '.railIn .newSession',
      '.railIn .regionArea',
    ]) {
      expect(declarations(selector)?.get('animation')).toBe(animation)
    }
    expect(declarations('.railIn .footArea')?.get('animation')).toBe(
      'rail-fade-in 150ms var(--ds-ease-in-out) backwards',
    )
    expect(css).toMatch(
      /@keyframes rail-in\s*\{\s*from\s*\{\s*opacity: 0;\s*transform: translateX\(49px\);\s*}\s*}/,
    )
    expect(css).toMatch(/@keyframes rail-fade-in\s*\{\s*from\s*\{\s*opacity: 0;\s*}\s*}/)
  })

  it('gives shell rail controls the same base anchor for their shared translation', () => {
    expect(declarations('.collapsed .logoRow')?.get('justify-content')).toBe('flex-start')
    expect(declarations('.collapsed .newSession')?.get('align-self')).toBe('flex-start')
    expect(declarations('.collapsed .newSession')?.get('width')).toBe('36px')
  })

  it('keeps full-size brand artwork with a compact mark-to-name gap', () => {
    expect(declarations('.brandIdentity')?.get('gap')).toBe('5px')
    expect(declarations('.brandIdentity')?.get('height')).toBe('24px')
    expect(declarations('.brandName')?.get('height')).toBe('24px')
    expect(declarations('.brandName')?.get('line-height')).toBe('24px')
    expect(declarations('.brandName')?.get('font-size')).toBe('18px')
    expect(declarations('.fallbackBrandName')?.get('font-size')).toBe('17px')
    expect(declarations('.fallbackBrandName')?.get('white-space')).toBe('nowrap')
  })

  it('joins the native capsule and contributed actions into one outline', () => {
    // The group carries the capsule's outer box so a deployment without
    // contributions renders the same single button.
    expect(declarations('.newSessionGroup')?.get('display')).toBe('flex')
    expect(declarations('.newSessionGroup')?.get('flex-direction')).toBe('column')
    expect(declarations('.newSessionGroup')?.get('margin')).toBe(
      '0 calc(var(--dsh-sidebar-paint-inset) + 1px) 10px',
    )
    expect(declarations('.newSessionGroup > .newSession')?.get('margin')).toBe('0')
    expect(declarations('.newSessionGroup.grouped > .newSession')?.get('border-radius')).toBe(
      'var(--dsw-radius-md) var(--dsw-radius-md) 0 0',
    )
    // The container itself is absent from layout until an entry occupies it.
    expect(declarations('.newSessionActions')?.get('display')).toBe('none')
    expect(declarations('.newSessionGroup.grouped > .newSessionActions')?.get('display')).toBe('flex')
    expect(declarations('.newSessionGroup.grouped > .newSessionActions .newSessionAction:last-of-type')?.get('border-radius'))
      .toBe('0 0 var(--dsw-radius-md) var(--dsw-radius-md)')
  })

  it('gives a contributed row the native capsule geometry and surface', () => {
    const action = declarations('.newSessionAction')
    expect(action?.get('height')).toBe('38px')
    expect(action?.get('padding')).toBe('8px var(--dsh-sidebar-row-padding)')
    expect(action?.get('border')).toBe('0.5px solid var(--dsw-alias-border-l3)')
    expect(action?.get('border-radius')).toBe('0')
    expect(action?.get('background')).toBe('var(--dsw-alias-button-elevated-fill)')
    expect(action?.get('color')).toBe('var(--dsw-alias-label-primary)')
    expect(declarations('.newSessionAction:focus-visible')?.get('outline-offset')).toBe('-2px')
  })

  it('keeps contributed rail actions as separate rounded icon buttons', () => {
    expect(declarations('.collapsed .newSessionGroup')?.get('margin')).toBe('0 0 12px')
    expect(declarations('.collapsed .newSessionGroup')?.get('align-self')).toBe('flex-start')
    expect(declarations('.collapsed .newSessionGroup.grouped > .newSession')?.get('border-radius'))
      .toBe('var(--dsw-radius-md)')
    expect(declarations('.collapsed .newSessionGroup.grouped > .newSessionActions')?.get('gap')).toBe('4px')
    const railAction = declarations('.collapsed .newSessionGroup.grouped > .newSessionActions .newSessionAction')
    expect(railAction?.get('width')).toBe('36px')
    expect(railAction?.get('height')).toBe('36px')
    expect(railAction?.get('border')).toBe('none')
    expect(railAction?.get('background')).toBe('transparent')
  })
})
