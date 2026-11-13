/** Session commands whose activation policy is explicit at each Remote method. */

import { modelAvailable } from './catalog.ts'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent, ModelSelection as AgentModelSelection } from '@deepseek-ai/dsh-agent'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type {
  AttachmentAdmissionPart,
} from '@deepseek-ai/dsh-attachment'
import type { FileUploadReceiptId, StagedAttachment } from '@deepseek-ai/dsh-client-file-upload/types'
import type {} from '@deepseek-ai/dsh-client-file-upload'
import {
  ReasoningEffortId, createUserMessage, freezeMessage,
} from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork'
import { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import { SessionQueryError, type SessionObservation } from '@deepseek-ai/dsh-session-query'
import { SessionTitleInvalidError } from '@deepseek-ai/dsh-session-title'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { RemoteError, remoteErrorOf, type RemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import {
  ApiSessionAgentController,
  ApiSessionCreationFailed,
  ApiSessionCwdConflict,
  ApiSessionPresetConflict,
  ApiSessionSubagentOwnership,
  apiSessionSubagentOwnershipError,
  hasApiSessionSubagentOwner,
  type ApiSessionCreated,
} from './agent.ts'
import {
  creationPolicyRuntime,
  type SessionCreationKnowledge,
  type SessionCreationOutcome,
  type SessionCreationParticipant,
  type SessionCreationPolicy,
  type SessionCreationPolicyClaim,
  type SessionCreationPolicyRegistry,
  type SessionCreationPolicyRuntime,
} from './creation-policy.ts'
import type {
  SessionAttachmentRequest,
  SessionAttachmentValue,
  SessionCancelRequest,
  SessionCancelValue,
  SessionCreateOperationContext,
  SessionCreateRequest,
  SessionCreateValue,
  SessionForkRequest,
  SessionForkValue,
  SessionPromptRequest,
  SessionPromptValue,
  SessionRenameRequest,
  SessionRenameValue,
  SessionSelectModelRequest,
  SessionSelectModelValue,
  SessionUpdateQueueRequest,
  SessionUpdateQueueValue,
  SessionRequestId,
} from './types.ts'
import type { PromptAdmissionReader } from './prompt-admission.ts'

type PromptContentCandidate =
  | SessionPromptRequest['content'][number]
  | Extract<SessionUpdateQueueRequest['action'], { readonly kind: 'edit' }>['content'][number]

/**
 * Whether prompt content carries non-whitespace text or an attachment.
 * @param content - submitted or edited prompt parts.
 * @returns false for content the Agent must not receive.
 */
export function hasPromptContent(content: readonly PromptContentCandidate[]): boolean {
  return content.some(part => part.type !== 'text' || part.text.trim().length > 0)
}

/** Key one operation identity per policy; two policies may mint the same operation id. */
function operationKey(operation: SessionCreateOperationContext): string {
  return `${operation.policyId ?? ''}\u0000${operation.operationId}`
}

/**
 * Whether a failed attempt provably created nothing, created a Session whose
 * identity the Controller holds, or left the result unknown.
 *
 * The Agent Controller records whether the attempt entered a factory call and
 * the identity that call returned; no failure code thrown by a plugin decides
 * this. Only failures this Controller raises itself are read by code.
 * @param error - the failure thrown out of the creation attempt.
 * @returns the creation knowledge the Controller holds for the attempt.
 */
function creationKnowledgeOf(error: unknown): SessionCreationKnowledge {
  if (error instanceof ApiSessionCreationFailed) {
    if (!error.enteredFactory) return 'none'
    return error.sessionId === undefined ? 'unknown' : 'known'
  }
  switch (remoteErrorOf(error)?.code) {
    case 'session/workspace-attach-failed':
    case 'session/policy-prepare-failed':
      return 'known'
    case 'gateway/bad-request':
    case 'workspace/not-found':
    case 'session/policy-unavailable':
    case 'session/source-not-policy':
    case 'session/policy-source-unknown':
    case 'session/policy-conflict':
    case 'session/policy-begin-failed':
      return 'none'
    default:
      // An unclassified failure may already have produced a Session: never
      // offer the same operation a second chance on that assumption.
      return 'unknown'
  }
}

/** Readable failure reason for policy settlement diagnostics. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The selected activation ended before its queued operation could enter it.
 * @param policyId - policy identity that was withdrawn or replaced.
 * @param operationId - queued operation identity.
 * @returns the pre-create failure the caller may safely retry under a new operation.
 */
function withdrawnPolicy(policyId: string, operationId: string): RemoteError<'session/policy-unavailable'> {
  return new RemoteError(
    'session/policy-unavailable',
    `creation policy "${policyId}" was withdrawn before operation "${operationId}" could start`,
    { policyId, operationId },
  )
}

/**
 * Resolve the omitted-`atSeq` default to the latest completed-turn prefix,
 * including standalone events before the next turn begins.
 */
function latestCompletedPrefixBoundary(events: readonly SessionEvent[]): SessionSeq | undefined {
  const lastTurnEnd = events.findLast(event => event.type === 'turn/end')
  if (lastTurnEnd === undefined) return undefined
  let boundary = lastTurnEnd.seq
  for (const next of events.slice(boundary + 1)) {
    if (next.type === 'turn/start' || (next.type === 'user/message' && next.surfaceOp === 'append')
      || next.type === 'agent/inbox/spliced') break
    boundary = next.seq
  }
  return boundary
}

/** Implements Session business commands delegated by the Session Controller Remote service. */
export class SessionCommandController {
  /**
   * Operation identities already settled or settling; replaying one returns
   * its settled promise instead of creating a second Session.
   */
  private readonly settledOperations = new Map<string, { readonly promise: Promise<SessionCreateValue>; settled: boolean }>()
  /** Bound on retained operation results; the oldest settled identity leaves first. */
  private static readonly SETTLED_OPERATION_LIMIT = 128
  /** Host-internal coordination over the registered creation policies. */
  private readonly policies: SessionCreationPolicyRuntime | undefined

  /**
   * @param ctx - Host context carrying Agent, model, attachment, title, and Workspace services.
   * @param agents - sole owner of create, resume, and Session-local model selection.
   * @param defaultCwd - project directory used when create names neither a Workspace nor a cwd.
   * @param policies - registered creation policies; omission keeps the historical path.
   * @param promptAdmission - synchronous prompt-admission facts; the Host composition
   *   always supplies it, and omission keeps only the live pending-Inbox evidence.
   */
  constructor(
    private readonly ctx: Context,
    private readonly agents: ApiSessionAgentController,
    private readonly defaultCwd: string,
    policies?: SessionCreationPolicyRegistry,
    private readonly promptAdmission?: PromptAdmissionReader,
  ) {
    this.policies = policies === undefined ? undefined : creationPolicyRuntime(policies)
  }

  /**
   * Create one ordinary Session for a new conversation, reusing the named
   * blank Session while it is an unarchived member of the requested Workspace.
   *
   * With a creation-policy registry, every attempt runs in its short serial
   * scope and an operation context selects the policy that prepares and
   * registers the result. Replaying one operation identity settles once.
   * @param request - optional blank Session to reuse, location, Agent preset,
   *   and an optional creation-policy operation context.
   * @returns the created or reused Session identity and its preset when configured.
   */
  async create(request: SessionCreateRequest): Promise<SessionCreateValue> {
    if (request.workspaceId !== undefined && request.cwd !== undefined) {
      throw new RemoteError('gateway/bad-request', 'session.create accepts workspaceId or cwd, not both', {})
    }
    let workspace: Workspace | undefined
    if (request.workspaceId !== undefined) {
      workspace = this.ctx.workspaceRegistry.get(request.workspaceId)
      if (workspace === undefined) {
        throw new RemoteError('workspace/not-found', `workspace "${request.workspaceId}" not found`, {
          workspaceId: request.workspaceId,
        })
      }
    }
    const cwd = workspace?.path ?? request.cwd ?? this.defaultCwd
    const policies = this.policies
    if (policies === undefined) {
      return await this.runCreation(() => this.createNow(request, workspace, cwd, request.sessionId))
    }
    const operation = request.operation
    if (operation === undefined) {
      // The historical path still passes through the policy-compatibility
      // check: an ordinary intent may reuse only a candidate every policy
      // leaves unclaimed, and an unreadable claim is never treated as ordinary.
      return await this.runCreation(() => policies.coordinate(async () => {
        const candidate = await this.reusableCandidate(request.sessionId, true, undefined, policies)
        return await this.createNow(request, workspace, cwd, candidate)
      }))
    }
    const key = operationKey(operation)
    const settled = this.settledOperations.get(key)
    if (settled !== undefined) return await settled.promise
    // Publish the in-flight identity before the first await: concurrent
    // deliveries of the same operation must join this attempt, not queue a
    // second one.
    const deferred = Promise.withResolvers<SessionCreateValue>()
    void deferred.promise.catch(() => {})
    const pending = { promise: deferred.promise, settled: false }
    this.settledOperations.set(key, pending)
    this.evictSettledOperations()
    try {
      // Capture the answering registration before queueing: a later withdrawal
      // (even with a same-id replacement) must not run this queued operation.
      const claim = await this.operationPolicy(operation, policies)
      const result = await policies.coordinate(
        () => this.createOperated(request, workspace, cwd, operation, policies, claim),
      )
      pending.settled = true
      deferred.resolve(result)
      return result
    } catch (error) {
      // A proven pre-create refusal may be retried with the same identity;
      // anything else did (or may have) produced a Session and replays as-is.
      if (creationKnowledgeOf(error) === 'none') this.settledOperations.delete(key)
      else pending.settled = true
      const failure = this.creationFailure(error)
      deferred.reject(failure)
      throw failure
    }
  }

  /** Map a failed attempt to the failure delivered to its caller. */
  private async runCreation(task: () => Promise<SessionCreateValue>): Promise<SessionCreateValue> {
    try {
      return await task()
    } catch (error: unknown) {
      throw this.creationFailure(error)
    }
  }

  /** Drop the oldest settled operation results; in-flight identities are never evicted. */
  private evictSettledOperations(): void {
    if (this.settledOperations.size <= SessionCommandController.SETTLED_OPERATION_LIMIT) return
    for (const [key, entry] of this.settledOperations) {
      if (this.settledOperations.size <= SessionCommandController.SETTLED_OPERATION_LIMIT) return
      if (entry.settled) this.settledOperations.delete(key)
    }
  }

  /** Whether the Controller may hand this exact candidate back to the Factory. */
  private inheritsCandidate(
    candidate: SessionId | undefined,
    workspace: Workspace | undefined,
  ): (sessionId: SessionId) => boolean {
    return sessionId => candidate === sessionId
      && !this.ctx.workspaceRegistry.archivedSessionIds.includes(sessionId)
      && (workspace === undefined || workspace.sessionIds.includes(sessionId))
  }

  /** The native creation call both admission paths share. */
  private async createAgentSession(
    request: SessionCreateRequest,
    cwd: string,
    candidate: SessionId | undefined,
    inherits: (sessionId: SessionId) => boolean,
  ): Promise<ApiSessionCreated> {
    return this.agents.createSession({
      ...(candidate === undefined ? {} : { sessionId: candidate }),
      cwd,
      ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }),
      reusable: inherits,
    })
  }

  /** One creation attempt without policy participation. */
  private async createNow(
    request: SessionCreateRequest,
    workspace: Workspace | undefined,
    cwd: string,
    candidate: SessionId | undefined,
  ): Promise<SessionCreateValue> {
    const created = await this.createAgentSession(request, cwd, candidate, this.inheritsCandidate(candidate, workspace))
    const sessionId = created.agent.id
    if (workspace !== undefined) await this.attachCreated(sessionId, workspace, undefined)
    return { sessionId, ...(created.agentPreset === undefined ? {} : { agentPreset: created.agentPreset }) }
  }

  /** One policy-coordinated creation attempt: identify, prepare, create, register, finish. */
  private async createOperated(
    request: SessionCreateRequest,
    workspace: Workspace | undefined,
    cwd: string,
    operation: SessionCreateOperationContext,
    policies: SessionCreationPolicyRuntime,
    claim: SessionCreationPolicyClaim | undefined,
  ): Promise<SessionCreateValue> {
    if (workspace === undefined) {
      throw new RemoteError(
        'gateway/bad-request',
        'a creation policy operation requires a workspaceId target',
        {},
      )
    }
    if (operation.operationId === '') {
      throw new RemoteError('gateway/bad-request', 'operationId must not be empty', {})
    }
    // The registration captured before queueing must still be the live one:
    // a withdrawal during the wait (even replaced by the same id) ends this
    // operation without entering either activation's handlers.
    if (claim !== undefined && !policies.isLive(claim)) {
      throw withdrawnPolicy(claim.policyId, operation.operationId)
    }
    const policy = claim?.policy
    const candidate = await this.reusableCandidate(
      request.sessionId,
      operation.reuseBlank !== false,
      claim,
      policies,
    )
    if (claim !== undefined && !policies.isLive(claim)) {
      throw withdrawnPolicy(claim.policyId, operation.operationId)
    }
    let begun: {
      readonly policy: SessionCreationPolicy
      readonly participant: SessionCreationParticipant
    } | undefined
    if (policy?.beginOperation !== undefined) {
      try {
        begun = {
          policy,
          participant: await policy.beginOperation({
            operationId: operation.operationId,
            kind: operation.kind,
            workspaceId: workspace.id,
            ...(operation.sourceSessionId === undefined ? {} : { sourceSessionId: operation.sourceSessionId }),
            ...(candidate === undefined ? {} : { candidateSessionId: candidate }),
            reuseBlank: operation.reuseBlank !== false,
          }),
        }
      } catch (error) {
        throw new RemoteError(
          'session/policy-begin-failed',
          `creation policy "${policy.id}" refused operation "${operation.operationId}": ${String(error)}`,
          { policyId: policy.id, operationId: operation.operationId },
        )
      }
    }
    let created: ApiSessionCreated
    try {
      // The compatibility decision is already made; the Controller still
      // applies its own archived and membership rules to the one candidate.
      created = await this.createAgentSession(request, cwd, candidate, this.inheritsCandidate(candidate, workspace))
    } catch (error) {
      const creation = creationKnowledgeOf(error)
      const knownId = error instanceof ApiSessionCreationFailed ? error.sessionId : undefined
      await this.finishOperation(begun?.participant, {
        kind: 'failed',
        stage: 'create',
        creation,
        message: messageOf(error),
        ...(creation === 'known' && knownId !== undefined ? { sessionId: knownId, workspaceId: workspace.id } : {}),
      })
      throw error
    }
    const sessionId = created.agent.id
    const reused = candidate === sessionId
    await this.attachCreated(sessionId, workspace, begun?.participant)
    if (begun !== undefined && begun.participant.prepareSession !== undefined) {
      try {
        await begun.participant.prepareSession({ sessionId, workspaceId: workspace.id, reused })
      } catch (error) {
        await this.finishOperation(begun.participant, {
          kind: 'failed',
          stage: 'prepare',
          creation: 'known',
          message: messageOf(error),
          sessionId,
          workspaceId: workspace.id,
        })
        throw new RemoteError(
          'session/policy-prepare-failed',
          `session "${sessionId}" was created but policy "${begun.policy.id}" could not prepare it: ${String(error)}`,
          {
            sessionId,
            workspaceId: workspace.id,
            operationId: operation.operationId,
            policyId: begun.policy.id,
          },
        )
      }
    }
    await this.finishOperation(begun?.participant, { kind: 'created', sessionId, workspaceId: workspace.id, reused })
    return { sessionId, ...(created.agentPreset === undefined ? {} : { agentPreset: created.agentPreset }) }
  }

  /** Resolve the policy registration a creation operation continues, or undefined for the ordinary path. */
  private async operationPolicy(
    operation: SessionCreateOperationContext,
    policies: SessionCreationPolicyRuntime,
  ): Promise<SessionCreationPolicyClaim | undefined> {
    const explicit = operation.policyId
    if (explicit !== undefined) {
      const claim = policies.claim(explicit)
      if (claim === undefined) {
        throw new RemoteError(
          'session/policy-unavailable',
          `creation policy "${explicit}" is not registered`,
          { policyId: explicit, operationId: operation.operationId },
        )
      }
      const source = operation.sourceSessionId
      if (source !== undefined) {
        // Every policy is asked, not only the selected one: two policies
        // claiming the same identity is a conflict even when the caller named
        // one of them.
        const inspection = await policies.inspect(source)
        switch (inspection.kind) {
          case 'owned':
            if (inspection.policyId !== explicit) {
              throw new RemoteError(
                'session/source-not-policy',
                `session "${source}" is not owned by creation policy "${explicit}"`,
                { policyId: explicit, sessionId: source, operationId: operation.operationId },
              )
            }
            break
          case 'conflict':
            throw new RemoteError(
              'session/policy-conflict',
              `several creation policies claim source session "${source}"`,
              { sessionId: source, operationId: operation.operationId },
            )
          case 'unclaimed':
            throw new RemoteError(
              'session/source-not-policy',
              `session "${source}" is not owned by creation policy "${explicit}"`,
              { policyId: explicit, sessionId: source, operationId: operation.operationId },
            )
          case 'unknown':
            throw new RemoteError(
              'session/policy-source-unknown',
              `creation policy ownership of source session "${source}" is ${inspection.kind}`,
              { sessionId: source, operationId: operation.operationId },
            )
        }
        // The selected registration may have been withdrawn while the
        // ownership read was pending; a same-id replacement is a different
        // activation and must not receive this call.
        if (!policies.isLive(claim)) throw withdrawnPolicy(explicit, operation.operationId)
      }
      return claim
    }
    const source = operation.sourceSessionId
    if (source === undefined) return undefined
    const resolution = await policies.resolveSource(source)
    switch (resolution.kind) {
      case 'owned':
      case 'claimed':
        if (!policies.isLive(resolution.claim)) {
          throw new RemoteError(
            'session/policy-source-unknown',
            `creation policy ownership of source session "${source}" changed during resolution`,
            { sessionId: source, operationId: operation.operationId },
          )
        }
        return resolution.claim
      case 'unclaimed':
        return undefined
      case 'unknown':
      case 'conflict':
        throw new RemoteError(
          resolution.kind === 'conflict' ? 'session/policy-conflict' : 'session/policy-source-unknown',
          `creation policy ownership of source session "${source}" is ${resolution.kind}`,
          { sessionId: source, operationId: operation.operationId },
        )
    }
  }

  /**
   * Decide whether the caller's candidate may be reused under this operation.
   * The aggregate gives one definite claim priority over another policy's
   * unreadable answer; only when no policy claims does an unreadable answer
   * make the identity non-reusable, and two definite claims are a conflict.
   * An ordinary intent therefore needs every policy to answer a definite
   * non-claim, while a named policy reuses only the candidate it itself owns.
   * @param sessionId - candidate the caller named, when any.
   * @param reuseBlank - whether this intent allows reusing a blank Session.
   * @param claim - selected policy; omission means an ordinary intent.
   * @param policies - live policy ledger.
   * @returns the candidate to pass to the Controller, or undefined to create fresh.
   */
  private async reusableCandidate(
    sessionId: SessionId | undefined,
    reuseBlank: boolean,
    claim: SessionCreationPolicyClaim | undefined,
    policies: SessionCreationPolicyRuntime,
  ): Promise<SessionId | undefined> {
    if (sessionId === undefined || !reuseBlank) return undefined
    const inspection = await policies.inspect(sessionId)
    if (claim === undefined) return inspection.kind === 'unclaimed' ? sessionId : undefined
    return inspection.kind === 'owned' && inspection.policyId === claim.policyId ? sessionId : undefined
  }

  /** Attach a created Session to its Workspace and report a partial success with its identity. */
  private async attachCreated(
    sessionId: SessionId,
    workspace: Workspace,
    participant: SessionCreationParticipant | undefined,
  ): Promise<void> {
    try {
      await workspace.attachSession(sessionId)
    } catch (error) {
      await this.finishOperation(participant, {
        kind: 'failed',
        stage: 'create',
        creation: 'known',
        message: messageOf(error),
        sessionId,
        workspaceId: workspace.id,
      })
      throw new RemoteError(
        'session/workspace-attach-failed',
        `session "${sessionId}" was created but could not attach to workspace "${workspace.id}": ${String(error)}`,
        { sessionId, workspaceId: workspace.id },
      )
    }
  }

  /** Deliver one outcome to the participant; policy settlement failures stay diagnostics. */
  private async finishOperation(
    participant: SessionCreationParticipant | undefined,
    outcome: SessionCreationOutcome,
  ): Promise<void> {
    if (participant?.finishOperation === undefined) return
    try {
      await participant.finishOperation(outcome)
    } catch (error) {
      this.ctx.logger.warn(
        `session-controller: creation policy did not settle ${outcome.kind} operation: ${String(error)}`,
      )
    }
  }

  /**
   * Validate and record one Session model selection; save the default in the background.
   * @param request - Session identity and requested model selection.
   * @returns the normalized selection recorded for the Session, without waiting for default persistence.
   */
  async selectModel(request: SessionSelectModelRequest): Promise<SessionSelectModelValue> {
    const agent = await this.resolveAgent(request.sessionId)
    return this.agents.serializeImageAdmission(agent, async () => {
      try {
        await this.requireModel(request)
        const selected: AgentModelSelection = {
          provider: request.provider,
          model: request.model,
          ...(request.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: ReasoningEffortId(request.reasoningEffort) }),
        }
        await this.ctx.llm.resolveCallConfig(selected)
        agent.model.select(selected)
        void this.ctx.agentDefaultModel.saveSelection(selected).catch((error: unknown) => {
          this.ctx.logger.warn(
            `session-controller: model selection changed for the Session but the default was not saved: ${String(error)}`,
          )
        })
        return { selected: { ...selected } }
      } catch (error) {
        if (remoteErrorOf(error) !== undefined) throw error
        throw new RemoteError(
          'session/model-unavailable',
          error instanceof Error ? error.message : String(error),
          { provider: request.provider, model: request.model },
        )
      }
    })
  }

  /**
   * Normalize and append a user-owned Session title.
   * @param request - Session identity and proposed title.
   * @returns the accepted title and durable event sequence.
   */
  async rename(request: SessionRenameRequest): Promise<SessionRenameValue> {
    const agent = await this.resolveAgent(request.sessionId)
    const titles = this.ctx.get('sessionTitle')
    if (titles === undefined) {
      throw new RemoteError('gateway/internal', 'renaming is unavailable: this deployment mounts no session-title service', {})
    }
    try {
      const accepted = titles.rename(agent.session, request.title)
      return { title: accepted.title, seq: accepted.eventSeq }
    } catch (error) {
      if (error instanceof SessionTitleInvalidError) {
        throw new RemoteError('session/title-invalid', error.message, { sessionId: request.sessionId })
      }
      throw new RemoteError(
        'gateway/internal',
        `failed to rename session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
  }

  /**
   * Create a new ordinary Session from an exact event prefix. An explicit
   * `atSeq` is the inclusive cut; an omitted value selects the latest
   * completed-turn prefix. An open cut receives synthetic fork closers.
   * @param request - source Session and optional exact event boundary.
   * @returns the new Session identity.
   */
  async fork(request: SessionForkRequest): Promise<SessionForkValue> {
    let atSeq: ReturnType<typeof SessionSeq> | undefined
    try {
      atSeq = request.atSeq === undefined ? undefined : SessionSeq(request.atSeq)
    } catch {
      throw new RemoteError('gateway/bad-request', 'atSeq must be a non-negative safe integer', {})
    }
    let observed: SessionObservation
    try {
      observed = await this.ctx.sessionQuery.observeSession(request.sessionId)
    } catch (error) {
      if (error instanceof SessionQueryError
        && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new RemoteError('session/not-found', `session "${request.sessionId}" not found`, {
          sessionId: request.sessionId,
        })
      }
      throw new RemoteError(
        'gateway/internal',
        `fork source unavailable for session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
    using source = observed
    const boundary = atSeq ?? latestCompletedPrefixBoundary(source.events)
    if (boundary === undefined || source.events[boundary]?.seq !== boundary) {
      throw new RemoteError(
        'session/fork-unavailable',
        request.atSeq === undefined
          ? `session "${request.sessionId}" has no completed turn to fork from`
          : `event ${String(request.atSeq)} does not exist in session "${request.sessionId}" (last seq: ${String(source.events.at(-1)?.seq ?? 'none')})`,
        { sessionId: request.sessionId },
      )
    }
    const seed = buildForkSeed(source.events, boundary)
    let workspace: Workspace | undefined
    try {
      workspace = await this.forkWorkspace(source.header)
    } catch (error) {
      throw new RemoteError(
        'gateway/internal',
        `failed to resolve fork workspace for session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
    const childId = brandString<SessionId>(`session-${randomUUID()}`)
    const sourcePreset = this.agents.presetForObservation(source)
    if (sourcePreset !== undefined) await this.agents.assertUserSelectablePreset(sourcePreset)
    // Omitting a source preset still resolves the default; fork is a user
    // creation path, so the effective preset must obey the user-selection rule too.
    const composition = await this.agents.composeAgent(sourcePreset, { requireUserSelectable: true })
    try {
      const { provider, model } = this.ctx.agentDefaultModel.currentSelection()
      await this.ctx.agents.create({
        sessionId: childId,
        seed,
        inheritedEventCount: SessionLogOffset(boundary + 1),
        meta: {
          ...(source.header.cwd === undefined ? {} : { cwd: source.header.cwd }),
          isSeeded: true,
          ...(composition.agentPreset === undefined
            ? {}
            : { agentPreset: composition.agentPreset }),
        },
        agentOptions: { provider, model },
        setup: composition.setup,
      })
    } catch (error) {
      const refusal = presetRefusal(error)
      if (refusal !== undefined) throw refusal
      if (String(error).includes('not user-selectable')) {
        throw new RemoteError('agent-preset/not-selectable', String(error), {
          agentPreset: sourcePreset ?? '',
        })
      }
      throw new RemoteError(
        'gateway/internal',
        `failed to fork session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
    if (workspace !== undefined) {
      try {
        await workspace.attachSession(childId)
      } catch (error) {
        throw new RemoteError(
          'session/workspace-attach-failed',
          `session "${childId}" was forked but could not attach to workspace "${workspace.id}": ${String(error)}`,
          { sessionId: childId, workspaceId: workspace.id },
        )
      }
    }
    return { sessionId: childId }
  }

  /**
   * Admit one prompt after Agent and attachment validation; the Remote method
   * has already validated the content and built the durable message source.
   * @param request - Session identity, prompt content, and delivery mode.
   * @param source - the `user-rpc` source recorded on the accepted message.
   * @returns acknowledgement that the Agent accepted the prompt.
   */
  async prompt(request: SessionPromptRequest, source: MessageSource): Promise<SessionPromptValue> {
    const agent = await this.resolveAgent(request.sessionId)
    if (hasPromptRequest(agent, request.requestId, this.promptAdmission)) return { accepted: true }
    const admission = resolvePromptFileReceipts(
      request.content,
      receiptId => this.ctx.fileUploads.resolve(agent, receiptId),
    )
    // Encoded images and image upload receipts both make an image prompt.
    const hasImage = admission.content.some(part => part.type === 'image')
    const admit = async (): Promise<SessionPromptValue> => {
      try {
        // The image queue and the caller's first await can both overlap another
        // retry of the same request. Re-check before converting anything again.
        if (this.ctx.agents.get(agent.id) !== agent) {
          throw new RemoteError(
            'session/not-found',
            `session "${agent.id}" was disposed during prompt admission`,
            { sessionId: agent.id },
          )
        }
        if (hasPromptRequest(agent, request.requestId, this.promptAdmission)) return { accepted: true }
        if (hasImage) {
          const current = agent.model.current()
          if (current !== undefined) {
            const model = await this.ctx.llm.resolveModelInfo(current.provider, current.model)
            if (model.inputModalities !== undefined && !model.inputModalities.includes('image')) {
              throw new RemoteError(
                'session/attachment-invalid',
                `Model "${current.model}" does not support image input.`,
                { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
              )
            }
          }
        }
        const content = await this.ctx.attachments.admitPromptContent(admission.content)
        if (this.ctx.agents.get(agent.id) !== agent) {
          throw new RemoteError(
            'session/not-found',
            `session "${agent.id}" was disposed during prompt admission`,
            { sessionId: agent.id },
          )
        }
        // No await may separate this synchronous re-check from the bind and
        // insert: a claim committed by an overlapping retry is visible here.
        if (hasPromptRequest(agent, request.requestId, this.promptAdmission)) return { accepted: true }
        const message: UserMessage = createUserMessage({ content, source })
        using binding = this.ctx.fileUploads.bindPrompt(agent, admission.receiptIds, request.requestId)
        if (request.mode === 'steer') agent.steer(message)
        else agent.followup(message)
        binding.commit()
      } catch (error) {
        if (remoteErrorOf(error) !== undefined) throw error
        if (error instanceof AttachmentError) {
          throw new RemoteError('session/attachment-invalid', error.message, { reason: error.code })
        }
        throw new RemoteError('session/agent-busy', 'prompt rejected', { reason: String(error) })
      }
      return { accepted: true }
    }
    return hasImage ? this.agents.serializeImageAdmission(agent, admit) : admit()
  }

  private async requireModel(selection: Pick<AgentModelSelection, 'provider' | 'model'>): Promise<void> {
    if (!await modelAvailable(this.ctx, selection)) {
      throw new RemoteError('session/model-unavailable', 'Select an available model before sending a message.',
        { provider: selection.provider, model: selection.model })
    }
  }

  /**
   * Read one durable image using the supplied reference without consulting Session history.
   * @param request - image reference and gateway permission scope; Session existence is not checked.
   * @returns the durable attachment reference and base64-encoded bytes.
   */
  async attachment(request: SessionAttachmentRequest): Promise<SessionAttachmentValue> {
    try {
      const stored = await this.ctx.attachments.readImage(request.attachment)
      return {
        attachment: stored.ref,
        data: Buffer.from(stored.data).toString('base64'),
      }
    } catch (error) {
      if (error instanceof AttachmentError) {
        throw new RemoteError('session/attachment-invalid', error.message, { reason: error.code })
      }
      throw new RemoteError('gateway/internal', 'Unable to read image attachment.', {})
    }
  }

  /**
   * Mutate one pending Inbox occurrence, restoring an ordinary cold Agent when needed.
   * @param request - Session, queue item, and requested mutation.
   * @returns acknowledgement that the queue mutation was applied.
   */
  async updateQueue(request: SessionUpdateQueueRequest): Promise<SessionUpdateQueueValue> {
    if (request.action.kind === 'edit') {
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- Remote callers can submit untyped JSON.
      if (request.action.content.some(block => block.type !== 'text')) {
        throw new RemoteError(
          'session/attachment-invalid',
          'queue edits accept text content only',
          { reason: 'QUEUE_EDIT_NON_TEXT' },
        )
      }
      if (!hasPromptContent(request.action.content)) {
        throw new RemoteError(
          'gateway/bad-request',
          'queue edit content must include non-whitespace text',
          {},
        )
      }
    }
    let agent = this.ctx.agents.get(request.sessionId)
    if (agent === undefined) {
      const found = await this.agents.resolveAgent(request.sessionId)
      if ('error' in found) {
        if (found.error.code !== 'session/not-found') throw found.error
        throw new RemoteError('session/queue-item-not-found', 'queued item is no longer pending', { itemId: request.itemId })
      }
      agent = found.agent
    }
    if (hasApiSessionSubagentOwner(this.ctx, agent.session, agent)) {
      const identity = this.ctx.sessionProjections
        .snapshot(agent.session, ['subagent'])
        .values.subagent
      if (identity?.mode !== 'continuable'
        || !agent.session.isOwnSeq(identity.seq)) {
        throw apiSessionSubagentOwnershipError(request.sessionId)
      }
    }
    const nextTurn = agent.inbox.nextTurn.find(message => message.id === request.itemId)
    const nextStep = agent.inbox.nextStep.find(message => message.id === request.itemId)
    const located = nextTurn === undefined
      ? nextStep === undefined ? undefined : { target: 'next-step' as const, message: nextStep }
      : { target: 'next-turn' as const, message: nextTurn }
    if (located === undefined) {
      throw new RemoteError('session/queue-item-not-found', 'queued item is no longer pending', { itemId: request.itemId })
    }
    const { target, message } = located
    if (request.action.kind === 'steer' && (target !== 'next-turn' || agent.status !== 'running')) {
      throw new RemoteError('session/steer-unavailable', 'current turn no longer accepts steering', { itemId: request.itemId })
    }
    switch (request.action.kind) {
      case 'edit':
        agent.inbox.replace(request.itemId, freezeMessage<UserMessage>({
          ...message,
          content: [...request.action.content],
        }))
        break
      case 'remove': {
        agent.inbox.remove(request.itemId)
        const source = message.source
        if (source.kind === 'user' && 'rpcId' in source) {
          this.ctx.fileUploads.retirePrompt(agent, source.rpcId)
        }
        break
      }
      case 'steer':
        agent.inbox.remove(request.itemId)
        agent.steer(message)
        break
      /* v8 ignore next 2 -- closed-union exhaustiveness guard */
      default:
        assertNever(request.action, 'queue action')
    }
    return { accepted: true }
  }

  /**
   * Cancel one live ordinary Agent while retaining pending inbox work.
   * @param request - Session whose active Agent turn is cancelled.
   * @returns acknowledgement that cancellation was requested.
   */
  cancel(request: SessionCancelRequest): SessionCancelValue {
    const agent = this.ctx.agents.get(request.sessionId)
    if (agent === undefined) {
      throw new RemoteError(
        'session/not-found',
        `session "${request.sessionId}" not found (not attached)`,
        { sessionId: request.sessionId },
      )
    }
    if (hasApiSessionSubagentOwner(this.ctx, agent.session, agent)) {
      throw apiSessionSubagentOwnershipError(request.sessionId)
    }
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    return { accepted: true }
  }

  private async resolveAgent(sessionId: SessionId): Promise<Agent> {
    const found = await this.agents.resolveAgent(sessionId)
    if ('error' in found) throw found.error
    return found.agent
  }

  /**
   * The failure delivered for one failed creation attempt.
   *
   * A failure raised from inside a factory call is reported generically: its
   * code may come from a plugin, and a Session may already exist, so the code
   * cannot promise that the attempt created nothing. The original code stays
   * in the message for diagnostics. A proven pre-create refusal keeps its owner
   * code — so callers keep the preset hint — and gains this Controller's
   * `creation: 'none'` evidence.
   * @param error - the failure thrown out of the attempt.
   * @returns the Remote failure for the caller.
   */
  private creationFailure(error: unknown): RemoteFailure {
    if (!(error instanceof ApiSessionCreationFailed)) return this.creationRefusal(error)
    if (error.enteredFactory) {
      const original = remoteErrorOf(error.failure)
      const reason = original === undefined
        ? messageOf(error.failure)
        : `${original.code}: ${original.message}`
      return new RemoteError('gateway/internal', `failed to create session: ${reason}`, {})
    }
    const refusal = this.creationRefusal(error.failure)
    switch (refusal.code) {
      case 'agent-preset/not-found':
        return new RemoteError(refusal.code, refusal.message, { ...refusal.details, creation: 'none' })
      case 'agent-preset/invalid':
        return new RemoteError(refusal.code, refusal.message, { ...refusal.details, creation: 'none' })
      default:
        return refusal
    }
  }

  /**
   * The failure delivered for a creation failure this Controller raised itself:
   * pre-create validation, or a partial success that names the real Session.
   * @param error - the failure thrown out of the attempt.
   * @returns the Remote failure for the caller.
   */
  private creationRefusal(error: unknown): RemoteFailure {
    const failure = remoteErrorOf(error)
    if (failure !== undefined) return failure
    if (error instanceof ApiSessionPresetConflict) {
      return new RemoteError('agent-preset/conflict', error.message, {
        sessionId: error.sessionId,
        requestedPreset: error.requestedPreset,
      })
    }
    if (error instanceof ApiSessionCwdConflict) {
      return new RemoteError('session/conflict', error.message, {
        sessionId: error.sessionId,
        requestedCwd: error.requestedCwd,
        ...(error.existingCwd === undefined ? {} : { existingCwd: error.existingCwd }),
      })
    }
    if (error instanceof ApiSessionSubagentOwnership) {
      return apiSessionSubagentOwnershipError(error.sessionId)
    }
    return new RemoteError('gateway/internal', `failed to create session: ${String(error)}`, {})
  }

  private async forkWorkspace(source: SessionHeader): Promise<Workspace | undefined> {
    const workspaces = this.ctx.workspaceRegistry.list()
    const direct = workspaces.find(workspace => workspace.sessionIds.includes(source.id))
    if (direct !== undefined || source.origin !== 'subagent') return direct
    const lineage = await this.ctx.sessionQuery.traceSession(source.id)
    for (const ancestor of lineage.ancestors) {
      const workspace = workspaces.find(candidate => candidate.sessionIds.includes(ancestor.header.id))
      if (workspace !== undefined) return workspace
    }
    return undefined
  }
}

/** Replace each file part with the file or image its staged receipt names. */
function resolvePromptFileReceipts(
  content: SessionPromptRequest['content'],
  staged: (receiptId: FileUploadReceiptId) => StagedAttachment | undefined,
): { readonly content: AttachmentAdmissionPart[]; readonly receiptIds: readonly FileUploadReceiptId[] } {
  const receiptIds = new Set<FileUploadReceiptId>()
  const resolved = content.map((part): AttachmentAdmissionPart => {
    if (part.type !== 'file') return part
    const attachment = staged(part.receiptId)
    if (attachment === undefined) {
      throw new RemoteError(
        'session/attachment-invalid',
        'File was not uploaded for this session.',
        { reason: 'FILE_NOT_STAGED' },
      )
    }
    receiptIds.add(part.receiptId)
    return attachment
  })
  return { content: resolved, receiptIds: [...receiptIds] }
}

/**
 * Whether this prompt request already accepted input or owns a live claim.
 *
 * A pending Inbox occurrence is live evidence. A host-side rewrite keeps the
 * request id while replacing the human source kind, so its claim and admission
 * are recorded by the private prompt-admission projection and read here as a
 * synchronous domain fact; this command never rescans the log. A claimed but
 * unadmitted occurrence is in flight, so an overlapping retry must not insert
 * a second copy. A producer that copies the request id without that claim
 * chain is neither admitted nor in flight.
 * @param agent - live Agent owning the request.
 * @param requestId - client-minted prompt identity.
 * @param admission - prompt-admission reader, when the Host composition supplied one.
 * @returns whether the request already accepted this exact input or is being admitted.
 */
function hasPromptRequest(
  agent: Agent,
  requestId: SessionRequestId,
  admission: PromptAdmissionReader | undefined,
): boolean {
  const matchesOriginal = (message: UserMessage): boolean => {
    const source = message.source
    return source.kind === 'user' && 'rpcId' in source && source.rpcId === requestId
  }
  if (agent.inbox.nextTurn.some(matchesOriginal) || agent.inbox.nextStep.some(matchesOriginal)) return true
  return admission?.acceptedOrInFlight(agent.session, requestId) ?? false
}

/** Find a preset refusal preserved under creation wrappers. */
function presetRefusal(error: unknown): Error | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current !== undefined; depth += 1) {
    if (current instanceof Error && remoteErrorOf(current)?.code === 'agent-preset/not-selectable') return current
    current = typeof current === 'object' && current !== null && 'cause' in current
      ? (current as { readonly cause?: unknown }).cause
      : undefined
  }
  return undefined
}
