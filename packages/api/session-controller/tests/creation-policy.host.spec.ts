/** Creation-policy coordination through the real Session command controller. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionOperationId } from '../src/types.ts'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentFactory, AgentSetup } from '@deepseek-ai/dsh-agent'
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { createScope } from '@deepseek-ai/dsh-scope'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionHeader } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import type { Workspace, WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApiSessionAgentController,
  type ApiSessionCreated,
  type ApiSessionCreateRequest,
} from '../src/agent.ts'
import type SessionController from '../src/index.ts'
import { SessionCommandController } from '../src/commands.ts'
import {
  creationPolicyRuntime,
  SessionCreationPolicyRegistry,
  type SessionCreationOutcome,
  type SessionCreationOwnership,
  type SessionCreationParticipant,
  type SessionCreationPolicy,
} from '../src/creation-policy.ts'
import { createSessionTestController, installSessionReadTestServices } from './test-remote.ts'

/** Booted real-harness contexts and their temp roots, torn down after each test. */
const realContexts: Context[] = []
const tempDirs: string[] = []
afterEach(async () => {
  await Promise.allSettled(realContexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A test operation identity carrying its cross-boundary brand. */
const opId = (value: string): SessionOperationId => brandString<SessionOperationId>(value)

/** Creation outcome publishing `sessionId` in the request cwd. */
function publishedSession(ctx: Context, sessionId: SessionId) {
  return (request: ApiSessionCreateRequest): Promise<ApiSessionCreated> => {
    const session = ctx.sessions.create(sessionId, { meta: { cwd: request.cwd } })
    return Promise.resolve({ agent: { id: session.id, session, status: 'idle', ctx } as Agent, agentPreset: undefined })
  }
}

/** The Agent controller with a controlled creation outcome. */
function agentsOf(ctx: Context, createSession?: ApiSessionAgentController['createSession']): ApiSessionAgentController {
  const agents = new ApiSessionAgentController(ctx)
  vi.spyOn(agents, 'composeAgent').mockImplementation(() => Promise.resolve({ setup: () => {} }))
  if (createSession !== undefined) vi.spyOn(agents, 'createSession').mockImplementation(createSession)
  return agents
}

/** Host context with the Session, Agent, and Workspace pieces the controller reads. */
async function bench(
  workspace: Partial<Workspace> | undefined = {},
  options: { readonly archivedSessionIds?: readonly SessionId[] } = {},
) {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  installSessionReadTestServices(ctx)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
    saveSelection: () => Promise.resolve(undefined),
  } as never)
  ctx.provide('workspaceRegistry', {
    get: (id: string) => workspace === undefined ? undefined : {
      id: id as WorkspaceId,
      path: '/workspace',
      sessionIds: [],
      attachSession: () => Promise.resolve(undefined),
      ...workspace,
    },
    list: () => workspace === undefined ? [] : [{
      id: 'ws-1' as WorkspaceId,
      path: '/workspace',
      sessionIds: [],
      attachSession: () => Promise.resolve(undefined),
      ...workspace,
    }],
    archivedSessionIds: [...(options.archivedSessionIds ?? [])],
  } as never)
  return ctx
}

/** Publish every Agent creation through the real registry under a Session created in the request cwd. */
function installCreateSession(ctx: Context) {
  return vi.spyOn(ctx.agents, 'create').mockImplementation(async (options) => {
    const session = ctx.sessions.create(options.sessionId, {
      meta: {
        cwd: options.meta?.cwd ?? '/workspace',
        ...(options.meta?.agentPreset === undefined ? {} : { agentPreset: options.meta.agentPreset }),
      },
    })
    const created = { id: session.id, session, status: 'idle', ctx } as Agent
    await options.setup?.(ctx, created)
    return { agent: created, dispose: () => Promise.resolve() }
  })
}

/** A policy that claims the listed ids and records participant calls. */
function policy(id: string, claimed: readonly string[], calls: string[] = []): SessionCreationPolicy & { calls: string[] } {
  return {
    id,
    calls,
    inspectSession: sessionId => Promise.resolve(claimed.includes(sessionId) ? 'claimed' : 'unclaimed'),
    beginOperation: (operation) => {
      calls.push(`begin:${operation.operationId}`)
      const participant: SessionCreationParticipant = {
        prepareSession: ({ sessionId }) => { calls.push(`prepare:${sessionId}`) },
        finishOperation: (outcome) => { calls.push(`finish:${outcome.kind}`) },
      }
      return Promise.resolve(participant)
    },
  }
}

describe('registration lifetime', () => {
  it('rejects an empty or duplicate policy identity', () => {
    const policies = new SessionCreationPolicyRegistry()
    expect(() => policies.register(policy('', []))).toThrow('session creation policy id must not be empty')
    policies.register(policy('@nodes/dsh-plugin:conversation', []))
    expect(() => policies.register(policy('@nodes/dsh-plugin:conversation', [])))
      .toThrow('session creation policy "@nodes/dsh-plugin:conversation" is already registered')
  })

  it('answers a named policy claim directly', async () => {
    const policies = new SessionCreationPolicyRegistry()
    policies.register(policy('@nodes/dsh-plugin:conversation', ['known']))
    await expect(creationPolicyRuntime(policies).inspect(SessionId('known'), '@nodes/dsh-plugin:conversation'))
      .resolves.toEqual({ kind: 'claimed', policyId: '@nodes/dsh-plugin:conversation' })
  })

  it('removes only the registration its disposer captured', () => {
    const policies = new SessionCreationPolicyRegistry()
    const dispose = policies.register(policy('@nodes/dsh-plugin:conversation', []))
    dispose()
    dispose()
    expect(policies.get('@nodes/dsh-plugin:conversation')).toBeUndefined()
  })

  it('treats a policy without an inspector as a definite non-claim', async () => {
    const policies = new SessionCreationPolicyRegistry()
    policies.register({ id: '@other/plugin' })
    await expect(creationPolicyRuntime(policies).inspect(SessionId('ordinary')))
      .resolves.toEqual({ kind: 'unclaimed' })
  })

  it('removes a policy when its contributing fiber is disposed', async () => {
    const ctx = await bench()
    const policies = new SessionCreationPolicyRegistry()
    const nodes = policy('@nodes/dsh-plugin:conversation', [])
    const fiber = await ctx.plugin({
      name: 'test:creation-policy',
      apply: (inner: Context) => {
        inner.effect(() => policies.register(nodes), 'test: creation policy')
      },
    })
    expect(policies.get('@nodes/dsh-plugin:conversation')).toBe(nodes)
    await fiber.dispose()
    expect(policies.get('@nodes/dsh-plugin:conversation')).toBeUndefined()
    await ctx.fiber.dispose()
  })
})

describe('ordinary creation passes the policy compatibility check', () => {
  it('reuses only a candidate every policy leaves unclaimed', async () => {
    const ctx = await bench()
    const policies = new SessionCreationPolicyRegistry()
    policies.register(policy('@nodes/dsh-plugin:conversation', ['nodes-blank']))
    const requests: ApiSessionCreateRequest[] = []
    const agents = agentsOf(ctx, (request) => {
      requests.push(request)
      return publishedSession(ctx, request.sessionId ?? SessionId('minted'))(request)
    })
    const controller = new SessionCommandController(ctx, agents, '/default', policies)

    await expect(controller.create({
      workspaceId: 'ws-1' as WorkspaceId,
      sessionId: SessionId('ordinary-blank'),
    })).resolves.toMatchObject({ sessionId: 'ordinary-blank' })
    // A claimed candidate is dropped instead of reused by an ordinary intent.
    await expect(controller.create({
      workspaceId: 'ws-1' as WorkspaceId,
      sessionId: SessionId('nodes-blank'),
    })).resolves.toMatchObject({ sessionId: 'minted' })
    await ctx.fiber.dispose()
    expect(requests.map(request => request.sessionId)).toEqual(['ordinary-blank', undefined])
  })

  it('treats an unreadable claim as not ordinary and creates a fresh Session', async () => {
    const ctx = await bench()
    const policies = new SessionCreationPolicyRegistry()
    policies.register({
      id: '@nodes/dsh-plugin:conversation',
      inspectSession: () => Promise.reject(new Error('storage down')),
    })
    const requests: ApiSessionCreateRequest[] = []
    const agents = agentsOf(ctx, (request) => {
      requests.push(request)
      return publishedSession(ctx, SessionId('fresh'))(request)
    })
    const controller = new SessionCommandController(ctx, agents, '/default', policies)

    await expect(controller.create({
      workspaceId: 'ws-1' as WorkspaceId,
      sessionId: SessionId('maybe-nodes'),
    })).resolves.toMatchObject({ sessionId: 'fresh' })
    await ctx.fiber.dispose()
    expect(requests[0]?.sessionId).toBeUndefined()
  })

  it('drops a candidate one policy claims while another cannot classify it', async () => {
    const ctx = await bench()
    const policies = new SessionCreationPolicyRegistry()
    policies.register(policy('@nodes/dsh-plugin:conversation', ['shared-blank']))
    policies.register({
      id: '@other/plugin',
      inspectSession: () => Promise.reject(new Error('storage down')),
    })
    const requests: ApiSessionCreateRequest[] = []
    const agents = agentsOf(ctx, (request) => {
      requests.push(request)
      return publishedSession(ctx, SessionId('fresh'))(request)
    })
    const controller = new SessionCommandController(ctx, agents, '/default', policies)

    await expect(controller.create({
      workspaceId: 'ws-1' as WorkspaceId,
      sessionId: SessionId('shared-blank'),
    })).resolves.toMatchObject({ sessionId: 'fresh' })
    await ctx.fiber.dispose()
    // A definite claim is not ordinary; the unreadable policy cannot make the
    // ordinary intent reuse the claimed blank.
    expect(requests[0]?.sessionId).toBeUndefined()
  })
})

describe('operated creation', () => {
  it('runs begin, prepare, and finish around the real Controller result', async () => {
    const ctx = await bench()
    const policies = new SessionCreationPolicyRegistry()
    const calls: string[] = []
    policies.register(policy('@nodes/dsh-plugin:conversation', ['nodes-blank'], calls))
    const agents = agentsOf(ctx, request => publishedSession(ctx, request.sessionId ?? SessionId('created'))(request))
    const controller = new SessionCommandController(ctx, agents, '/default', policies)

    const created = await controller.create({
      workspaceId: 'ws-1' as WorkspaceId,
      operation: {
        operationId: opId('op-1'),
        kind: 'new',
        policyId: '@nodes/dsh-plugin:conversation',
        reuseBlank: false,
      },
    })
    await ctx.fiber.dispose()
    expect(created.sessionId).toBe('created')
    expect(calls).toEqual(['begin:op-1', 'prepare:created', 'finish:created'])
  })

  it('reuses a candidate only for the selected policy and never crosses modes', async () => {
    const ctx = await bench()
    const policies = new SessionCreationPolicyRegistry()
    const nodesCalls: string[] = []
    policies.register(policy('@nodes/dsh-plugin:conversation', ['nodes-blank'], nodesCalls))
    policies.register(policy('@other/plugin', ['other-blank']))
    const requested: Array<string | undefined> = []
    const agents = agentsOf(ctx, (request) => {
      requested.push(request.sessionId)
      return publishedSession(ctx, request.sessionId ?? SessionId('fresh'))(request)
    })
    const controller = new SessionCommandController(ctx, agents, '/default', policies)

    await controller.create({
      workspaceId: 'ws-1' as WorkspaceId,
      sessionId: SessionId('other-blank'),
      operation: { operationId: opId('op-1'), kind: 'new', policyId: '@nodes/dsh-plugin:conversation' },
    })
    await controller.create({
      workspaceId: 'ws-1' as WorkspaceId,
      sessionId: SessionId('nodes-blank'),
      operation: { operationId: opId('op-2'), kind: 'new', policyId: '@nodes/dsh-plugin:conversation' },
    })
    await ctx.fiber.dispose()
    // Another policy's blank is not reused; the selected policy's own is.
    expect(requested).toEqual([undefined, 'nodes-blank'])
  })

  it('refuses an explicitly selected source that several policies claim', async () => {
    const ctx = await bench()
    const policies = new SessionCreationPolicyRegistry()
    const calls: string[] = []
    policies.register(policy('@nodes/dsh-plugin:conversation', ['shared-source'], calls))
    policies.register(policy('@other/plugin', ['shared-source']))
    const controller = new SessionCommandController(
      ctx,
      agentsOf(ctx, request => publishedSession(ctx, SessionId('created'))(request)),
      '/default',
      policies,
    )

    await expect(controller.create({
      workspaceId: 'ws-1' as WorkspaceId,
      operation: {
        operationId: opId('op-1'),
        kind: 'workspace',
        policyId: '@nodes/dsh-plugin:conversation',
        sourceSessionId: SessionId('shared-source'),
      },
    })).rejects.toMatchObject({ code: 'session/policy-conflict' })
    await ctx.fiber.dispose()
    expect(calls).toEqual([])
  })

  it('does not reuse a candidate that several policies claim', async () => {
    const ctx = await bench()
    const policies = new SessionCreationPolicyRegistry()
    const candidates: Array<string | undefined> = []
    const calls: string[] = []
    const selected = policy('@nodes/dsh-plugin:conversation', ['shared-blank'], calls)
    policies.register({
      ...selected,
      beginOperation: (operation) => {
        calls.push(`begin:${operation.operationId}`)
        candidates.push(operation.candidateSessionId)
        return Promise.resolve({})
      },
    })
    policies.register(policy('@other/plugin', ['shared-blank']))
    const controller = new SessionCommandController(
      ctx,
      agentsOf(ctx, request => publishedSession(ctx, SessionId('created'))(request)),
      '/default',
      policies,
    )

    await expect(controller.create({
      workspaceId: 'ws-1' as WorkspaceId,
      sessionId: SessionId('shared-blank'),
      operation: { operationId: opId('op-1'), kind: 'new', policyId: '@nodes/dsh-plugin:conversation' },
    })).resolves.toMatchObject({ sessionId: 'created' })
    await ctx.fiber.dispose()
    expect(calls).toEqual(['begin:op-1'])
    expect(candidates).toEqual([undefined])
  })

  it('keeps a definite claim when another policy cannot classify the same candidate', async () => {
    const ctx = await bench()
    const policies = new SessionCreationPolicyRegistry()
    const calls: string[] = []
    const candidates: Array<string | undefined> = []
    const selected = policy('@nodes/dsh-plugin:conversation', ['shared-blank'], calls)
    policies.register({
      ...selected,
      beginOperation: (operation) => {
        calls.push(`begin:${operation.operationId}`)
        candidates.push(operation.candidateSessionId)
        return Promise.resolve({})
      },
    })
    policies.register({
      id: '@other/plugin',
      inspectSession: () => Promise.reject(new Error('storage down')),
    })
    const requested: Array<string | undefined> = []
    const controller = new SessionCommandController(
      ctx,
      agentsOf(ctx, (request) => {
        requested.push(request.sessionId)
        return publishedSession(ctx, request.sessionId ?? SessionId('created'))(request)
      }),
      '/default',
      policies,
    )

    await expect(controller.create({
      workspaceId: 'ws-1' as WorkspaceId,
      sessionId: SessionId('shared-blank'),
      operation: { operationId: opId('op-1'), kind: 'new', policyId: '@nodes/dsh-plugin:conversation' },
    })).resolves.toMatchObject({ sessionId: 'shared-blank' })
    await ctx.fiber.dispose()
    // The selected policy's claim is definite, so its own candidate is reused
    // even while another policy reports that it cannot tell.
    expect(requested).toEqual(['shared-blank'])
    expect(candidates).toEqual(['shared-blank'])
    expect(calls).toEqual(['begin:op-1'])
  })

  it('continues a source one policy claims while another cannot classify it', async () => {
    const ctx = await bench()
    const policies = new SessionCreationPolicyRegistry()
    const calls: string[] = []
    policies.register(policy('@nodes/dsh-plugin:conversation', ['source'], calls))
    policies.register({
      id: '@other/plugin',
      inspectSession: () => Promise.reject(new Error('storage down')),
    })
    const controller = new SessionCommandController(
      ctx,
      agentsOf(ctx, request => publishedSession(ctx, SessionId('continued'))(request)),
      '/default',
      policies,
    )

    await expect(controller.create({
      workspaceId: 'ws-1' as WorkspaceId,
      operation: { operationId: opId('op-1'), kind: 'workspace', sourceSessionId: SessionId('source') },
    })).resolves.toMatchObject({ sessionId: 'continued' })
    await ctx.fiber.dispose()
    // A source the selected policy definitely claims is not treated as
    // unreadable because an unrelated policy cannot answer.
    expect(calls).toEqual(['begin:op-1', 'prepare:continued', 'finish:created'])
  })

  it('reports a policy begin refusal without creating a Session', async () => {
    const ctx = await bench()
    const policies = new SessionCreationPolicyRegistry()
    policies.register({
      id: '@nodes/dsh-plugin:conversation',
      beginOperation: () => Promise.reject(new Error('storage down')),
    })
    const createSession = vi.fn()
    const controller = new SessionCommandController(ctx, agentsOf(ctx, createSession), '/default', policies)

    await expect(controller.create({
      workspaceId: 'ws-1' as WorkspaceId,
      operation: { operationId: opId('op-1'), kind: 'new', policyId: '@nodes/dsh-plugin:conversation' },
    })).rejects.toMatchObject({ code: 'session/policy-begin-failed' })
    await ctx.fiber.dispose()
    expect(createSession).not.toHaveBeenCalled()
  })

  it('returns the known Session when policy preparation fails, and settles that outcome', async () => {
    const ctx = await bench()
    const policies = new SessionCreationPolicyRegistry()
    const calls: string[] = []
    policies.register({
      id: '@nodes/dsh-plugin:conversation',
      beginOperation: (operation) => {
        calls.push(`begin:${operation.operationId}`)
        return Promise.resolve({
          prepareSession: () => Promise.reject(new Error('registry write failed')),
          finishOperation: (outcome) => { calls.push(`finish:${outcome.kind}`) },
        })
      },
    })
    const controller = new SessionCommandController(
      ctx,
      agentsOf(ctx, request => publishedSession(ctx, SessionId('known'))(request)),
      '/default',
      policies,
    )

    await expect(controller.create({
      workspaceId: 'ws-1' as WorkspaceId,
      operation: { operationId: opId('op-1'), kind: 'new', policyId: '@nodes/dsh-plugin:conversation' },
    })).rejects.toMatchObject({
      code: 'session/policy-prepare-failed',
      details: { sessionId: 'known', workspaceId: 'ws-1', operationId: opId('op-1') },
    })
    await ctx.fiber.dispose()
    expect(calls).toEqual(['begin:op-1', 'finish:failed'])
  })
})

describe('activation generation', () => {
  it('does not run a queued operation through a same-object re-registration', async () => {
    const ctx = await bench()
    const policies = new SessionCreationPolicyRegistry()
    let began = 0
    const gate = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    const nodePolicy: SessionCreationPolicy = {
      id: '@nodes/dsh-plugin:conversation',
      beginOperation: async () => {
        began += 1
        if (began === 1) {
          entered.resolve(undefined)
          await gate.promise
        }
        return {}
      },
    }
    const dispose = policies.register(nodePolicy)
    const controller = new SessionCommandController(
      ctx,
      agentsOf(ctx, request => publishedSession(ctx, SessionId('created'))(request)),
      '/default',
      policies,
    )
    const slow = controller.create({
      workspaceId: 'ws-1' as WorkspaceId,
      operation: { operationId: opId('op-slow'), kind: 'new', policyId: nodePolicy.id },
    })
    const queued = controller.create({
      workspaceId: 'ws-1' as WorkspaceId,
      operation: { operationId: opId('op-queued'), kind: 'new', policyId: nodePolicy.id },
    })
    // Attach early so the expected rejection is not reported as unhandled.
    void queued.catch(() => {})
    await entered.promise

    // Withdraw and re-register the exact same policy object while the slow
    // operation owns the serial scope; the second activation is new.
    dispose()
    policies.register(nodePolicy)
    gate.resolve(undefined)

    await expect(slow).resolves.toMatchObject({ sessionId: 'created' })
    await expect(queued).rejects.toMatchObject({ code: 'session/policy-unavailable' })
    await ctx.fiber.dispose()
    expect(began).toBe(1)
  })

  it('does not run a queued operation through a new object with the same id', async () => {
    const ctx = await bench()
    const policies = new SessionCreationPolicyRegistry()
    const gate = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    const calls: string[] = []
    const dispose = policies.register({
      id: '@nodes/dsh-plugin:conversation',
      beginOperation: async () => {
        calls.push('old')
        entered.resolve(undefined)
        await gate.promise
        return {}
      },
    })
    const controller = new SessionCommandController(
      ctx,
      agentsOf(ctx, request => publishedSession(ctx, SessionId('created'))(request)),
      '/default',
      policies,
    )
    const slow = controller.create({
      workspaceId: 'ws-1' as WorkspaceId,
      operation: { operationId: opId('op-slow'), kind: 'new', policyId: '@nodes/dsh-plugin:conversation' },
    })
    const queued = controller.create({
      workspaceId: 'ws-1' as WorkspaceId,
      operation: { operationId: opId('op-queued'), kind: 'new', policyId: '@nodes/dsh-plugin:conversation' },
    })
    void queued.catch(() => {})
    await entered.promise

    dispose()
    policies.register(policy('@nodes/dsh-plugin:conversation', [], calls))
    gate.resolve(undefined)

    await expect(slow).resolves.toMatchObject({ sessionId: 'created' })
    await expect(queued).rejects.toMatchObject({ code: 'session/policy-unavailable' })
    await ctx.fiber.dispose()
    expect(calls).toEqual(['old'])
  })

  it('stops selection when the activation is withdrawn during the ownership read', async () => {
    const ctx = await bench()
    const policies = new SessionCreationPolicyRegistry()
    const inspectGate = Promise.withResolvers<'claimed'>()
    let inspectStarted = false
    const dispose = policies.register({
      id: '@nodes/dsh-plugin:conversation',
      inspectSession: () => {
        inspectStarted = true
        return inspectGate.promise
      },
    })
    const nextCalls: string[] = []
    const controller = new SessionCommandController(
      ctx,
      agentsOf(ctx, request => publishedSession(ctx, SessionId('created'))(request)),
      '/default',
      policies,
    )
    const opening = controller.create({
      workspaceId: 'ws-1' as WorkspaceId,
      sessionId: SessionId('source'),
      operation: {
        operationId: opId('op-1'),
        kind: 'workspace',
        policyId: '@nodes/dsh-plugin:conversation',
        sourceSessionId: SessionId('source'),
      },
    })
    await vi.waitFor(() => { expect(inspectStarted).toBe(true) })
    dispose()
    policies.register({
      id: '@nodes/dsh-plugin:conversation',
      inspectSession: () => Promise.resolve('claimed'),
      beginOperation: () => {
        nextCalls.push('new-activation')
        return Promise.resolve({})
      },
    })
    inspectGate.resolve('claimed')

    await expect(opening).rejects.toMatchObject({ code: 'session/policy-unavailable' })
    await ctx.fiber.dispose()
    expect(nextCalls).toEqual([])
  })
})

describe('operation de-duplication', () => {
  it('joins the in-flight identity established before the ownership read', async () => {
    const ctx = await bench()
    const policies = new SessionCreationPolicyRegistry()
    const gate = Promise.withResolvers<undefined>()
    const began: string[] = []
    policies.register({
      id: '@nodes/dsh-plugin:conversation',
      inspectSession: async (sessionId) => {
        if (sessionId === 'source') await gate.promise
        return sessionId === 'source' ? 'claimed' : 'unclaimed'
      },
      beginOperation: (operation) => {
        began.push(operation.operationId)
        return Promise.resolve({})
      },
    })
    const createSession = vi.fn((request: ApiSessionCreateRequest) =>
      publishedSession(ctx, SessionId('created'))(request))
    const controller = new SessionCommandController(ctx, agentsOf(ctx, createSession), '/default', policies)
    const request = {
      workspaceId: 'ws-1' as WorkspaceId,
      operation: { operationId: opId('op-1'), kind: 'workspace' as const, sourceSessionId: SessionId('source') },
    }
    const [first, second] = [controller.create(request), controller.create(request)]
    gate.resolve(undefined)
    const [left, right] = await Promise.all([first, second])
    await ctx.fiber.dispose()
    expect(left).toEqual(right)
    expect(createSession).toHaveBeenCalledOnce()
    expect(began).toEqual(['op-1'])
  })

  it('never evicts an unsettled operation and keeps its replay identity beyond the cache bound', async () => {
    const ctx = await bench()
    const policies = new SessionCreationPolicyRegistry()
    const block = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    policies.register({
      id: '@nodes/dsh-plugin:conversation',
      beginOperation: async (operation) => {
        if (operation.operationId === 'op-block') {
          entered.resolve(undefined)
          await block.promise
        }
        return {}
      },
    })
    let minted = 0
    const createSession = vi.fn((request: ApiSessionCreateRequest) =>
      publishedSession(ctx, SessionId(`s${++minted}`))(request))
    const controller = new SessionCommandController(ctx, agentsOf(ctx, createSession), '/default', policies)

    const blocker = controller.create({
      workspaceId: 'ws-1' as WorkspaceId,
      operation: { operationId: opId('op-block'), kind: 'new', policyId: '@nodes/dsh-plugin:conversation' },
    })
    await entered.promise
    const requests = Array.from({ length: 130 }, (_, index) => ({
      workspaceId: 'ws-1' as WorkspaceId,
      operation: {
        operationId: opId(`op-${index}`),
        kind: 'new' as const,
        policyId: '@nodes/dsh-plugin:conversation',
      },
    }))
    const queued = requests.map(request => controller.create(request))
    await vi.waitFor(() => { expect(createSession).not.toHaveBeenCalled() })
    // Replaying the first queued identity while it is still unsettled joins
    // that attempt rather than queueing another one.
    const replayed = controller.create(requests[0]!)
    block.resolve(undefined)
    const results = await Promise.all([blocker, ...queued, replayed])
    expect(createSession).toHaveBeenCalledTimes(131)
    expect(results.at(-1)).toEqual(results[1])
    // The settled identity stays replayable after the cache exceeded its bound.
    await expect(controller.create(requests[0]!)).resolves.toEqual(results[1])
    // A further independent identity now evicts the oldest settled entries; an
    // evicted identity is a new attempt rather than a replayed result.
    const later = await controller.create({
      workspaceId: 'ws-1' as WorkspaceId,
      operation: { operationId: opId('op-late'), kind: 'new', policyId: '@nodes/dsh-plugin:conversation' },
    })
    expect(createSession).toHaveBeenCalledTimes(132)
    const retried = await controller.create(requests[0]!)
    expect(createSession).toHaveBeenCalledTimes(133)
    expect(retried.sessionId).not.toEqual(results[1].sessionId)
    expect(later.sessionId).toBe('s132')
    await ctx.fiber.dispose()
  })
})

describe('operation identity and continuation', () => {
  it('replays one operation identity once and retries only a proven pre-create refusal', async () => {
    const ctx = await bench()
    const policies = new SessionCreationPolicyRegistry()
    const calls: string[] = []
    policies.register(policy('@nodes/dsh-plugin:conversation', ['saved'], calls))
    let attempts = 0
    const agents = agentsOf(ctx, (request) => {
      attempts += 1
      if (attempts === 1) {
        return Promise.reject(new RemoteError('agent-preset/not-found', 'unknown preset', {
          agentPreset: 'missing',
          available: ['standard'],
        }))
      }
      return publishedSession(ctx, SessionId('created'))(request)
    })
    const controller = new SessionCommandController(ctx, agents, '/default', policies)
    const operation = {
      operationId: opId('op-1'),
      kind: 'restore' as const,
      policyId: '@nodes/dsh-plugin:conversation',
      sourceSessionId: SessionId('saved'),
    } as const

    // First attempt is refused before creation; because that refusal is
    // provably pre-create, the same operation may retry and succeed.
    await expect(controller.create({
      workspaceId: 'ws-1' as WorkspaceId,
      sessionId: SessionId('saved'),
      agentPreset: 'missing',
      operation,
    })).rejects.toMatchObject({ code: 'agent-preset/not-found' })
    const retried = await controller.create({
      workspaceId: 'ws-1' as WorkspaceId,
      sessionId: SessionId('saved'),
      operation,
    })
    await expect(controller.create({
      workspaceId: 'ws-1' as WorkspaceId,
      sessionId: SessionId('saved'),
      operation,
    })).resolves.toEqual(retried)
    await ctx.fiber.dispose()
    expect(attempts).toBe(2)
    expect(calls).toEqual(['begin:op-1', 'finish:failed', 'begin:op-1', 'prepare:created', 'finish:created'])
  })

  it('resolves a continuation policy from the source Session and refuses unreadable sources', async () => {
    const ctx = await bench()
    const policies = new SessionCreationPolicyRegistry()
    const calls: string[] = []
    policies.register(policy('@nodes/dsh-plugin:conversation', ['source'], calls))
    const controller = new SessionCommandController(
      ctx,
      agentsOf(ctx, request => publishedSession(ctx, SessionId('continued'))(request)),
      '/default',
      policies,
    )

    await expect(controller.create({
      workspaceId: 'ws-1' as WorkspaceId,
      operation: { operationId: opId('op-1'), kind: 'workspace', sourceSessionId: SessionId('source') },
    })).resolves.toMatchObject({ sessionId: 'continued' })

    await expect(controller.create({
      workspaceId: 'ws-1' as WorkspaceId,
      operation: { operationId: opId('op-2'), kind: 'workspace', sourceSessionId: SessionId('source'), policyId: '@other/plugin' },
    })).rejects.toMatchObject({ code: 'session/policy-unavailable' })

    const unreadable = new SessionCreationPolicyRegistry()
    unreadable.register({ id: '@nodes/dsh-plugin:conversation', inspectSession: () => Promise.reject(new Error('down')) })
    const second = await bench()
    const next = new SessionCommandController(
      second,
      agentsOf(second, request => publishedSession(second, SessionId('fresh'))(request)),
      '/default',
      unreadable,
    )
    await expect(next.create({
      workspaceId: 'ws-1' as WorkspaceId,
      operation: { operationId: opId('op-3'), kind: 'workspace', sourceSessionId: SessionId('source') },
    })).rejects.toMatchObject({ code: 'session/policy-source-unknown' })
    await second.fiber.dispose()
    await ctx.fiber.dispose()
    expect(calls).toEqual(['begin:op-1', 'prepare:continued', 'finish:created'])
  })
})

describe('failed creation settlement', () => {
  it('reports a workspace attach failure as a known Session and never retries it', async () => {
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- exercising the non-Error diagnostic path
    const attach = vi.fn(() => Promise.reject('workspace is read-only'))
    const ctx = await bench({ attachSession: attach })
    const policies = new SessionCreationPolicyRegistry()
    const outcomes: SessionCreationOutcome[] = []
    policies.register({
      id: '@nodes/dsh-plugin:conversation',
      beginOperation: () => Promise.resolve({
        finishOperation: (outcome) => {
          outcomes.push(outcome)
          throw new Error('settlement store down')
        },
      }),
    })
    const createSession = vi.fn((request: ApiSessionCreateRequest) =>
      publishedSession(ctx, SessionId('created'))(request))
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const controller = new SessionCommandController(ctx, agentsOf(ctx, createSession), '/default', policies)
    const request = {
      workspaceId: 'ws-1' as WorkspaceId,
      operation: {
        operationId: opId('op-attach'),
        kind: 'new' as const,
        policyId: '@nodes/dsh-plugin:conversation',
      },
    }

    await expect(controller.create(request)).rejects.toMatchObject({
      code: 'session/workspace-attach-failed',
      details: { sessionId: 'created', workspaceId: 'ws-1' },
    })
    // The refused attach left a real Session: replaying the identity returns
    // the same failure instead of creating and attaching a second one.
    await expect(controller.create(request)).rejects.toMatchObject({ code: 'session/workspace-attach-failed' })
    expect(createSession).toHaveBeenCalledOnce()
    expect(attach).toHaveBeenCalledOnce()
    expect(outcomes).toEqual([{
      kind: 'failed',
      stage: 'create',
      creation: 'known',
      message: 'workspace is read-only',
      sessionId: 'created',
      workspaceId: 'ws-1',
    }])
    // A participant that rejects settlement is a diagnostic, not a second failure.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('did not settle failed operation'))
    await ctx.fiber.dispose()
  })

  it.each([
    { label: 'raw Error', failure: () => new Error('factory unavailable') },
    { label: 'typed gateway/internal', failure: () => new RemoteError('gateway/internal', 'mount failed', {}) },
  ])('classifies a $label creation failure as unknown and does not retry it', async ({ failure }) => {
    const ctx = await bench()
    const policies = new SessionCreationPolicyRegistry()
    const outcomes: SessionCreationOutcome[] = []
    policies.register({
      id: '@nodes/dsh-plugin:conversation',
      beginOperation: () => Promise.resolve({
        finishOperation: (outcome) => { outcomes.push(outcome) },
      }),
    })
    const createSession = vi.fn(() => Promise.reject(failure()))
    const controller = new SessionCommandController(ctx, agentsOf(ctx, createSession), '/default', policies)
    const request = {
      workspaceId: 'ws-1' as WorkspaceId,
      operation: {
        operationId: opId('op-create-failure'),
        kind: 'new' as const,
        policyId: '@nodes/dsh-plugin:conversation',
      },
    }

    await expect(controller.create(request)).rejects.toMatchObject({ code: 'gateway/internal' })
    await expect(controller.create(request)).rejects.toMatchObject({ code: 'gateway/internal' })
    expect(createSession).toHaveBeenCalledOnce()
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({ kind: 'failed', stage: 'create', creation: 'unknown' })
    expect(outcomes[0]).not.toHaveProperty('sessionId')
    await ctx.fiber.dispose()
  })

  it('settles a pre-create preset conflict as none and allows the same operation to retry', async () => {
    const candidate = SessionId('nodes-blank')
    const ctx = await bench({ sessionIds: [candidate] })
    const policies = new SessionCreationPolicyRegistry()
    const outcomes: SessionCreationOutcome[] = []
    let begins = 0
    policies.register({
      id: '@nodes/dsh-plugin:conversation',
      inspectSession: () => Promise.resolve('claimed'),
      beginOperation: () => {
        begins += 1
        return {
          finishOperation: (outcome) => { outcomes.push(outcome) },
        }
      },
    })
    const session = ctx.sessions.create(candidate, { meta: { cwd: '/workspace' } })
    await ctx.agents.register({ id: candidate, session, status: 'idle', ctx } as Agent)
    const createSession = vi.spyOn(ctx.agents, 'create')
    const controller = new SessionCommandController(ctx, agentsOf(ctx), '/default', policies)
    const request = {
      workspaceId: 'ws-1' as WorkspaceId,
      sessionId: candidate,
      agentPreset: 'named',
      operation: {
        operationId: opId('op-preset'),
        kind: 'new' as const,
        policyId: '@nodes/dsh-plugin:conversation',
      },
    }

    // Reusing a blank Session under a named preset needs a roster; the refusal
    // happens before the Controller creates anything.
    await expect(controller.create(request)).rejects.toMatchObject({ code: 'agent-preset/conflict' })
    await expect(controller.create(request)).rejects.toMatchObject({ code: 'agent-preset/conflict' })
    expect(begins).toBe(2)
    expect(createSession).not.toHaveBeenCalled()
    expect(ctx.sessions.get(candidate)).toBe(session)
    // Both attempts settle the operation as creating nothing, so a replay is
    // allowed to retry instead of being cached as an unknown outcome.
    expect(outcomes).toHaveLength(2)
    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({ kind: 'failed', stage: 'create', creation: 'none' })
      if (outcome.kind !== 'failed') throw new Error('expected a failed creation outcome')
      expect(outcome.message).toContain('cannot run preset')
    }
    await ctx.fiber.dispose()
  })
})

