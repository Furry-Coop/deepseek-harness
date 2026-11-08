/** Workspace archive and directory UI capability. */

import { Service, type Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AccessEffect, RemoteEndpoint } from '@deepseek-ai/dsh-api-remote-access/client'
import type { ClientRemote, DirectoryListing, RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ISessions,
  SessionCreateError,
  SessionBinding,
  SessionReference,
  SessionTarget,
  SessionListState,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionOperationId } from '@deepseek-ai/dsh-api-session-controller/types'
// Type-only: pulls the `agentPreset` Session projection value into this program.
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type {
  IWorkspaces, WorkspaceId, WorkspaceSnapshot, WorkspaceView,
} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { DraftInitializationOptions } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { RowToast } from './contract/slots.ts'
import { pinOrderAccounts, pinOrderSource } from './pin-order.ts'
import type { WorkspaceViewStoreActions } from './stores.ts'

interface MainSelection {
  readonly sessionId?: SessionId
  readonly subagentAddress?: SubagentAddress
}

/** Content preparation and Agent preset for the Session a Workspace flow opens. */
export interface StartSessionOptions extends DraftInitializationOptions {
  /** Agent preset the Session runs; the Host default when omitted. */
  readonly agentPreset?: string
  /**
   * Per-call participation and outcome delivery for this explicit New Session.
   * The method still returns `void`; the Host's actual result arrives here.
   */
  readonly operation?: StartSessionOperation
}

/**
 * Options for one Workspace connection that continues an open Session.
 *
 * Carrying `sourceSessionId` explicitly keeps the source's creation mode; the
 * native New Session button and other plain creations omit it and stay
 * ordinary.
 */
export interface OpenWorkspaceOptions extends Pick<StartSessionOptions, 'agentPreset'> {
  /** Open Session whose Workspace pick this continues. */
  readonly sourceSessionId?: SessionId
}

/** Stage of one `startSession` call a failure belongs to. */
export type StartSessionStage = 'workspace' | 'create' | 'policy' | 'prepare' | 'open' | 'extension'

/** What the caller learns once the Host has registered the actual Session. */
export interface StartSessionPreparation {
  /** Actual Session identity the Host created or reused. */
  readonly sessionId: SessionId
  /** Workspace that Session joined. */
  readonly workspaceId: WorkspaceId
}

/**
 * Final outcome of one `startSession` call, delivered once to `onFinished`
 * after the native flow settles. It reports this call's facts only; a plugin's
 * own business result stays with the plugin.
 */
export type StartSessionOutcome =
  | {
    readonly kind: 'session'
    readonly sessionId: SessionId
    readonly workspaceId: WorkspaceId
    /** `opened` when this call still owned navigation when the Session arrived. */
    readonly navigation: 'opened' | 'superseded'
  }
  | {
    readonly kind: 'cancelled'
    /** `caller` when the caller's signal ended, `superseded` when the flow was left. */
    readonly reason: 'caller' | 'superseded'
  }
  | {
    readonly kind: 'failed'
    readonly stage: StartSessionStage
    readonly message: string
    /** Whether this call produced a Session. */
    readonly creation: 'none' | 'known' | 'unknown'
    /** Actual identity, present exactly when `creation` is `known`. */
    readonly sessionId?: SessionId
    readonly workspaceId?: WorkspaceId
  }

/**
 * Per-call lifecycle of one explicit New Session. These values stay on the
 * Client and never enter the Host creation request; only the opaque policy and
 * operation identities cross the wire.
 */
export interface StartSessionOperation {
  /** Registered Host creation policy that owns the resulting Session. */
  readonly policyId?: string
  /** Caller-minted identity of this one operation; replayed deliveries settle once. */
  readonly operationId?: SessionOperationId
  /** Explicitly refuse reuse of an existing blank Session for this call. */
  readonly reuseBlank?: false
  /** Caller lifetime; ending it withdraws the wait and any automatic opening. */
  readonly signal?: AbortSignal
  /**
   * Confirm this call's actual result before the automatic opening. A throw
   * keeps the known Session, cancels the opening, and reports `extension`.
   * The Host has already registered the Session before this runs.
   */
  readonly prepareSession?: (preparation: StartSessionPreparation) => void | Promise<void>
  /** Receive this call's final outcome exactly once; synchronous throws and asynchronous rejections are contained. */
  readonly onFinished?: (outcome: StartSessionOutcome) => void | Promise<void>
}

/** Native actions this Client forwards in one Host creation request. */
interface StartSessionCreateOperation {
  readonly operationId: SessionOperationId
  readonly kind: 'new' | 'workspace' | 'restore'
  readonly policyId?: string
  readonly sourceSessionId?: SessionId
  readonly reuseBlank?: false
}

/** One New Session flow's reusable options: preset, reuse policy, and operation context. */
interface CreationRequestOptions {
  readonly agentPreset?: string
  readonly operation?: StartSessionCreateOperation
  readonly reuseBlank?: boolean
}

/** A New Session call waiting on the native New Session page for a Workspace. */
interface PendingStartSession {
  readonly operation: StartSessionOperation
  /** The waiting call's own choices for the Session the pick creates. */
  readonly creation: Pick<CreationRequestOptions, 'agentPreset' | 'reuseBlank'>
  /** Navigation lease created when the page was entered. */
  readonly navigation: AbortSignal
  /** Removes the abort listeners that discharge this wait. */
  readonly detach: () => void
}

