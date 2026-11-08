/**
 * Idle formal-history maintenance over the real JSONL backend with one injected
 * storage I/O failure: the append committed in memory but not yet durably, so
 * the retry must keep the original sequence, lose no copy, and a cold reopen
 * must recover exactly one.
 *
 * The injection sits at `node:fs/promises` for one target log file only: the
 * `writeFile` window fails before any byte lands, the `sync` window fails after
 * the row bytes were written but before they were confirmed durable. The JSONL
 * backend's own rollback, live-buffer retention, and flush retry stay real.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import AgentRegistry, { IdleHistoryError } from '@deepseek-ai/dsh-agent'
import LlmRuntime, {
  MessageId, createUserMessage, freezeMessage,
} from '@deepseek-ai/dsh-llm'
import type { ContextFormed, GenerateOptions, UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockAdapter, textResponse } from './mock-adapter.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Formal history recorded by a plugin from the idle phase. */
    'idle-history-test': { kind: 'idle-history-test' } & ContextFormed
  }
}

const storageFault = vi.hoisted(() => ({
  mode: 'none' as 'none' | 'write' | 'sync',
  path: '',
  fired: 0,
  /** File size when the injected failure fired: proves which write window failed. */
  sizeAtFailure: -1,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: (async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      if (storageFault.mode === 'none' || String(args[0]) !== storageFault.path) return handle
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === 'writeFile' && storageFault.mode === 'write' && storageFault.fired === 0) {
            return async () => {
              storageFault.fired += 1
              storageFault.sizeAtFailure = (await actual.stat(storageFault.path)).size
              throw new Error('injected storage write failure')
            }
          }
          if (property === 'sync' && storageFault.mode === 'sync' && storageFault.fired === 0) {
            return async () => {
              storageFault.fired += 1
              storageFault.sizeAtFailure = (await actual.stat(storageFault.path)).size
              throw new Error('injected storage fsync failure')
            }
          }
          const value: unknown = Reflect.get(target, property, receiver)
          // Every other member delegates to the real handle. Binding keeps
          // prototype methods called with their own receiver.
          return typeof value === 'function'
            ? (...args: unknown[]): unknown => (value as (...args: unknown[]) => unknown).apply(target, args)
            : value
        },
      })
    }),
  }
})

const SESSION_ID = SessionId('idle-history-storage')

interface Host {
  readonly ctx: Context
  readonly adapter: MockAdapter
  readonly root: string
}

interface Harness extends Host {
  readonly handle: AgentHandle
  readonly agent: Agent
  readonly session: Agent['session']
}

const roots: string[] = []
const contexts: Context[] = []

async function mountHost(
  root?: string,
  script: ConstructorParameters<typeof MockAdapter>[0] = [textResponse('answer after the storage fault')],
): Promise<Host> {
  const storage = root ?? await mkdtemp(join(tmpdir(), 'dsh-idle-history-storage-'))
  if (root === undefined) roots.push(storage)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: 'storage fault persona' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  // Default zstd encoding: the production storage layout.
  await ctx.plugin(JsonlSessionPersistence, { root: storage })
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, adapter, root: storage }
}

async function mount(): Promise<Harness> {
  const host = await mountHost(undefined, [
    textResponse('first answer'),
    textResponse('answer after the storage fault'),
  ])
  const handle = await host.ctx.agents.create({
    sessionId: SESSION_ID,
    agentOptions: { provider: 'mock', model: 'model' },
  })
  return { ...host, handle, agent: handle.agent, session: handle.agent.session }
}

afterEach(async () => {
  storageFault.mode = 'none'
  storageFault.path = ''
  storageFault.fired = 0
  storageFault.sizeAtFailure = -1
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function formalMessage(text: string): UserMessage {
  return freezeMessage<UserMessage>({
    id: MessageId(`storage-${text}`),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'idle-history-test' },
  })
}

/** The committed current generation file under one storage root. */
async function generationLog(root: string): Promise<string> {
  const walk = async (directory: string): Promise<string | undefined> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isFile() && entry.name === `session.v${SESSION_FORMAT_VERSION}.jsonl.zstd`) return path
      if (!entry.isDirectory()) continue
      const found = await walk(path)
      if (found !== undefined) return found
    }
    return undefined
  }
  const found = await walk(root)
  if (found === undefined) throw new Error('the session committed no current generation log')
  return found
}

