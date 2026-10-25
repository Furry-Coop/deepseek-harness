/**
 * Generic creation-policy seam for ordinary Session creation.
 *
 * A plugin can claim its own Session identities without the Host learning the
 * plugin's business: the Host asks every registered policy whether an identity
 * belongs to it, lets the selected policy prepare an operation before the
 * Session Controller creates or reuses a Session, and lets it finish after the
 * real outcome is known. The Session Controller stays the only creator.
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { SessionOperationId } from './types.ts'

/** One policy's answer about a Session identity. */
export type SessionCreationOwnership = 'claimed' | 'unclaimed' | 'unknown'

/** Aggregate answer across every registered policy. */
export type SessionCreationInspection =
  /** The named policy claims the identity. */
  | { readonly kind: 'claimed'; readonly policyId: string }
  /** Exactly one registered policy claims the identity when no policy is named. */
  | { readonly kind: 'owned'; readonly policyId: string }
  /** No policy claims the identity, and every answer was definite. */
  | { readonly kind: 'unclaimed' }
  /** At least one policy cannot tell, so the identity must not be treated as ordinary. */
  | { readonly kind: 'unknown' }
  /** Two policies claim the same identity. */
  | { readonly kind: 'conflict' }

/** One captured registration: its policy plus the activation identity of that register call. */
export interface SessionCreationPolicyClaim {
  /** Stable policy identity selected by callers. */
  readonly policyId: string
  /** The registered policy object. */
  readonly policy: SessionCreationPolicy
  /** Opaque activation identity, unique per {@link SessionCreationPolicyRegistry.register} call. */
  readonly activation: object
}

/** Ownership answer that keeps the exact live registration which answered. */
export type PolicySourceResolution =
  /** The named policy claims the identity. */
  | { readonly kind: 'claimed'; readonly claim: SessionCreationPolicyClaim }
  /** One live policy owns the identity. */
  | { readonly kind: 'owned'; readonly claim: SessionCreationPolicyClaim }
  | { readonly kind: 'unclaimed' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'conflict' }

/** Stage of the native creation flow a failure belongs to. */
export type SessionCreationStage = 'workspace' | 'create' | 'policy' | 'prepare'

/** Whether the Session exists once a creation attempt fails. */
export type SessionCreationKnowledge = 'none' | 'known' | 'unknown'

/** Context the Host hands to the policy selected for one creation operation. */
export interface SessionCreationOperation {
  /** Caller-minted identity of this one operation. */
  readonly operationId: SessionOperationId
  /** Native action that started the operation. */
  readonly kind: 'new' | 'workspace' | 'restore'
  /** Workspace the Session joins. */
  readonly workspaceId: WorkspaceId
  /** Session whose Workspace selection continues into this operation. */
  readonly sourceSessionId?: SessionId
  /** Blank Session the caller proposed for reuse, when any. */
  readonly candidateSessionId?: SessionId
  /** Whether reusing an existing blank Session is allowed. */
  readonly reuseBlank: boolean
}

/** Facts the Host reports once a Session exists and its Workspace link is settled. */
export interface SessionCreationPreparation {
  /** Actual Session identity the Controller produced. */
  readonly sessionId: SessionId
  /** Workspace the Session joined. */
  readonly workspaceId: WorkspaceId
  /** Whether the Session is an existing blank the Host reused. */
  readonly reused: boolean
}

/** Final Host-side outcome of one creation operation. */
export type SessionCreationOutcome =
  | {
    readonly kind: 'created'
    readonly sessionId: SessionId
    readonly workspaceId: WorkspaceId
    readonly reused: boolean
  }
  | {
    readonly kind: 'failed'
    readonly stage: SessionCreationStage
    /** Whether the operation produced a Session. */
    readonly creation: SessionCreationKnowledge
    readonly message: string
    /** Actual identity, present exactly when `creation` is `known`. */
    readonly sessionId?: SessionId
    readonly workspaceId?: WorkspaceId
  }

/** Per-operation participant one policy returns from `beginOperation`. */
export interface SessionCreationParticipant {
  /**
   * Save the actual identity and finish the policy's own registration. The
   * Host waits for this before reporting the creation as ready.
   * @param preparation - actual Session identity, Workspace, and reuse fact.
   */
  prepareSession?(preparation: SessionCreationPreparation): Promise<void> | void
  /**
   * Settle the operation from the Host's facts. Failures here are diagnostics
   * only and never change the creation outcome.
   * @param outcome - whether the operation created a Session.
   */
  finishOperation?(outcome: SessionCreationOutcome): Promise<void> | void
}

/** One plugin's creation policy. */
export interface SessionCreationPolicy {
  /** Provider-namespaced stable identity selected by callers. */
  readonly id: string
  /**
   * Report whether this policy owns a Session identity.
   * @param sessionId - existing Session identity to classify.
   * @returns a definite or unknown ownership answer.
   */
  inspectSession?(sessionId: SessionId): Promise<SessionCreationOwnership> | SessionCreationOwnership
  /**
   * Save the caller's application before the Controller creates a Session.
   * A throw refuses the operation and no Session is created.
   * @param operation - operation identity, target, and candidates.
   * @returns the participant that receives the actual outcome.
   */
  beginOperation?(operation: SessionCreationOperation): Promise<SessionCreationParticipant> | SessionCreationParticipant
}

/** One registered policy and its registration lifetime. */
interface Registration {
  readonly policy: SessionCreationPolicy
  /** Activation identity: unique per register call, even for the same policy object. */
  readonly activation: object
}

