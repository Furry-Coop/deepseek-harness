/** Shared syntax-aware discovery of source references to a restricted Session function. */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]s|[jt]sx)$/u

/** One source reference to a restricted function name, admitted or not. */
export interface SourceReference {
  /** Repository-relative path, in POSIX separators. */
  readonly file: string
  /** One-based line number. */
  readonly line: number
  /** The trimmed source line. */
  readonly text: string
}

/**
 * Whether a repository path is a test file under the repository's lint-override globs.
 * @param file - repository-relative path, in POSIX separators.
 * @returns whether the file is a package, app, or example test, or a script spec.
 */
export function isTestFile(file: string): boolean {
  return /^(?:packages\/[^/]+\/[^/]+|apps\/[^/]+|examples\/[^/]+)\/tests\//u.test(file)
    || /^scripts\/.+\.spec\.tsx?$/u.test(file)
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (/\.[cm]?js$/u.test(file)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

/**
 * Find references to one restricted function in a source file, admitted or not.
 * @param file - repository-relative path; its extension selects the parser.
 * @param source - file contents.
 * @param name - the restricted function's name.
 * @returns one entry per referencing identifier or exact-name string literal, in source order.
 */
export function findSourceReferences(file: string, source: string, name: string): SourceReference[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file))
  const lines = source.split(/\r?\n/u)
  const references: SourceReference[] = []
  const visit = (node: ts.Node): void => {
    const named = ts.isIdentifier(node)
      || ts.isStringLiteral(node)
      || ts.isNoSubstitutionTemplateLiteral(node)
    if (named && node.text === name) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line
      references.push({ file, line: line + 1, text: lines[line]?.trim() ?? '' })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return references
}

/**
 * Read every tracked or unignored source file outside `vendor/`.
 * @param repoRoot - the repository root; defaults to this checkout.
 * @returns repository-relative path, in POSIX separators, to contents.
 */
export function readRepositorySources(repoRoot: string = root): Map<string, string> {
  const listing = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const files = new Map<string, string>()
  for (const entry of listing.split('\0')) {
    const file = entry.replaceAll('\\', '/')
    if (file === '' || file.startsWith('vendor/') || !SOURCE_EXTENSION.test(file)) continue
    try {
      files.set(file, readFileSync(resolve(repoRoot, file), 'utf8'))
    } catch (error: unknown) {
      // A file deleted in the working tree is still listed until the deletion is staged.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return files
}
