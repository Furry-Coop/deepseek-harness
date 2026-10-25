/** Row badge layout contract: one shared host budget and no empty seat. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/rows/Rows.module.css', import.meta.url)), 'utf8')

/**
 * Declarations of one exact selector.
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

describe('Rows.module.css badge seat', () => {
  it('keeps one shared width budget for every contributing plugin', () => {
    const container = declarations('.rowBadges')
    expect(container?.get('display')).toBe('inline-flex')
    expect(container?.get('max-width')).toBe('96px')
    expect(container?.get('overflow')).toBe('hidden')
    expect(container?.get('gap')).toBe('4px')
    // The individual badge shrinks inside the shared budget instead of owning
    // a separate limit, and its clipped text keeps the native title.
    const badge = declarations('.rowBadge')
    expect(badge?.get('flex')).toBe('0 1 auto')
    expect(badge?.get('min-width')).toBe('0')
    expect(badge?.get('text-overflow')).toBe('ellipsis')
    expect(badge?.get('pointer-events')).toBeUndefined()
  })

  it('removes the seat when no host badge rendered inside the slot anchor', () => {
    const hidden = declarations('.rowBadges:not(:has(> [data-slot] .rowBadge))')
    expect(hidden?.get('display')).toBe('none')
  })
})
