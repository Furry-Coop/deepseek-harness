/**
 * Verify that only the agent loop's inbox calls `appendAfterPublication` from
 * production source.
 *
 * `appendAfterPublication` in `@deepseek-ai/dsh-session` is the host-internal
 * control-write capability behind the durable cancellation record. It defers one
 * typed append to the publication that owns a Session and commits it before store
 * detach. Appends belong in the operation that owns them, so a release or
 * experimental plugin must not schedule writes through it. The owner module, the
 * admitted inbox consumer, tests that exercise the operation, and this gate are
 * exempt.
 *
 * Discovery is syntax-aware: every identifier spelled `appendAfterPublication`
 * counts — an import, a re-export, a call, a namespace member, a destructured
 * binding — and so does a string literal of exactly that name, which reaches the
 * function by element access. Comments, longer strings, and wildcard re-exports
 * name nothing and are not reported. Source discovery and reference parsing are
 * shared with the plugin-record gate in `restricted-source-callers.ts`.
 */

import { resolve } from 'node:path'
import {
  findSourceReferences,
  isTestFile,
  readRepositorySources,
  type SourceReference,
} from './restricted-source-callers.ts'

/** The restricted function. */
export const RESTRICTED_NAME = 'appendAfterPublication'

/** The module that declares the restricted function. */
export const OWNER_FILE = 'packages/core/session/src/index.ts'

/** The only production source admitted to call the restricted function. */
export const ADMITTED_CONSUMER = 'packages/core/agent-loop/src/inbox.ts'

/** This gate and its spec name the restricted function to find it. */
const GATE_FILES: ReadonlySet<string> = new Set([
  'scripts/verify-control-write-callers.ts',
  'scripts/verify-control-write-callers.spec.ts',
])

/** One production-source reference to the restricted function outside its admitted caller. */
export type ControlWriteCaller = SourceReference

/**
 * Whether a file may reference the restricted function.
 * @param file - repository-relative path, in POSIX separators.
 * @returns whether the file is the owner, the admitted consumer, a test, or this gate.
 */
export function isAdmittedCaller(file: string): boolean {
  return file === OWNER_FILE || file === ADMITTED_CONSUMER || isTestFile(file) || GATE_FILES.has(file)
}

/**
 * Find references to the restricted function in one source file, admitted or not.
 * @param file - repository-relative path; its extension selects the parser.
 * @param source - file contents.
 * @returns one entry per referencing identifier or exact-name string literal, in source order.
 */
export function findControlWriteReferences(file: string, source: string): ControlWriteCaller[] {
  if (!source.includes(RESTRICTED_NAME)) return []
  return findSourceReferences(file, source, RESTRICTED_NAME)
}

/**
 * Check a source corpus and return its unadmitted references.
 * @param files - repository-relative path, in POSIX separators, to contents.
 * @returns every reference outside the owner, the admitted consumer, tests, and this gate.
 * @throws when the corpus lacks the owner's exported declaration or the admitted consumer,
 *   because the gate would then pass by checking the wrong files.
 */
export function checkControlWriteCallers(files: ReadonlyMap<string, string>): ControlWriteCaller[] {
  const owner = files.get(OWNER_FILE)
  if (owner === undefined || !owner.includes(`export function ${RESTRICTED_NAME}<`)) {
    throw new Error(`verify-control-write-callers: ${OWNER_FILE} no longer exports function ${RESTRICTED_NAME}; update this gate with the move or rename.`)
  }
  if (!files.has(ADMITTED_CONSUMER)) {
    throw new Error(`verify-control-write-callers: the corpus lacks ${ADMITTED_CONSUMER}; the file listing no longer matches the repository.`)
  }
  return [...files.keys()]
    .filter(file => !isAdmittedCaller(file))
    .flatMap(file => findControlWriteReferences(file, files.get(file) ?? ''))
}

function main(): void {
  const callers = checkControlWriteCallers(readRepositorySources())
  if (callers.length === 0) {
    console.log('verify-control-write-callers: the only production caller is the agent-loop inbox.')
    return
  }
  console.error('verify-control-write-callers: invalid production callers.\n')
  for (const caller of callers) console.error(`  ${caller.file}:${String(caller.line)} ${caller.text}`)
  console.error('\nAppend a control record inside the operation that owns it instead of deferring it through this capability.')
  process.exit(1)
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) main()