/** Workspace archive and directory operations consumed by Client UI domains. */
export interface UiWorkspace {
  /**
   * Select a Session and show its Conversation as one UI navigation action.
   * @param target - known Session identity or durable direct-parent subagent address to display.
   */
  openSession(target: SessionTarget): void
  /**
   * Connect a Workspace and open its Session unless a later navigation supersedes it,
   * continuing the named source Session's creation-policy identity into the
   * Workspace the operator picked.
   * @param workspaceId - target Workspace.
   * @param beforeOpen - optional synchronous preparation for the selected Session,
   * skipped after supersession; a throw aborts the open and releases the retained reference.
   * @param options - choices for the Session the connection creates or reuses,
   * plus the source Session whose Workspace selection this continues.
   * @returns completion; a superseded request may create a Session but does not open it.
   * @throws on failure; a refused creation is also shown through the Workspace
   * notice unless a later navigation or disposal superseded the request.
   */
  openWorkspace(
    workspaceId: WorkspaceId,
    beforeOpen?: (sessionId: SessionId) => void,
    options?: OpenWorkspaceOptions,
  ): Promise<void>
  /**
   * Fork a Session without changing the current selection.
   * @param sessionId - source Session.
   * @param onCreated - observer before the optional child-title update.
   * @param options - optional permission to start source migration; omission preserves the Host default.
   * @returns the child SessionId after creation and inherited-title increment.
   */
  forkSession(
    sessionId: SessionId,
    onCreated?: (childId: SessionId) => void,
    options?: Pick<Parameters<ISessions['fork']>[0], 'allowMigration'>,
  ): Promise<SessionId>
  /**
   * Resolve the Session for a new conversation in a Workspace: navigation names the first reusable
   * blank member — listed in the Workspace, not archived, and listing no preset or the requested one —
   * and the Host reuses it under the requested preset or its default, creating another Session when it
   * reuses none. Concurrent calls for the same Workspace and preset share one attempt.
   * @param workspaceId - target Workspace.
   * @param options - choices for the created or reused Session.
   * @returns a Session already addressable through the Session Controller.
   */
  connectWorkspace(workspaceId: WorkspaceId, options?: Pick<StartSessionOptions, 'agentPreset'>): Promise<SessionId>
  /**
   * Open the Workspace blank `connectWorkspace` resolves, so New Session returns to that blank's
   * unsent draft. A creation the Host refuses is shown through the Workspace notice and leaves the
   * selection as it was. With `options.operation`, the call reports its actual
   * outcome through the supplied callbacks instead of returning it: no target
   * Workspace keeps the call waiting on the native New Session page until a
   * Workspace is picked or a later navigation ends the wait.
   * @param workspaceId - explicit target; absent inherits the current or most recent Workspace.
   * @param options - initial content, the blank's preset, and `whenDraftExists`, which decides
   * whether existing text or attachments are kept, replaced, or followed by the prompt;
   * `operation` adds this call's policy, lifetime, preparation, and final-outcome callbacks.
   */
  startSession(workspaceId?: WorkspaceId, options?: StartSessionOptions): void
  /**
   * Archive a Session and clear it when it is the current selection.
   * @param sessionId - Session to archive.
   * @param options - `stopActivity` asks the Host to stop the Session's running work instead of refusing.
   */
  archiveSession(sessionId: SessionId, options?: { readonly stopActivity?: boolean }): Promise<void>
  /**
   * Unarchive a Session, restoring it to its recorded Workspace position.
   * @param sessionId - Session to unarchive.
   */
  unarchiveSession(sessionId: SessionId): Promise<void>
  /**
   * Pin a Session on the Host, then lead it in its accounts' saved orders
   * (its Workspace group or Ungrouped, and the flat list). The order write
   * reads the memberships current at completion, so reorders that landed
   * while the Host call was pending keep their positions.
   * @param sessionId - Session to pin.
   */
  pinSession(sessionId: SessionId): Promise<void>
  /**
   * Unpin a Session on the Host; saved positions stay as they are.
   * @param sessionId - Session to unpin.
   */
  unpinSession(sessionId: SessionId): Promise<void>
  /**
   * Open the Host-native directory picker.
   * @returns the selected directory, or null when cancelled.
   */
  pickDirectory(): Promise<string | null>
  /**
   * List one Host directory level.
   * @param path - directory path; absent selects the Host home.
   * @param signal - cancellation for a superseded scan.
   * @returns directory entries and breadcrumb ancestry.
   */
  listDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListing>
  /**
   * Create a child directory.
   * @param path - existing parent directory.
   * @param name - child directory name.
   * @returns created absolute path.
   */
  createDirectory(path: string, name: string): Promise<string>
  /**
   * Keep `callback`'s effects installed while the current Peer may call
   * `action` on one Workspace resource, with the semantics of
   * `ctx.remoteAccess.whenAccess`: `useWorkspaceAccess` answers the same
   * question during render.
   * @param workspaceId - the Workspace resource the guarded effects depend on.
   * @param action - endpoint action the guarded effects depend on.
   * @param callback - creates one disposer or an iterable of disposers.
   * @returns idempotent disposer owned by the caller's Cordis fiber.
   */
  whenAccess(workspaceId: WorkspaceId, action: RemoteEndpoint, callback: () => AccessEffect): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Cross-Controller Workspace navigation and directory UI capability. */
    uiWorkspace: UiWorkspace
  }
}

