import { Service, type Context } from '@deepseek-ai/cordis'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import type { SubagentCatalogEntry } from '@deepseek-ai/dsh-subagent/client'

/** Presentation classes a business plugin can assign to native catalog entries. */
export type SubagentCatalogClassification = ReadonlyMap<SessionId, 'support'>

/** Native facts one classifier may use; identity is the durable Session id. */
export interface SubagentCatalogEntryFacts {
  readonly id: SessionId
  readonly mode: SubagentCatalogEntry['mode']
  readonly activity: 'running' | 'inactive'
}

/** One parent catalog offered to the classifier. */
export interface SubagentCatalogClassificationInput {
  readonly parentSessionId: SessionId
  readonly entries: readonly SubagentCatalogEntryFacts[]
}

/** Business-owned classification for one parent's native catalog. */
export interface SubagentCatalogClassifier {
  /**
   * Classify entries whose alternative entry is reachable.
   * @param input - actual parent identity and the complete native entries.
   * @returns classifications to split out, or undefined while unavailable.
   */
  readonly classify: (input: SubagentCatalogClassificationInput) => SubagentCatalogClassification | undefined
  /** Source whose change republishes the menu's classification. */
  readonly revision: HostObservable<number>
}

/** One registered classifier with its stable registration identity. */
export interface SubagentCatalogClassifierContribution extends SubagentCatalogClassifier {
  readonly id: string
}

interface Registration {
  readonly contribution: SubagentCatalogClassifierContribution
  readonly unsubscribe: () => void
}

/**
 * Root service owning subagent-menu classification contributions.
 *
 * The native catalog remains the only source of parent/child identity, mode,
 * and order; classifiers only decide which native entries a business surface
 * already offers elsewhere. A missing or unavailable classification leaves the
 * native rows untouched.
 */
export class SubagentCatalogPresentation extends Service {
  private readonly registrations = new Map<string, Registration>()
  private readonly listeners = new Set<() => void>()
  private version = 0
  /** Source that changes whenever a classifier or its own evidence changes. */
  readonly revision: HostObservable<number> = {
    getSnapshot: () => this.version,
    subscribe: (listener) => {
      this.listeners.add(listener)
      return () => { this.listeners.delete(listener) }
    },
  }

  /** @param ctx - owning Client context. */
  constructor(ctx: Context) {
    super(ctx, 'subagentMenu')
  }

  /**
   * Register one classifier for the caller's lifetime.
   * @param contribution - stable id, pure classifier, and evidence source.
   * @returns idempotent disposer that restores every native row.
   */
  register(contribution: SubagentCatalogClassifierContribution): () => void {
    if (contribution.id.trim() === '') {
      throw new Error('subagentMenu.register: classifier id must be non-empty')
    }
    if (this.registrations.has(contribution.id)) {
      throw new Error(`subagentMenu.register: classifier "${contribution.id}" is already registered`)
    }
    const dispose = this.ctx.effect(() => {
      const unsubscribe = contribution.revision.subscribe(() => { this.bump() })
      this.registrations.set(contribution.id, { contribution, unsubscribe })
      this.bump()
      return () => {
        const current = this.registrations.get(contribution.id)
        if (current?.contribution !== contribution) return
        // Withdraw the classifier before any publisher cleanup, so a throwing
        // unsubscribe cannot leave a dead contribution filtering native rows.
        this.registrations.delete(contribution.id)
        try {
          unsubscribe()
        } catch (error: unknown) {
          this.ctx.logger.warn('subagentMenu: classifier "%s" did not release its evidence source', contribution.id)
          this.ctx.logger.warn(error)
        } finally {
          this.bump()
        }
      }
    }, `subagentMenu.register(${JSON.stringify(contribution.id)})`)
    return () => { void dispose() }
  }

  /**
   * Merge every live classifier's answer in registration order.
   *
   * A classifier that throws — while computing or while returning an
   * unreadable answer — is unavailable for this render and contributes
   * nothing, so its entries keep their native rows instead of hiding the menu
   * or failing the render.
   * @param input - actual parent and complete native entries.
   * @returns classifications from the first classifier that names each entry.
   */
  classify(input: SubagentCatalogClassificationInput): SubagentCatalogClassification {
    const classified = new Map<SessionId, 'support'>()
    for (const { contribution } of this.registrations.values()) {
      // Read the complete answer before merging, so an answer that throws
      // halfway through iteration contributes nothing instead of a half result.
      let entries: readonly (readonly [SessionId, 'support'])[] | undefined
      try {
        const result = contribution.classify(input)
        if (result === undefined) continue
        entries = [...result]
      } catch (error: unknown) {
        this.ctx.logger.warn('subagentMenu: classifier "%s" failed; keeping native rows', contribution.id)
        this.ctx.logger.warn(error)
        continue
      }
      for (const [id, value] of entries) {
        if (!classified.has(id)) classified.set(id, value)
      }
    }
    return classified
  }

  private bump(): void {
    this.version += 1
    notifySubscribers(this.listeners, '[ui-subagent] catalog classification')
  }
}