/**
 * Host-owned policy ledger plus the short serial scope around one creation.
 *
 * Registration is process-local: a policy is gone exactly when its plugin
 * unloads. Ownership answers are read at creation time, so a policy cannot
 * widen its claim later without another creation call.
 */
export class SessionCreationPolicyRegistry {
  private readonly registrations = new Map<string, Registration>()
  private coordination: Promise<void> = Promise.resolve()

  /**
   * Register one policy for the caller's effect lifetime.
   * @param policy - policy identity and handlers.
   * @returns the disposer removing exactly this registration.
   * @throws when the identity is empty or already registered.
   */
  register(policy: SessionCreationPolicy): () => void {
    if (policy.id === '') throw new Error('session creation policy id must not be empty')
    if (this.registrations.has(policy.id)) {
      throw new Error(`session creation policy "${policy.id}" is already registered`)
    }
    const registration: Registration = { policy, activation: {} }
    this.registrations.set(policy.id, registration)
    return () => {
      if (this.registrations.get(policy.id) === registration) this.registrations.delete(policy.id)
    }
  }

  /**
   * Read one registered policy.
   * @param id - policy identity.
   * @returns the live policy, or undefined when absent.
   */
  get(id: string): SessionCreationPolicy | undefined {
    return this.registrations.get(id)?.policy
  }

  /**
   * Capture one registration for a queued operation.
   * @param id - policy identity.
   * @returns the exact active registration, or undefined when absent.
   */
  claim(id: string): SessionCreationPolicyClaim | undefined {
    const registration = this.registrations.get(id)
    return registration === undefined ? undefined : claimOf(registration)
  }

  /**
   * Whether one exact registration is still the live policy for its identity.
   *
   * A caller captures a claim when it queues an operation and re-checks this
   * after every await boundary: a withdrawal followed by a same-id registration
   * (even with the same policy object) is a different activation and must not
   * run the queued call.
   * @param claim - the captured registration.
   * @returns true only while that exact registration is live.
   */
  isLive(claim: SessionCreationPolicyClaim): boolean {
    return this.registrations.get(claim.policyId)?.activation === claim.activation
  }

  /**
   * Classify one Session identity against the live policies.
   * @param sessionId - Session identity to classify.
   * @param policyId - restrict the question to this policy.
   * @returns the aggregate ownership answer and, for a single claim, the exact live policy.
   */
  async inspect(sessionId: SessionId, policyId?: string): Promise<SessionCreationInspection> {
    const result = await this.classify(sessionId, policyId)
    if (result.kind === 'owned') return { kind: 'owned', policyId: result.claim.policyId }
    if (result.kind === 'claimed') return { kind: 'claimed', policyId: result.claim.policyId }
    return result
  }

  /**
   * Resolve which live policy continues a source Session.
   *
   * Returns the exact registration object that answered, so the caller can
   * re-check {@link isLive} after later awaits instead of accepting a same-id
   * replacement activation.
   * @param sessionId - Session whose Workspace selection continues.
   * @returns the claimed policy, the ordinary answer, or an unreadable conflict.
   */
  async resolveSource(sessionId: SessionId): Promise<PolicySourceResolution> {
    return await this.classify(sessionId)
  }

  /** Shared ownership pass over the live registrations. */
  private async classify(sessionId: SessionId, policyId?: string): Promise<PolicySourceResolution> {
    const registrations = policyId === undefined
      ? [...this.registrations.values()]
      : [this.registrations.get(policyId)].filter(
        (registration): registration is Registration => registration !== undefined,
      )
    let claimed: SessionCreationPolicyClaim | undefined
    let unknown = false
    for (const registration of registrations) {
      const answer = await readOwnership(registration.policy, sessionId)
      if (answer === 'claimed') {
        const claim = claimOf(registration)
        if (policyId !== undefined) return { kind: 'claimed', claim }
        if (claimed !== undefined && claimed.activation !== claim.activation) return { kind: 'conflict' }
        claimed = claim
      } else if (answer === 'unknown') {
        unknown = true
      }
    }
    if (claimed !== undefined) return { kind: 'owned', claim: claimed }
    // An empty or non-identifying roster is the ordinary case: no policy object.
    return unknown ? { kind: 'unknown' } : { kind: 'unclaimed' }
  }

  /**
   * Run one creation attempt inside the short serial scope.
   *
   * The scope covers policy preparation, the Controller call, and policy
   * registration, so a Session cannot be created-but-unregistered while a
   * second creation reuses it. It never covers model steps or cancellation.
   * @param task - the complete create-or-reuse attempt.
   * @returns the task result after earlier attempts settle.
   */
  async coordinate<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.coordination
    let release!: () => void
    this.coordination = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      return await task()
    } finally {
      release()
    }
  }
}

/**
 * Project one registration into the public claim shape.
 * @param registration - live or captured registration.
 * @returns the claim carrying its activation identity.
 */
function claimOf(registration: Registration): SessionCreationPolicyClaim {
  return {
    policyId: registration.policy.id,
    policy: registration.policy,
    activation: registration.activation,
  }
}

/**
 * Ask one policy about one identity. A policy without an inspector claims
 * nothing; a throwing inspector is an unreadable claim.
 * @param policy - policy to ask.
 * @param sessionId - identity to classify.
 * @returns the policy's answer.
 */
async function readOwnership(
  policy: SessionCreationPolicy,
  sessionId: SessionId,
): Promise<SessionCreationOwnership> {
  if (policy.inspectSession === undefined) return 'unclaimed'
  try {
    return await policy.inspectSession(sessionId)
  } catch {
    return 'unknown'
  }
}