/** Structured directory failure exposed to directory UI consumers. */
export class DirectoryBrowseError extends Error {
  override readonly name = 'DirectoryBrowseError'

  /** @param rpcError - Host directory business failure. */
  constructor(readonly rpcError: RemoteFailure) {
    super(`directory browse failed: ${rpcError.code}: ${rpcError.message}`)
  }
}

/** Implements Workspace archive and directory UI operations. */
class UiWorkspaceService extends Service implements UiWorkspace {
  /**
   * The latest in-flight connection per Workspace and creation identity; a
   * request joins it only when both name the same preset. Ordinary calls share
   * one Workspace slot, while an operation shares only with its own policy and
   * operation identity.
   */
  private readonly connecting = new Map<string, {
    readonly agentPreset: string | undefined
    readonly attempt: Promise<SessionId>
  }>()
  private readonly lifetime = new AbortController()
  private readonly selection = createSnapshotStore<MainSelection>(
    {}, { persist: { name: 'dsh.sessions.current' } },
  )
  private mainReference: SessionReference | undefined
  private restorationNavigation: AbortSignal | undefined
  /** A New Session call waiting on the blank page for its Workspace. */
  private pending: PendingStartSession | undefined
  /** Calls whose final outcome was already delivered. */
  private readonly finishedOperations = new WeakSet<StartSessionOperation>()

  /**
   * @param ctx - Client root Context.
   * @param directoryPicker - the directory-picking Remote namespace.
   * @param workspaces - pure Workspace Controller.
   * @param sessions - pure Session Controller.
   * @param view - the browser's viewing-store write set (one instance shared with its registration).
   * @param notify - show one notice through the Workspace notice channel.
   */
  constructor(
    ctx: Context,
    private readonly directoryPicker: ClientRemote['directoryPicker'],
    private readonly workspaces: IWorkspaces,
    private readonly sessions: ISessions,
    private readonly view: Pick<WorkspaceViewStoreActions, 'pinSessionOrder'>,
    private readonly notify: (toast: RowToast) => void,
  ) {
    super(ctx, 'uiWorkspace')
    ctx.effect(() => {
      const stop = this.watchNavigation()
      return () => {
        stop()
        this.lifetime.abort()
        // The waiting caller is this Client module, which is releasing too:
        // drop the wait without entering its callbacks.
        const pending = this.pending
        this.pending = undefined
        pending?.detach()
        const reference = this.mainReference
        this.mainReference = undefined
        reference?.release()
      }
    }, 'ui-workspace: Workspace navigation policy')
  }

  connectWorkspace(workspaceId: WorkspaceId, options: Pick<StartSessionOptions, 'agentPreset'> = {}): Promise<SessionId> {
    return this.connectBlank(workspaceId, options)
  }

  /**
   * @param reuse - preset, reuse policy, and operation context for the reused
   *   or created blank.
   */
  private async connectBlank(
    workspaceId: WorkspaceId,
    reuse: CreationRequestOptions,
  ): Promise<SessionId> {
    const workspace = this.workspaces.list.getSnapshot().items
      .find(item => item.workspaceId === workspaceId)
    if (workspace === undefined) {
      throw new Error(`uiWorkspace.connectWorkspace: unknown workspace ${workspaceId}`)
    }
    // An operation with its own identity never joins another operation's
    // attempt; a repeated delivery of the same one does.
    const key = creationKey(workspaceId, reuse)
    const inflight = this.connecting.get(key)
    if (inflight !== undefined && inflight.agentPreset === reuse.agentPreset) return inflight.attempt

    const attempt = this.createInWorkspace(workspace, reuse).finally(() => {
      if (this.connecting.get(key)?.attempt === attempt) this.connecting.delete(key)
    })
    this.connecting.set(key, { agentPreset: reuse.agentPreset, attempt })
    return attempt
  }

