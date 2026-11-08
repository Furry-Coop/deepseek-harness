import { describe, expect, it } from 'vitest'
import {
  ADMITTED_CONSUMER,
  checkControlWriteCallers,
  isAdmittedCaller,
  OWNER_FILE,
} from './verify-control-write-callers.ts'

const OWNER_SOURCE = 'export function appendAfterPublication<T>(session, type, data): void { return }\n'
const RELEASE = 'packages/core/agent/src/index.ts'
const CONSUMER_SOURCE = "import { appendAfterPublication } from '@deepseek-ai/dsh-session'\nappendAfterPublication(session, 'turn/start', {})\n"

function corpus(release: string, extra: Record<string, string> = {}): Map<string, string> {
  return new Map(Object.entries({
    [OWNER_FILE]: OWNER_SOURCE,
    [ADMITTED_CONSUMER]: CONSUMER_SOURCE,
    [RELEASE]: release,
    ...extra,
  }))
}

describe('verify-control-write-callers', () => {
  it.each([
    ['a named import', "import { appendAfterPublication } from '@deepseek-ai/dsh-session'"],
    ['an aliased import', "import { appendAfterPublication as defer } from '@deepseek-ai/dsh-session'"],
    ['a re-export', "export { appendAfterPublication } from '@deepseek-ai/dsh-session'"],
    ['a namespace member call', "S.appendAfterPublication(session, 'turn/start', {})"],
    ['a destructured binding', 'const { appendAfterPublication: defer } = S'],
    ['an element access', "S['appendAfterPublication'](session, 'turn/start', {})"],
    ['a template element access', 'S[`appendAfterPublication`](session, `turn/start`, {})'],
  ])('rejects %s in release package source', (_form, source) => {
    expect(checkControlWriteCallers(corpus(`${source}\n`))).toEqual([{ file: RELEASE, line: 1, text: source }])
  })

  it('ignores comments, JSDoc links, longer strings, other identifiers, and wildcard re-exports', () => {
    const source = [
      '// appendAfterPublication is host-internal',
      '/** The inbox uses {@link appendAfterPublication}. */',
      "const message = 'only the agent loop may call appendAfterPublication'",
      'const appendAfterPublications = 1',
      "export * from '@deepseek-ai/dsh-session'",
    ].join('\n')
    expect(checkControlWriteCallers(corpus(source))).toEqual([])
  })

  it('admits the owner, the inbox consumer, tests, and this gate', () => {
    for (const file of [
      OWNER_FILE,
      ADMITTED_CONSUMER,
      'packages/core/agent-loop/tests/cancel.spec.ts',
      'scripts/verify-control-write-callers.spec.ts',
      'scripts/verify-control-write-callers.ts',
    ]) expect(isAdmittedCaller(file), file).toBe(true)
    for (const file of [RELEASE, 'packages/core/session/src/surface.ts', 'scripts/tool.ts', 'apps/web/src/main.ts']) {
      expect(isAdmittedCaller(file), file).toBe(false)
    }
  })

  it('refuses a corpus whose owner no longer exports the function', () => {
    for (const owner of [undefined, 'function appendAfterPublication<T>() {}\n', 'export const appendAfterPublication = () => {}\n']) {
      const files = corpus('')
      if (owner === undefined) files.delete(OWNER_FILE)
      else files.set(OWNER_FILE, owner)
      expect(() => checkControlWriteCallers(files)).toThrow(/no longer exports function appendAfterPublication/)
    }
  })

  it('refuses a corpus without the admitted consumer', () => {
    const files = corpus('')
    files.delete(ADMITTED_CONSUMER)
    expect(() => checkControlWriteCallers(files)).toThrow(/lacks packages\/core\/agent-loop\/src\/inbox.ts/)
  })
})