function sendAndSettle(ctx: Context, agent: Agent, text: string): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', (payload) => {
      if (payload.agent !== agent || payload.status !== 'idle') return
      dispose()
      resolve()
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  })
}

function recordedTexts(request: GenerateOptions): string[] {
  return request.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
}

describe.each(['write', 'sync'] as const)(
  'idle-history durability when the JSONL %s window fails',
  (mode) => {
    it('keeps the original position, records one copy, and preserves request order', async () => {
      const h = await mount()
      // One ordinary turn first: it materializes the generation, so the
      // maintenance below commits through the real append + fsync window.
      await sendAndSettle(h.ctx, h.agent, 'first input')
      await h.ctx.sessions.flush(h.session)
      expect(h.adapter.requests).toHaveLength(1)
      const log = await generationLog(h.root)
      const before = await readFile(log)
      const message = formalMessage(`durable-${mode}`)
      const messageText = `durable-${mode}`

      storageFault.mode = mode
      storageFault.path = log
      storageFault.fired = 0
      const failure = await h.agent.maintainIdleHistory!({ message }).catch((error: unknown) => error)
      storageFault.mode = 'none'
      expect(storageFault.fired).toBe(1)
      expect(failure).toBeInstanceOf(IdleHistoryError)
      const error = failure as IdleHistoryError
      expect(error.failure).toBe('checkpoint')
      expect(error.append?.appended).toBe(true)
      expect(error.append?.systemHeadSeq).toBeNull()
      const committedSeq = error.append?.messageSeq
      expect(committedSeq).not.toBeUndefined()

      // The write window failed before any byte landed; the fsync window failed
      // after the row bytes were written but before they were confirmed. Both
      // leave the stored generation at its previous committed size.
      if (mode === 'write') expect(storageFault.sizeAtFailure).toBe(before.length)
      else expect(storageFault.sizeAtFailure).toBeGreaterThan(before.length)
      expect(await readFile(log)).toEqual(before)

      // The retry returns the ORIGINAL sequence and appends nothing: the failed
      // batch is still the handle's retained buffer, drained by the same flush.
      const retried = await h.agent.maintainIdleHistory!({ message })
      expect(retried.appended).toBe(false)
      expect(retried.messageSeq).toBe(committedSeq)
      expect(retried.systemHeadSeq).toBeNull()
      expect(retried.checkpointed).toBe(true)
      // The maintenance itself never called the model.
      expect(h.adapter.requests).toHaveLength(1)

      // An independent read-only handle observes the durable generation before
      // the writer closes, so a successful close cannot hide a lost row: the
      // original sequence and identity are already persisted at this point.
      const reader = await h.ctx.sessionPersistence.open(SESSION_ID, 'read')
      try {
        const persisted = await reader.read()
        const row = persisted.events.find(event => event.type === 'user/message'
          && event.data.id === message.id)
        expect(row?.seq).toBe(committedSeq)
        if (row?.type !== 'user/message') throw new Error('the retry did not persist the formal user message')
        expect(row.data).toEqual(message)
      } finally {
        await reader.close()
      }

      await h.handle.dispose()
      await h.ctx.fiber.dispose()

      // A cold reopen keeps exactly one head and one recorded message.
      const cold = await mountHost(h.root)
      expect(cold.adapter.requests).toEqual([])
      const reopened = await cold.ctx.agents.resume({
        resumeSessionId: SESSION_ID,
        agentOptions: { provider: 'mock', model: 'model' },
      })
      const agent = reopened.agent
      expect(agent.session.surface.nodes
        .filter(seq => agent.session.eventAt(seq)?.type === 'system/message')).toHaveLength(1)
      expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message'
        && event.data.id === message.id)).toHaveLength(1)
      expect(cold.adapter.requests).toEqual([])

      // A real input after the recovery carries the recorded history ahead of it.
      await sendAndSettle(cold.ctx, agent, 'new input after recovery')
      const request = cold.adapter.requests.at(-1)!
      expect(request.messages.map(item => item.role)).toEqual(['system', 'user', 'assistant', 'user', 'user'])
      expect(recordedTexts(request).at(-2)).toBe(messageText)
      expect(recordedTexts(request).at(-1)).toBe('new input after recovery')
      expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message'
        && event.data.id === message.id)).toHaveLength(1)
      await reopened.dispose()
    })
  },
)