  /** Name the first reusable member blank; a requested preset also skips blanks listing another preset. */
  private createInWorkspace(workspace: WorkspaceView, options: CreationRequestOptions): Promise<SessionId> {
    const archived = this.workspaces.list.getSnapshot().archivedSessionIds
    const sessions = this.sessions.list.getSnapshot()
    const blank = options.reuseBlank === false
      ? undefined
      : sessions.ids.find((id) => {
        const summary = sessions.byId[id]
        const listed = summary?.projectionValues?.agentPreset
        return summary !== undefined && summary.blank && summary.cwd === workspace.path
          && workspace.sessionIds.includes(id) && !archived.includes(id)
          && (options.agentPreset === undefined || typeof listed !== 'string' || listed === options.agentPreset)
      })
    return this.createNamed({
      workspaceId: workspace.workspaceId,
      ...(blank === undefined ? {} : { sessionId: blank }),
      ...(options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset }),
      ...(options.operation === undefined ? {} : { operation: options.operation }),
    })
  }

  /**
   * Create through the Host. A named blank the Host declined may still read as
   * blank from stale cached list metadata, which hides it from the Session tree;
   * its projections are reloaded so the row reflects its log.
   */
  private async createNamed(request: {
    readonly workspaceId: WorkspaceId
    readonly sessionId?: SessionId
    readonly agentPreset?: string
    readonly operation?: StartSessionCreateOperation
  }): Promise<SessionId> {
    const sessionId = await this.sessions.create(request)
    const named = request.sessionId
    if (named !== undefined && named !== sessionId) {
      void this.sessions.refreshProjections(named).catch((reason: unknown) => {
        console.warn('declined blank Session projection reload failed:', reason)
      })
    }
    return sessionId
  }

  /**
   * Reopen a saved blank Session under the preset its log recorded, continuing
   * its own creation-policy source identity.
   *
   * Listed values are cached hints that can lag the log after an unclean Host
   * exit, so the Session's projections are reloaded before the preset is read;
   * a Session that still awaits a format migration reloads only those cached
   * hints. Only the Host's own pre-create evidence may re-ask without the
   * recorded preset: a preset failure that lacks it may already have created a
   * Session and is never replayed.
   */
  private async restoreBlank(workspaceId: WorkspaceId, sessionId: SessionId): Promise<SessionId> {
    await this.sessions.refreshProjections(sessionId)
    const recorded = this.sessions.list.getSnapshot().byId[sessionId]?.projectionValues?.agentPreset
    // Naming the saved blank as the source keeps its creation policy: the Host
    // resolves that ownership and registers the reused blank under it. An
    // ordinary request would let the Host treat a policy-owned blank as an
    // ordinary candidate and create another Session beside it.
    const operation: StartSessionCreateOperation = {
      operationId: newOperationId(),
      kind: 'restore',
      sourceSessionId: sessionId,
    }
    const request = { workspaceId, sessionId, operation }
    if (typeof recorded !== 'string') return this.createNamed(request)
    try {
      return await this.createNamed({ ...request, agentPreset: recorded })
    } catch (error: unknown) {
      if (!confirmedPreCreatePresetRefusal(error)) throw error
      return this.createNamed(request)
    }
  }

  openSession(target: SessionTarget): void {
    // Opening another Session leaves the New Session page: a call still
    // waiting for a Workspace ends without creating anything.
    this.supersedePending()
    this.replaceMain(target, this.lifetime.signal, 'reveal')
  }

  /**
   * Connect a Workspace and open its Session, continuing an explicitly named
   * source Session's creation-policy identity into the picked Workspace.
   * @param workspaceId - target Workspace.
   * @param beforeOpen - optional synchronous preparation for the selected Session.
   * @param options - choices for the Session the connection creates or reuses,
   * plus the source Session that this pick continues.
   * @returns completion; a superseded request may create a Session but does not open it.
   */
  openWorkspace(
    workspaceId: WorkspaceId,
    beforeOpen?: (sessionId: SessionId) => void,
    options: OpenWorkspaceOptions = {},
  ): Promise<void> {
    const { sourceSessionId, ...reuse } = options
    // The source identity is explicit: the Host resolves its mode and
    // registers the new blank under the same policy. The native New Session
    // button does not pass a source, so it stays ordinary even while a
    // policy-owned Session is open.
    return this.openWorkspaceSession(workspaceId, beforeOpen, {
      ...reuse,
      ...(sourceSessionId === undefined ? {} : {
        operation: {
          operationId: newOperationId(),
          kind: 'workspace' as const,
          sourceSessionId,
        },
      }),
    })
  }

  /**
   * Create or reuse the Workspace's blank Session and open it.
   *
   * A New Session call that entered the blank page without a Workspace is
   * continued by the native Workspace pick that lands here: it keeps its
   * navigation lease, policy, and callbacks instead of becoming an ordinary
   * creation. Its callbacks receive the actual result, and a superseded
   * navigation only withdraws the automatic opening.
   */
  private async openWorkspaceSession(
    workspaceId: WorkspaceId,
    beforeOpen: ((sessionId: SessionId) => void) | undefined,
    reuse: CreationRequestOptions,
    operation?: StartSessionOperation,
  ): Promise<void> {
    const pending = operation === undefined ? this.takePending() : undefined
    const active = operation ?? pending?.operation
    const navigation = pending?.navigation
      ?? AbortSignal.any([this.ctx.layout.beginNavigation(), this.lifetime.signal])
    if (active === undefined) {
      let sessionId: SessionId
      try {
        sessionId = await this.connectBlank(workspaceId, reuse)
      } catch (error: unknown) {
        // Reported here, not in connectWorkspace: startup restoration calls that
        // directly and stays console-only.
        if (!navigation.aborted) this.notify({ kind: 'createFailed', message: creationFailureMessage(error) })
        throw error
      }
      if (navigation.aborted) return
      this.replaceMain(sessionId, navigation, 'reveal', beforeOpen)
      return
    }

    if (callerReleased(active)) {
      this.deliver(active, { kind: 'cancelled', reason: 'caller' })
      return
    }
    // The waiting call owns the Session it asked for; a native pick only
    // supplies the target Workspace. Adopting the pick's own choices would
    // silently drop the chosen preset and the explicit no-reuse intent.
    const creation = {
      ...(pending === undefined ? reuse : pending.creation),
      operation: operationContext(active, pending === undefined ? 'new' : 'workspace'),
    }
    let sessionId: SessionId
    try {
      sessionId = await this.connectBlank(workspaceId, creation)
    } catch (error: unknown) {
      const outcome = creationFailureOutcome(error, workspaceId)
      this.deliver(active, outcome)
      if (!navigation.aborted) this.notify({ kind: 'createFailed', message: outcome.message })
      throw error
    }

    if (callerReleased(active)) {
      // Created, but the caller released before preparation could start: the
      // actual identity is still reported, and nothing opens on its own.
      this.deliver(active, {
        kind: 'failed',
        stage: 'extension',
        message: this.ctx.locale.bind('workspace')('draft.callerReleased'),
        creation: 'known',
        sessionId,
        workspaceId,
      })
      return
    }
    if (active.prepareSession !== undefined) {
      try {
        await active.prepareSession({ sessionId, workspaceId })
      } catch (error: unknown) {
        this.deliver(active, {
          kind: 'failed',
          stage: 'extension',
          message: error instanceof Error ? error.message : String(error),
          creation: 'known',
          sessionId,
          workspaceId,
        })
        if (!navigation.aborted) this.notify({ kind: 'createFailed', message: creationFailureMessage(error) })
        return
      }
    }

    if (navigation.aborted || callerReleased(active)) {
      this.deliver(active, { kind: 'session', sessionId, workspaceId, navigation: 'superseded' })
      return
    }
    let committed: 'opened' | 'superseded'
    try {
      committed = this.replaceMain(sessionId, navigation, 'reveal', beforeOpen)
    } catch (error: unknown) {
      this.deliver(active, {
        kind: 'failed',
        stage: 'open',
        message: error instanceof Error ? error.message : String(error),
        creation: 'known',
        sessionId,
        workspaceId,
      })
      throw error
    }
    this.deliver(active, { kind: 'session', sessionId, workspaceId, navigation: committed })
  }

  /**
   * Deliver one outcome to its caller exactly once.
   *
   * A callback may be async even though the operation's result is already
   * settled: its rejection is contained as diagnostics and never re-runs the
   * creation or replaces the delivered outcome.
   * @param operation - the call's lifecycle.
   * @param outcome - final outcome to report.
   */
  private deliver(operation: StartSessionOperation, outcome: StartSessionOutcome): void {
    if (this.finishedOperations.has(operation)) return
    this.finishedOperations.add(operation)
    try {
      const settled = operation.onFinished?.(outcome)
      if (settled !== undefined) {
        void Promise.resolve(settled).catch((error: unknown) => {
          console.warn('new session outcome handler failed:', error)
        })
      }
    } catch (error: unknown) {
      console.warn('new session outcome handler failed:', error)
    }
  }

  /**
   * Keep a New Session call waiting on the native New Session page.
   * @param operation - the waiting call's lifecycle and callbacks.
   * @param creation - the waiting call's own preset and reuse intent, kept so
   * the native Workspace pick continues this call rather than an ordinary one.
   */
  private retainPending(
    operation: StartSessionOperation,
    creation: Pick<CreationRequestOptions, 'agentPreset' | 'reuseBlank'>,
  ): void {
    const navigation = this.ctx.layout.beginNavigation()
    const settle = (outcome: StartSessionOutcome): void => {
      // A nested New Session can install its own wait before this one's caller
      // aborts; only the current owner may clear it.
      if (this.pending?.operation !== operation) return
      this.pending = undefined
      detach()
      this.deliver(operation, outcome)
    }
    const onNavigation = (): void => { settle({ kind: 'cancelled', reason: 'superseded' }) }
    const onCaller = (): void => { settle({ kind: 'cancelled', reason: 'caller' }) }
    function detach(): void {
      navigation.removeEventListener('abort', onNavigation)
      operation.signal?.removeEventListener('abort', onCaller)
    }
    this.pending = { operation, creation, navigation, detach }
    navigation.addEventListener('abort', onNavigation, { once: true })
    operation.signal?.addEventListener('abort', onCaller, { once: true })
  }

  /** End a call still waiting for a Workspace because another flow started. */
  private supersedePending(): void {
    const pending = this.pending
    if (pending === undefined) return
    this.pending = undefined
    pending.detach()
    this.deliver(pending.operation, { kind: 'cancelled', reason: 'superseded' })
  }

  /** Adopt the waiting call, if any, into the Workspace pick that continues it. */
  private takePending(): PendingStartSession | undefined {
    const pending = this.pending
    if (pending === undefined) return undefined
    this.pending = undefined
    pending.detach()
    return pending
  }

  async forkSession(
    sessionId: SessionId,
    onCreated?: (childId: SessionId) => void,
    options?: Pick<Parameters<ISessions['fork']>[0], 'allowMigration'>,
  ): Promise<SessionId> {
    return this.sessions.fork({
      sessionId,
      increaseTitle: true,
      ...onCreated === undefined ? {} : { onCreated },
      ...options?.allowMigration === undefined ? {} : { allowMigration: options.allowMigration },
    })
  }

  startSession(workspaceId?: WorkspaceId, options?: StartSessionOptions): void {
    const { agentPreset, operation, ...draft } = options ?? {}
    const draftOptions = options === undefined ? undefined : draft
    const initializeDraft = draftOptions !== undefined && (draftOptions.prompt !== undefined
      || (draftOptions.whenDraftExists ?? (draftOptions.clearPreviousDraft === true ? 'replace' : 'keep')) === 'replace')
    const workspace = this.workspaces.list.getSnapshot()
    const sessions = this.sessions.list.getSnapshot()
    const current = this.mainReference?.sessionId
    const currentWorkspaceId = current === undefined
      ? undefined
      : workspace.items.find(item => item.sessionIds.includes(current))?.workspaceId
    const recent = workspace.phase === 'ready' && sessions.phase === 'ready'
      ? recentWorkspace(workspace.items, sessions.byId)
      : undefined
    const target = workspaceId ?? currentWorkspaceId ?? recent
    const prepareBeforeOpen = initializeDraft
      ? (id: SessionId): void => {
        const binding = this.sessions.binding(id)
        if (binding === undefined) this.draftPreparationFailed()
        this.prepareDraft(binding, draftOptions)
      }
      : undefined

    // Any explicit New Session request ends a previous call that is still
    // waiting on the blank page for a Workspace.
    this.supersedePending()

    if (operation !== undefined) {
      if (callerReleased(operation)) {
        this.deliver(operation, { kind: 'cancelled', reason: 'caller' })
        return
      }
      const creation: Pick<CreationRequestOptions, 'agentPreset' | 'reuseBlank'> = {
        ...(agentPreset === undefined ? {} : { agentPreset }),
        ...(operation.reuseBlank === false ? { reuseBlank: false } : {}),
      }
      if (target === undefined) {
        if (initializeDraft) {
          const message = this.ctx.locale.bind('workspace')('draft.workspaceRequired')
          this.notify({ kind: 'createFailed', message })
          this.deliver(operation, { kind: 'failed', stage: 'workspace', message, creation: 'none' })
          return
        }
        // No target yet: the native New Session page owns the choice, so this
        // call stays alive until that page produces a Workspace or its
        // navigation ends.
        this.clearMain()
        this.retainPending(operation, creation)
        return
      }
      const opening = this.openWorkspaceSession(target, prepareBeforeOpen, creation, operation)
      void opening.catch(
        (reason: unknown) => { console.warn('new session failed:', reason) },
      )
      return
    }

    if (target === undefined) {
      if (initializeDraft) {
        this.notify({ kind: 'createFailed', message: this.ctx.locale.bind('workspace')('draft.workspaceRequired') })
        return
      }
      this.clearMain()
      return
    }
    const opening = this.openWorkspace(target, prepareBeforeOpen, agentPreset === undefined ? {} : { agentPreset })
    void opening.catch(
      (reason: unknown) => { console.warn('new session failed:', reason) },
    )
  }

  private prepareDraft(binding: SessionBinding, options: DraftInitializationOptions): void {
    const conversation = this.ctx.get('conversation')
    if (conversation === undefined) this.draftPreparationFailed()
    if (conversation.input.requestDraftInitialization(binding, options) === 'blocked') this.draftPreparationFailed()
  }

  private draftPreparationFailed(): never {
    const message = this.ctx.locale.bind('workspace')('draft.initializationFailed')
    this.notify({ kind: 'createFailed', message })
    throw new Error(message)
  }

  async archiveSession(sessionId: SessionId, options: { readonly stopActivity?: boolean } = {}): Promise<void> {
    await this.workspaces.archiveSession(sessionId, options)
    if (this.mainReference?.sessionId === sessionId) this.clearMain()
  }

  async unarchiveSession(sessionId: SessionId): Promise<void> {
    await this.workspaces.unarchiveSession(sessionId)
  }

  async pinSession(sessionId: SessionId): Promise<void> {
    await this.workspaces.pinSession(sessionId)
    const { items, pinnedSessionIds, archivedSessionIds } = this.workspaces.list.getSnapshot()
    this.view.pinSessionOrder(
      sessionId,
      pinOrderAccounts(items, sessionId),
      pinOrderSource(items, this.sessions.list.getSnapshot(), { pinnedSessionIds, archivedSessionIds }),
    )
  }

  async unpinSession(sessionId: SessionId): Promise<void> {
    await this.workspaces.unpinSession(sessionId)
  }

  async pickDirectory(): Promise<string | null> {
    const result = await this.directoryPicker.pick()
    if (!result.ok) throw new Error(`directory picker failed: ${result.error.message}`)
    return result.value
  }

  async listDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListing> {
    const result = await this.directoryPicker.list(path, signal)
    if (!result.ok) throw new DirectoryBrowseError(result.error)
    return result.value
  }

  async createDirectory(path: string, name: string): Promise<string> {
    const result = await this.directoryPicker.createDirectory(path, name)
    if (!result.ok) throw new DirectoryBrowseError(result.error)
    return result.value
  }

  whenAccess(workspaceId: WorkspaceId, action: RemoteEndpoint, callback: () => AccessEffect): () => void {
    // `ctx.get` traces the service to the caller's Context, which then owns the controller.
    const access = this.ctx.get('remoteAccess')
    /* v8 ignore next -- this plugin injects remoteAccess, so the service is active while uiWorkspace is reachable. */
    if (access === undefined) throw new Error('ui-workspace: whenAccess requires the remoteAccess service')
    return access.whenResourceAccess('workspace', workspaceId, action, callback)
  }

  private watchNavigation(): () => void {
    let initial: 'waiting' | 'connecting' | 'done' = 'waiting'
    const reconcile = (): void => {
      if (this.lifetime.signal.aborted) return
      if (this.clearArchivedCurrent()) return
      if (initial !== 'waiting' || this.restorationNavigation?.aborted === true) return
      const workspace = this.workspaces.list.getSnapshot()
      const sessions = this.sessions.list.getSnapshot()
      if (workspace.phase !== 'ready' || sessions.phase !== 'ready') return
      if (this.mainReference !== undefined) {
        initial = 'done'
        return
      }
      initial = 'connecting'
      void this.restoreSelection(workspace, sessions).then(
        () => { initial = 'done' },
        (reason: unknown) => {
          if (this.lifetime.signal.aborted) return
          initial = 'waiting'
          console.warn('initial Session restoration failed:', reason)
        },
      )
    }

    const disposeWorkspaces = this.workspaces.list.subscribe(reconcile)
    const disposeSessions = this.sessions.list.subscribe(reconcile)
    reconcile()
    return () => {
      this.lifetime.abort()
      disposeSessions()
      disposeWorkspaces()
    }
  }

  private async restoreSelection(workspaces: WorkspaceSnapshot, sessions: SessionListState): Promise<void> {
    const saved = this.selection.getSnapshot()
    if (saved.subagentAddress !== undefined) {
      this.replaceMain(saved.subagentAddress, this.lifetime.signal, 'preserve')
      return
    }
    const summary = saved.sessionId === undefined ? undefined : sessions.byId[saved.sessionId]
    const workspace = summary === undefined ? undefined
      : workspaces.items.find(item => item.sessionIds.includes(summary.id))
    if (summary !== undefined && (!summary.blank || workspace === undefined)) {
      this.replaceMain(summary.id, this.lifetime.signal, 'preserve')
      return
    }
    const navigation = AbortSignal.any([this.ctx.layout.beginNavigation(), this.lifetime.signal])
    this.restorationNavigation = navigation
    let sessionId: SessionId | undefined
    if (summary !== undefined && workspace !== undefined && summary.cwd === workspace.path
      && !workspaces.archivedSessionIds.includes(summary.id)) {
      sessionId = await this.restoreBlank(workspace.workspaceId, summary.id)
    }
    let target = workspace?.workspaceId ?? recentWorkspace(workspaces.items, sessions.byId)
    if (target === undefined && workspaces.items.length === 0 && sessions.ids.length === 0) {
      const prepared = await this.initializeDefaultWorkspace(navigation)
      if (navigation.aborted) return
      target = prepared?.workspaceId
    }
    if (sessionId === undefined && target !== undefined) sessionId = await this.connectWorkspace(target)
    if (sessionId !== undefined && !navigation.aborted) {
      this.replaceMain(sessionId, navigation, 'preserve')
    }
  }

  private async initializeDefaultWorkspace(signal: AbortSignal): Promise<WorkspaceView | undefined> {
    try {
      return await this.workspaces.initializeDefault(signal)
    } catch (_error: unknown) {
      if (!signal.aborted) this.notify({ kind: 'defaultWorkspaceFailed' })
      return undefined
    }
  }

  /** @returns true when an archived current selection was cleared. */
  private clearArchivedCurrent(): boolean {
    const current = this.mainReference?.sessionId
    if (current === undefined
      || !this.workspaces.list.getSnapshot().archivedSessionIds.includes(current)) return false
    this.clearMain()
    return true
  }

  private clearMain(): void {
    const previous = this.mainReference
    this.mainReference = undefined
    this.selection.set({})
    previous?.release()
    this.ctx.layout.selectPanel(null)
  }

  /**
   * Commit one main selection, releasing a retained reference the caller's
   * preparation superseded.
   *
   * The result is decided at the commit point. A reveal ends the navigation
   * lease through the native panel selection, so a signal read after this call
   * returns cannot tell an opening from a supersession.
   * @param target - Session or addressed child to display.
   * @param signal - navigation lease this selection belongs to.
   * @param panel - whether the commit also reveals the Conversation.
   * @param beforeOpen - synchronous preparation after the reference is retained.
   * @returns `opened` when this call displayed the Session, `superseded` when
   * preparation or an earlier cancellation released it first.
   */
  private replaceMain(
    target: SessionTarget,
    signal: AbortSignal,
    panel: 'reveal' | 'preserve',
    beforeOpen?: (sessionId: SessionId) => void,
  ): 'opened' | 'superseded' {
    signal.throwIfAborted()
    const reference = this.sessions.retain(target, { source: 'mainView' })
    try {
      signal.throwIfAborted()
      beforeOpen?.(reference.sessionId)
      if (signal.aborted) {
        reference.release()
        return 'superseded'
      }
      const subagentAddress = typeof target === 'string'
        ? this.sessions.subagentAddress(reference.sessionId)
        : target
      this.selection.set({
        sessionId: reference.sessionId,
        ...(subagentAddress === undefined ? {} : { subagentAddress }),
      })
    } catch (error: unknown) {
      reference.release()
      throw error
    }
    const previous = this.mainReference
    this.mainReference = reference
    previous?.release()
    if (panel === 'reveal') this.ctx.layout.selectPanel(null)
    return 'opened'
  }

}