describe('operated ordinary creation', () => {
  it('reuses an unclaimed blank candidate and reports the preset it already runs', async () => {
    const candidate = SessionId('blank')
    const ctx = await bench({ sessionIds: [candidate] })
    const presets = await ctx.sessionProjections.register(agentPresetProjectionDefinition)
    // The Controller reports the preset recorded on the reused Session, read
    // through the roster's projection accessor.
    ctx.provide('agentPresets', {
      presetForSession: (session: Session) => presets.stateOf(session),
    } as never)
    const session = ctx.sessions.create(candidate, {
      meta: { cwd: '/workspace', agentPreset: 'minimal' },
    })
    await ctx.agents.register({ id: candidate, session, status: 'idle', ctx } as Agent)
    const create = vi.spyOn(ctx.agents, 'create')
    const controller = new SessionCommandController(
      ctx,
      agentsOf(ctx),
      '/default',
      new SessionCreationPolicyRegistry(),
    )

    const reused = await controller.create({
      workspaceId: 'ws-1' as WorkspaceId,
      sessionId: candidate,
      operation: { operationId: opId('op-reuse'), kind: 'new' },
    })

    expect(reused).toEqual({ sessionId: candidate, agentPreset: 'minimal' })
    expect(create).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it.each([
    { label: 'archived', archived: true, member: true },
    { label: 'outside the Workspace', archived: false, member: false },
  ])('creates a fresh Session when the unclaimed blank candidate is $label', async ({ archived, member }) => {
    const candidate = SessionId('placement-blank')
    const ctx = await bench(
      { sessionIds: member ? [candidate] : [] },
      { archivedSessionIds: archived ? [candidate] : [] },
    )
    const session = ctx.sessions.create(candidate, { meta: { cwd: '/workspace' } })
    await ctx.agents.register({ id: candidate, session, status: 'idle', ctx } as Agent)
    const create = installCreateSession(ctx)
    const controller = new SessionCommandController(
      ctx,
      agentsOf(ctx),
      '/default',
      new SessionCreationPolicyRegistry(),
    )

    const created = await controller.create({
      workspaceId: 'ws-1' as WorkspaceId,
      sessionId: candidate,
      operation: {
        operationId: opId(archived ? 'op-archived' : 'op-outside'),
        kind: 'new',
      },
    })

    expect(created.sessionId).not.toBe(candidate)
    expect(create).toHaveBeenCalledOnce()
    // The placement refusal only skips reuse; the caller's blank is untouched.
    expect(ctx.sessions.get(candidate)).toBe(session)
    await ctx.fiber.dispose()
  })
})

describe('source continuation ownership', () => {
  it('classifies an explicitly selected source by the aggregate ownership answer', async () => {
    const ctx = await bench()
    const policies = new SessionCreationPolicyRegistry()
    policies.register(policy('@nodes/dsh-plugin:conversation', []))
    policies.register(policy('@other/plugin', ['other-source']))
    const createSession = vi.fn()
    const controller = new SessionCommandController(ctx, agentsOf(ctx, createSession), '/default', policies)

    // Owned by another policy: the selected policy cannot continue it.
    await expect(controller.create({
      workspaceId: 'ws-1' as WorkspaceId,
      operation: {
        operationId: opId('op-other'),
        kind: 'workspace',
        policyId: '@nodes/dsh-plugin:conversation',
        sourceSessionId: SessionId('other-source'),
      },
    })).rejects.toMatchObject({
      code: 'session/source-not-policy',
      details: { policyId: '@nodes/dsh-plugin:conversation', sessionId: 'other-source' },
    })
    // Claimed by no policy: still not a source of the selected policy.
    await expect(controller.create({
      workspaceId: 'ws-1' as WorkspaceId,
      operation: {
        operationId: opId('op-unclaimed'),
        kind: 'workspace',
        policyId: '@nodes/dsh-plugin:conversation',
        sourceSessionId: SessionId('unclaimed-source'),
      },
    })).rejects.toMatchObject({ code: 'session/source-not-policy' })

    const unreadable = await bench()
    const errors = new SessionCreationPolicyRegistry()
    errors.register({
      id: '@nodes/dsh-plugin:conversation',
      inspectSession: () => Promise.reject(new Error('storage down')),
    })
    const secondCreate = vi.fn()
    const second = new SessionCommandController(
      unreadable,
      agentsOf(unreadable, secondCreate),
      '/default',
      errors,
    )
    await expect(second.create({
      workspaceId: 'ws-1' as WorkspaceId,
      operation: {
        operationId: opId('op-unknown'),
        kind: 'workspace',
        policyId: '@nodes/dsh-plugin:conversation',
        sourceSessionId: SessionId('source'),
      },
    })).rejects.toMatchObject({ code: 'session/policy-source-unknown' })

    expect(createSession).not.toHaveBeenCalled()
    expect(secondCreate).not.toHaveBeenCalled()
    await unreadable.fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('continues an unclaimed source ordinarily and refuses a source several policies claim', async () => {
    const ctx = await bench()
    const policies = new SessionCreationPolicyRegistry()
    policies.register(policy('@nodes/dsh-plugin:conversation', ['owned-source']))
    const createSession = vi.fn((request: ApiSessionCreateRequest) =>
      publishedSession(ctx, request.sessionId ?? SessionId('continued'))(request))
    const controller = new SessionCommandController(ctx, agentsOf(ctx, createSession), '/default', policies)

    await expect(controller.create({
      workspaceId: 'ws-1' as WorkspaceId,
      operation: { operationId: opId('op-free'), kind: 'workspace', sourceSessionId: SessionId('free-source') },
    })).resolves.toMatchObject({ sessionId: 'continued' })

    policies.register(policy('@other/plugin', ['shared-source']))
    policies.register(policy('@third/plugin', ['shared-source']))
    await expect(controller.create({
      workspaceId: 'ws-1' as WorkspaceId,
      operation: { operationId: opId('op-conflict'), kind: 'workspace', sourceSessionId: SessionId('shared-source') },
    })).rejects.toMatchObject({ code: 'session/policy-conflict' })

    await ctx.fiber.dispose()
  })

  it('refuses an implicit source when its claiming registration is withdrawn during the read', async () => {
    const ctx = await bench()
    const policies = new SessionCreationPolicyRegistry()
    const gate = Promise.withResolvers<'claimed'>()
    let started = false
    const dispose = policies.register({
      id: '@nodes/dsh-plugin:conversation',
      inspectSession: () => {
        started = true
        return gate.promise
      },
    })
    const createSession = vi.fn()
    const controller = new SessionCommandController(ctx, agentsOf(ctx, createSession), '/default', policies)

    const opening = controller.create({
      workspaceId: 'ws-1' as WorkspaceId,
      operation: {
        operationId: opId('op-withdrawn-source'),
        kind: 'workspace',
        sourceSessionId: SessionId('source'),
      },
    })
    await vi.waitFor(() => { expect(started).toBe(true) })
    dispose()
    gate.resolve('claimed')

    await expect(opening).rejects.toMatchObject({ code: 'session/policy-source-unknown' })
    expect(createSession).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('refuses a named operation when its candidate read outlives the registration', async () => {
    const ctx = await bench()
    const policies = new SessionCreationPolicyRegistry()
    const gate = Promise.withResolvers<'claimed'>()
    let started = false
    const dispose = policies.register({
      id: '@nodes/dsh-plugin:conversation',
      inspectSession: () => {
        started = true
        return gate.promise
      },
    })
    const createSession = vi.fn()
    const controller = new SessionCommandController(ctx, agentsOf(ctx, createSession), '/default', policies)

    const opening = controller.create({
      workspaceId: 'ws-1' as WorkspaceId,
      sessionId: SessionId('candidate'),
      operation: {
        operationId: opId('op-withdrawn-candidate'),
        kind: 'new',
        policyId: '@nodes/dsh-plugin:conversation',
      },
    })
    await vi.waitFor(() => { expect(started).toBe(true) })
    dispose()
    gate.resolve('claimed')

    await expect(opening).rejects.toMatchObject({ code: 'session/policy-unavailable' })
    expect(createSession).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })
})

/** Policy id the real composition registers through the Controller ledger. */
const REAL_POLICY = '@test/real-creation-policy'
/** Second policy id used to prove a named intent never reuses another policy's blank. */
const REAL_OTHER_POLICY = '@test/other-creation-policy'
/** Policy that owns the blank Session reused across a Host restart. */
const REAL_WORKSPACE_POLICY = '@test/nodes-creation-policy'

/** Claim ledger a real policy persists outside the Host process. */
interface ClaimLedger {
  readonly [policyId: string]: readonly string[]
}

/** One prepared creation this policy recorded, in Host order. */
interface PreparedCreation {
  readonly sessionId: SessionId
  readonly reused: boolean
}

/** Read the durable claim ledger, treating an absent file as no claim. */
function readClaims(path: string): ClaimLedger {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as ClaimLedger : {}
}

/** Replace the durable claim ledger. */
function writeClaims(path: string, ledger: ClaimLedger): void {
  writeFileSync(path, JSON.stringify(ledger))
}

/**
 * A policy whose ownership answer is read from a file, standing in for the
 * registering plugin's own durable application.
 * @param claimsPath - durable claim ledger path shared by both Host processes.
 * @param policyId - identity this policy answers for.
 * @returns the policy handed to the Controller ledger and the creations it prepared.
 */
function durablePolicy(
  claimsPath: string,
  policyId: string,
): SessionCreationPolicy & { readonly prepared: PreparedCreation[] } {
  const prepared: PreparedCreation[] = []
  const policy: SessionCreationPolicy & { readonly prepared: PreparedCreation[] } = {
    id: policyId,
    prepared,
    inspectSession: (sessionId): SessionCreationOwnership =>
      (readClaims(claimsPath)[policyId] ?? []).includes(sessionId) ? 'claimed' : 'unclaimed',
    beginOperation: () => ({
      prepareSession: ({ sessionId, reused }) => {
        const ledger = readClaims(claimsPath)
        writeClaims(claimsPath, { ...ledger, [policyId]: [...ledger[policyId] ?? [], sessionId] })
        prepared.push({ sessionId, reused })
      },
    }),
  }
  return policy
}

/** Session lifecycle factory: enters, announces, runs setup, and registers a live Agent. */
function realAgentFactory(ctx: Context): AgentFactory {
  const publish = async (session: Session, setup?: AgentSetup) => {
    const agent = { id: session.id, session, status: 'idle' } as Agent
    // Preset revisions bind through the Agent scope, so every Agent gets one.
    const scope = createScope(ctx, {})
    ;(agent as { ctx?: Context }).ctx = scope.ctx
    const detach = ctx.effect(() => ctx.sessions.enter(session))
    try {
      ctx.sessions.announce(session)
      const commit = await setup?.(scope.ctx, agent)
      commit?.commit()
      const unregister = await ctx.agents.register(agent)
      return { agent, dispose: async () => { await unregister(); await detach() } }
    } catch (error) {
      await detach()
      throw error
    }
  }
  return {
    async createAgent(_ownerCtx, create) {
      const session = ctx.sessions.prepare(create.sessionId, create.meta === undefined ? {} : { meta: create.meta })
      return publish(session, create.setup)
    },
    async resume(_ownerCtx, resume) {
      using observation = await ctx.sessionQuery.observeSession(resume.resumeSessionId)
      const session = ctx.sessions.prepare(resume.resumeSessionId, {
        meta: observation.header,
        seed: [...observation.events],
      })
      return await publish(session, resume.setup)
    },
  }
}

/** One Host process over a durable root: real storage, real Workspace registry, real JSONL persistence. */
interface RealHost {
  readonly ctx: Context
  readonly controller: SessionController
  readonly workspacePath: string
  readonly workspaceId: WorkspaceId
  readonly claimsPath: string
}

/**
 * Boot one Host process over `root`, reusing the durable Workspace records and
 * Session logs a previous process wrote.
 * @param root - durable root holding workspace storage and Session logs.
 * @param workspacePath - project directory of the Workspace entity.
 * @param claimsPath - durable claim ledger shared with the registering plugin.
 * @returns the booted Host and the durable Workspace it sees.
 */
async function bootRealHost(root: string, workspacePath: string, claimsPath: string): Promise<RealHost> {
  const ctx = new Context()
  realContexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'storage') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'logs'), compression: 'none' })
  await ctx.plugin(WorkspaceRegistry)
  ctx.agents.setFactory(realAgentFactory(ctx))
  const controller = await createSessionTestController(ctx, {
    defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
    cwd: workspacePath,
  })
  const workspace = ctx.workspaceRegistry.list()[0] ?? await ctx.workspaceRegistry.create(workspacePath)
  return { ctx, controller, workspacePath, workspaceId: workspace.id, claimsPath }
}

/** Register one policy for one contributing fiber's lifetime. */
async function mountPolicy(host: RealHost, policy: SessionCreationPolicy) {
  return await host.ctx.plugin({
    name: `test:${policy.id}`,
    apply: (inner: Context) => {
      // The real ledger removes the registration with the fiber that contributed it.
      inner.effect(() => host.controller.creationPolicies.register(policy), `test: ${policy.id}`)
    },
  })
}

/** Write one blank Session log durably and attach it to the Workspace. */
async function storeBlank(host: RealHost, sessionId: SessionId): Promise<void> {
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: Date.now(),
    cwd: host.workspacePath,
    isSeeded: false,
  }
  const handle = await host.ctx.sessionPersistence.create(header)
  await handle.flush()
  await handle.close()
  const workspace = host.ctx.workspaceRegistry.get(host.workspaceId)
  if (workspace === undefined) throw new Error('Workspace disappeared before attach')
  await workspace.attachSession(sessionId)
}

/** Boot one Host over a fresh durable root and create its Workspace. */
async function realFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-creation-policy-real-')))
  tempDirs.push(root)
  const workspacePath = join(root, 'project')
  mkdirSync(workspacePath, { recursive: true })
  const claimsPath = join(root, 'claims.json')
  const host = await bootRealHost(root, workspacePath, claimsPath)
  return { host, root, workspacePath, claimsPath }
}

