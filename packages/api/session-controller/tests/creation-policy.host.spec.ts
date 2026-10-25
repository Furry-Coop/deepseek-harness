/** Creation-policy coordination through the real Session command controller. */

import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionOperationId } from '../src/types.ts'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import type { Workspace, WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { describe, expect, it, vi } from 'vitest'
import {
  ApiSessionAgentController,
  type ApiSessionCreated,
  type ApiSessionCreateRequest,
} from '../src/agent.ts'
import { SessionCommandController } from '../src/commands.ts'
import {
  SessionCreationPolicyRegistry,
  type SessionCreationParticipant,
  type SessionCreationPolicy,
} from '../src/creation-policy.ts'
import { installSessionReadTestServices } from './test-remote.ts'

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
async function bench(workspace: Partial<Workspace> | undefined = {}) {
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
    archivedSessionIds: [],
  } as never)
  return ctx
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