/**
 * `error` as the Session Controller's creation failure, or undefined when it
 * is not one. Client plugin bundles do not share error-class identity, so the
 * name decides.
 */
function sessionCreateErrorOf(error: unknown): SessionCreateError | undefined {
  return error instanceof Error && error.name === 'SessionCreateError' ? error as SessionCreateError : undefined
}

/**
 * Whether a failed restore proves, by the Host's own evidence, that the preset
 * refused the attempt before any Session was created.
 *
 * The Controller's stage record, not the failure code, decides this: it
 * attaches `creation: 'none'` only when the attempt ended before a call that
 * could materialize a Session. A preset failure without that marker may have
 * persisted a Session and must never be replayed on an assumption.
 * @param error - the failed creation attempt.
 * @returns true only for a preset refusal carrying the pre-create marker.
 */
function confirmedPreCreatePresetRefusal(error: unknown): boolean {
  const failure = sessionCreateErrorOf(error)?.rpcError
  if (failure === undefined) return false
  if (failure.code !== 'agent-preset/not-found' && failure.code !== 'agent-preset/invalid') return false
  return 'creation' in failure.details && failure.details.creation === 'none'
}

/**
 * The words a failed Session creation is reported in: a Host refusal keeps its
 * stable code and message; any other failure keeps its own message.
 */