describe('real Controller, loader activation, and Workspace', () => {
  it('drops a policy with its fiber and refuses a queued operation after a same-id remount', async () => {
    const { host } = await realFixture()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let firstBegins = 0
    let remountBegins = 0
    const first: SessionCreationPolicy = {
      id: REAL_POLICY,
      beginOperation: async () => {
        firstBegins += 1
        entered.resolve(undefined)
        await release.promise
        return {}
      },
    }
    const fiber = await mountPolicy(host, first)
    expect(host.controller.creationPolicies.get(REAL_POLICY)).toBe(first)

    const slow = host.controller.create({
      workspaceId: host.workspaceId,
      operation: { operationId: opId('op-slow'), kind: 'new', policyId: REAL_POLICY },
    })
    const queued = host.controller.create({
      workspaceId: host.workspaceId,
      operation: { operationId: opId('op-queued'), kind: 'new', policyId: REAL_POLICY },
    })
    void queued.catch(() => {})
    await entered.promise

    // Withdraw the activation and remount the same policy id on another fiber
    // while the queued operation waits for the serial scope.
    await fiber.dispose()
    expect(host.controller.creationPolicies.get(REAL_POLICY)).toBeUndefined()
    await mountPolicy(host, {
      id: REAL_POLICY,
      beginOperation: () => {
        remountBegins += 1
        return {}
      },
    })
    release.resolve(undefined)

    const settled = await slow
    await expect(queued).rejects.toMatchObject({ code: 'session/policy-unavailable' })
    // The remounted activation never received the queued call.
    expect(firstBegins).toBe(1)
    expect(remountBegins).toBe(0)
    expect(host.ctx.sessions.get(settled.sessionId)).toBeDefined()

    // A later delivery enters the live activation and creates another Session.
    const later = await host.controller.create({
      workspaceId: host.workspaceId,
      operation: { operationId: opId('op-later'), kind: 'new', policyId: REAL_POLICY },
    })
    expect(later.sessionId).not.toBe(settled.sessionId)
    expect(remountBegins).toBe(1)
  })

  it('keeps the reuse gate in both directions across a cold Host restart', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-creation-policy-cold-')))
    tempDirs.push(root)
    const workspacePath = join(root, 'project')
    mkdirSync(workspacePath, { recursive: true })
    const claimsPath = join(root, 'claims.json')

    const first = await bootRealHost(root, workspacePath, claimsPath)
    await storeBlank(first, SessionId('nodes-blank'))
    await storeBlank(first, SessionId('other-blank'))
    await storeBlank(first, SessionId('free-blank'))
    writeClaims(claimsPath, {
      [REAL_WORKSPACE_POLICY]: [SessionId('nodes-blank')],
      [REAL_OTHER_POLICY]: [SessionId('other-blank')],
    })
    const workspaceId = first.workspaceId
    // The first process ends; only its durable Workspace records, Session logs,
    // and the registering plugin's own claim ledger remain.
    await first.ctx.fiber.dispose()

    const second = await bootRealHost(root, workspacePath, claimsPath)
    expect(second.workspaceId).toBe(workspaceId)
    const policy = durablePolicy(claimsPath, REAL_WORKSPACE_POLICY)
    await mountPolicy(second, policy)
    await mountPolicy(second, durablePolicy(claimsPath, REAL_OTHER_POLICY))
    // Real durable membership survived the restart.
    expect(second.ctx.workspaceRegistry.get(workspaceId)?.sessionIds)
      .toEqual(expect.arrayContaining([
        SessionId('nodes-blank'),
        SessionId('other-blank'),
        SessionId('free-blank'),
      ]))

    // Ordinary intent: a claimed blank is never reused.
    const ordinary = await second.controller.create({
      workspaceId,
      sessionId: SessionId('nodes-blank'),
    })
    expect(ordinary.sessionId).not.toBe(SessionId('nodes-blank'))

    // Named intent: another policy's blank and an unclaimed blank are not reused.
    const foreign = await second.controller.create({
      workspaceId,
      sessionId: SessionId('other-blank'),
      operation: { operationId: opId('op-foreign'), kind: 'new', policyId: REAL_WORKSPACE_POLICY },
    })
    expect(foreign.sessionId).not.toBe(SessionId('other-blank'))
    const unclaimed = await second.controller.create({
      workspaceId,
      sessionId: SessionId('free-blank'),
      operation: { operationId: opId('op-unclaimed'), kind: 'new', policyId: REAL_WORKSPACE_POLICY },
    })
    expect(unclaimed.sessionId).not.toBe(SessionId('free-blank'))

    // Named intent: its own surviving blank is reused from the stored log.
    const reused = await second.controller.create({
      workspaceId,
      sessionId: SessionId('nodes-blank'),
      operation: { operationId: opId('op-reuse'), kind: 'new', policyId: REAL_WORKSPACE_POLICY },
    })
    expect(reused.sessionId).toBe(SessionId('nodes-blank'))
    expect(policy.prepared.at(-1)).toEqual({ sessionId: SessionId('nodes-blank'), reused: true })
  })

  it('reports the created identity when policy preparation fails and never creates a second Session', async () => {
    const { host } = await realFixture()
    const outcomes: SessionCreationOutcome[] = []
    await mountPolicy(host, {
      id: REAL_POLICY,
      beginOperation: () => ({
        prepareSession: () => Promise.reject(new Error('registry write failed')),
        finishOperation: (outcome) => { outcomes.push(outcome) },
      }),
    })
    const create = vi.spyOn(host.ctx.agents, 'create')
    const request = {
      workspaceId: host.workspaceId,
      operation: { operationId: opId('op-prepare'), kind: 'new' as const, policyId: REAL_POLICY },
    }

    const failure = await host.controller.create(request).then(
      () => { throw new Error('expected the preparation to fail') },
      (error: unknown) => error,
    )
    expect(failure).toMatchObject({
      code: 'session/policy-prepare-failed',
      details: { workspaceId: host.workspaceId, operationId: opId('op-prepare') },
    })
    const sessionId = (failure as { readonly details: { readonly sessionId: SessionId } }).details.sessionId
    expect(host.ctx.sessions.get(sessionId)).toBeDefined()
    expect(host.ctx.workspaceRegistry.get(host.workspaceId)?.sessionIds).toContain(sessionId)
    expect(outcomes).toEqual([{
      kind: 'failed',
      stage: 'prepare',
      creation: 'known',
      message: 'registry write failed',
      sessionId,
      workspaceId: host.workspaceId,
    }])

    // The established Session is never rebuilt: the same operation replays its
    // failure instead of creating a second Session.
    await expect(host.controller.create(request)).rejects.toMatchObject({
      code: 'session/policy-prepare-failed',
    })
    expect(create).toHaveBeenCalledOnce()
  })
})
