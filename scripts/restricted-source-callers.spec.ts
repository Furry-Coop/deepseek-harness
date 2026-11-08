import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeFixtureFile } from './fixture-file.ts'
import { findSourceReferences, readRepositorySources } from './restricted-source-callers.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('restricted source references', () => {
  it('reports each identifier and exact-name literal with its source line', () => {
    const file = 'packages/core/agent/src/index.ts'
    const source = [
      'const a = 1',
      "S.appendAfterPublication(session, 'turn/start', {})",
      "S['appendAfterPublication'](session, 'turn/start', {})",
    ].join('\n')
    expect(findSourceReferences(file, source, 'appendAfterPublication')).toEqual([
      { file, line: 2, text: "S.appendAfterPublication(session, 'turn/start', {})" },
      { file, line: 3, text: "S['appendAfterPublication'](session, 'turn/start', {})" },
    ])
  })

  it('reads tracked and unignored sources outside vendor, skipping other files and deleted ones', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-restricted-source-callers-'))
    roots.push(root)
    execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'pipe' })
    writeFixtureFile(root, '.gitignore', 'ignored/\n')
    writeFixtureFile(root, 'packages/core/session/src/index.ts', 'export {}\n')
    writeFixtureFile(root, 'scripts/tool.mjs', 'export {}\n')
    writeFixtureFile(root, 'ignored/scratch.ts', 'export {}\n')
    writeFixtureFile(root, 'vendor/cordis/src/index.ts', 'export {}\n')
    writeFixtureFile(root, 'docs/page.md', '# Page\n')
    writeFixtureFile(root, 'packages/core/gone/src/index.ts', 'export {}\n')
    execFileSync('git', ['add', '.'], { cwd: root, stdio: 'pipe' })
    rmSync(join(root, 'packages/core/gone/src/index.ts'))
    writeFixtureFile(root, 'packages/core/agent/src/new.ts', 'export {}\n')

    expect([...readRepositorySources(root).keys()].sort()).toEqual([
      'packages/core/agent/src/new.ts',
      'packages/core/session/src/index.ts',
      'scripts/tool.mjs',
    ])
  })
})