function creationFailureMessage(error: unknown): string {
  const refused = sessionCreateErrorOf(error)
  if (refused !== undefined) return `${refused.rpcError.code}: ${refused.rpcError.message}`
  return error instanceof Error ? error.message : String(error)
}

/**
 * Map a creation failure onto this call's outcome, keeping the actual Session
 * when the failure proves one exists.
 * @param error - the failed creation attempt.
 * @param workspaceId - the Workspace this call targeted.
 * @returns a failure outcome carrying creation knowledge and stage.
 */
function creationFailureOutcome(error: unknown, workspaceId: WorkspaceId): Extract<StartSessionOutcome, { kind: 'failed' }> {
  const message = creationFailureMessage(error)
  const failure = sessionCreateErrorOf(error)?.rpcError
  const target = { workspaceId }
  if (failure === undefined) {
    return { kind: 'failed', stage: 'create', message, creation: 'unknown', ...target }
  }
  // The Host's stage record, not the code, decides whether a preset refusal
  // ended before anything could be created; the same code without it may have
  // persisted a Session and stays unknown below.
  if (confirmedPreCreatePresetRefusal(error)) {
    return { kind: 'failed', stage: 'create', message, creation: 'none', ...target }
  }
  switch (failure.code) {
    case 'session/workspace-attach-failed':
      return {
        kind: 'failed',
        stage: 'create',
        message,
        creation: 'known',
        sessionId: failure.details.sessionId,
        ...target,
      }
    case 'session/policy-prepare-failed':
      return {
        kind: 'failed',
        stage: 'prepare',
        message,
        creation: 'known',
        sessionId: failure.details.sessionId,
        ...target,
      }
    case 'session/policy-unavailable':
    case 'session/source-not-policy':
    case 'session/policy-source-unknown':
    case 'session/policy-conflict':
    case 'session/policy-begin-failed':
      return { kind: 'failed', stage: 'policy', message, creation: 'none', ...target }
    case 'gateway/bad-request':
    case 'workspace/not-found':
      return { kind: 'failed', stage: 'create', message, creation: 'none', ...target }
    default:
      // A preset failure can arrive after the Session was persisted, so one
      // that carries no pre-create marker proves neither creation nor its
      // absence; the same holds for every transport failure.
      return { kind: 'failed', stage: 'create', message, creation: 'unknown', ...target }
  }
}

/** Whether this call's caller lifetime already ended. */
function callerReleased(operation: StartSessionOperation): boolean {
  return operation.signal?.aborted === true
}

/** Host request fields for one call's policy operation. */
function operationContext(
  operation: StartSessionOperation,
  kind: StartSessionCreateOperation['kind'],
): StartSessionCreateOperation {
  return {
    operationId: operation.operationId ?? newOperationId(),
    kind,
    ...(operation.policyId === undefined ? {} : { policyId: operation.policyId }),
    ...(operation.reuseBlank === false ? { reuseBlank: false } : {}),
  }
}

/** One caller-minted operation identity. */
function newOperationId(): SessionOperationId {
  return brandString<SessionOperationId>(randomUUID())
}

/**
 * In-flight key: ordinary calls share per Workspace; operations share per
 * Workspace, policy, and operation identity, mirroring the Host's own key. An
 * operation id that happens to read `native` therefore never joins an ordinary
 * connection.
 */
function creationKey(workspaceId: WorkspaceId, reuse: CreationRequestOptions): string {
  const operation = reuse.operation
  const identity = operation === undefined
    ? 'ordinary'
    : `operation\u0000${operation.policyId ?? ''}\u0000${operation.operationId}`
  return `${workspaceId}\u0000${identity}`
}

/** Stable tie-breaking follows Host Workspace order. */
function recentWorkspace(
  workspaces: readonly WorkspaceView[],
  sessions: SessionListState['byId'],
): WorkspaceId | undefined {
  let selected: WorkspaceId | undefined
  let selectedTime = Number.NEGATIVE_INFINITY
  for (const workspace of workspaces) {
    let latest = Number.NEGATIVE_INFINITY
    for (const sessionId of workspace.sessionIds) {
      const session = sessions[sessionId]
      if (session !== undefined) latest = Math.max(latest, session.updatedAt)
    }
    if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(workspace.createdAt)
    if (selected === undefined || latest > selectedTime) {
      selected = workspace.workspaceId
      selectedTime = latest
    }
  }
  return selected
}

export { UiWorkspaceService }
