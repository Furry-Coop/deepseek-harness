// Web e2e: two narrow Host seams for Nodes issue #18.
//
// A: a business card registers one stable id plus a durable Turn anchor; the
// Chat target mounts it into the real row sequence, keeps it at the running
// Turn's start entry, and moves it to the real `turn/end` tail. Scoped to the
// displayed Session, it disappears on withdrawal and does not mount in a fork.
// B: the native subagent catalog menu applies a business classification to its
// rows, totals, running count, and empty state while keeping the complete
// native catalog for lineage and addresses.
//
// The suite is self-contained: fixtures are seeded through Session and a
// Nodes-independent fixture plugin supplies the cards and classifiers. Two
// cross-repository inputs are opt-in and never auto-discovered:
// `NODES_REPO` mounts the real Nodes package (that suite skips without it) and
// `ISSUE18_CAPTURE` replays an externally captured process-submit Session
// instead of the generated fixture.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { FiberState } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { SessionOperationId } from '@deepseek-ai/dsh-api-session-controller'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage, LlmAdapter, ToolCallId,
  type GenerateOptions, type LlmModelInfo, type LlmProviderInfo, type LlmResolvedModelInfo, type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId, type SessionEvent, type SessionId as SessionIdValue } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import type { WorkspaceId as WorkspaceIdValue } from '@deepseek-ai/dsh-workspace'
import { createChatScrollFixture } from './chat-scroll-fixture.ts'
import {
  launchWebScaffold, readPersistedEvents, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const FIXTURE = fileURLToPath(new URL('./fixtures/plugins/fixture-issue18-probe', import.meta.url))
const PROVIDER = 'web-issue18-probe'
const MODEL = 'probe'
const LIVE_ID = 'issue18-probe-live'
const FIRST_PROMPT = 'ISSUE18_PROBE_FIRST_PROMPT'
const SECOND_PROMPT = 'ISSUE18_PROBE_SECOND_PROMPT'
const FIRST_REPLY = 'PROBE_FIRST_REPLY'
const SECOND_REPLY = 'PROBE_SECOND_REPLY'
const HISTORY_ID = 'issue18-probe-history'
const HISTORY_TURNS = 40
const HISTORY_FIXTURE = createChatScrollFixture({
  markerPrefix: 'ISSUE18H',
  title: 'ISSUE18_PROBE_HISTORY',
  turns: HISTORY_TURNS,
})
/** Separate paged Session, so the reader-position scenario keeps its own window. */
const PAGING_ID = 'issue18-probe-paging'
const PAGING_TURNS = 40
const PAGING_FIXTURE = createChatScrollFixture({
  markerPrefix: 'ISSUE18P',
  title: 'ISSUE18_PROBE_PAGING',
  turns: PAGING_TURNS,
})
/** Externally captured `nodes_extraction_submit(kind:'process')` Session JSONL, when supplied. */
const PROCESS_CAPTURE: string | undefined = process.env.ISSUE18_CAPTURE
const PROCESS_ANCHOR_EVIDENCE_PATH = fileURLToPath(
  new URL('../../../.artifacts/issue18-process-anchor-evidence.json', import.meta.url),
)
const ANCHOR_ID = 'issue18-probe-process-anchor'
const ANCHOR_TURN = 8
/** Closed synthetic seed with one step carrying two bash calls in one process group. */
const ANCHOR_FIXTURE = createChatScrollFixture({
  markerPrefix: 'ISSUE18A',
  title: 'ISSUE18_PROBE_PROCESS_ANCHOR',
  turns: ANCHOR_TURN,
})

/** Fields supplied by the Nodes main-submission capture. */
interface ProcessSubmitCapture {
  readonly log: string
  readonly turn: number
  readonly step: number
  readonly callId: string
  readonly callSeq: number
  readonly resultSeq: number
  readonly submissionId: string
  readonly revision: number | string
  readonly sessionId: string
}

/** Measured process-call anchor target and its neighbours. */
interface AnchorRect {
  readonly top: number
  readonly left: number
  readonly width: number
  readonly height: number
  readonly bottom: number
  readonly right: number
  readonly visible: boolean
}

interface AnchorRow {
  readonly kind: string
  readonly label: string
  readonly rect: AnchorRect
}

/** One call row in the same Turn, measured against the card. */
interface MeasuredTool {
  readonly callId: string
  readonly label: string
  readonly rect: AnchorRect
  readonly beforeCard: boolean
  readonly gapToCard: number | null
  readonly insideGroup: boolean
}

interface ProcessAnchorScene {
  readonly card: (AnchorRect & {
    readonly site: string | null
    readonly turn: string | null
    readonly seq: string | null
    readonly label: string
  }) | null
  readonly tool: AnchorRow | null
  readonly tools: readonly MeasuredTool[]
  readonly nearestTool: MeasuredTool | null
  readonly group: (AnchorRect & { readonly key: string | null; readonly label: string }) | null
  readonly groupCollapsed: boolean
  readonly previousRoot: AnchorRow | null
  readonly nextRoot: AnchorRow | null
  readonly roots: readonly (AnchorRow & { readonly index: number })[]
  readonly rootCount: number
  readonly cardRootIndex: number | null
  readonly groupRootIndex: number | null
  readonly cardInsideGroup: boolean
  readonly cardInTargetToolSeat: boolean
  readonly cardInGroupBody: boolean
  readonly cardAtGroupEntry: boolean
  readonly cardInTurnEntry: boolean
  readonly cardSeatKind: string | null
  readonly toolBeforeCard: boolean
  readonly toolToCardGap: number | null
  readonly groupToCardGap: number | null
  readonly cardToNextRootGap: number | null
  readonly precise: boolean
}

/** One resolved process-submit target and the seed identity it came from. */
interface ProcessAnchorSetup {
  readonly sessionId: SessionIdValue
  readonly turn: number
  readonly step: number
  readonly callId: string
  readonly toolCallIds: readonly string[]
  readonly query: string
  readonly source: 'capture' | 'fixture'
  /** Sequence in the re-seeded Session; seedSession re-materializes seq/time. */
  readonly seededCallSeq: number
  readonly seededResultSeq: number | undefined
  readonly capture: ProcessSubmitCapture | undefined
}

/**
 * Read an explicitly supplied process-submit capture.
 * @returns validated capture fields, or undefined when `ISSUE18_CAPTURE` is unset.
 */
function readProcessCapture(): ProcessSubmitCapture | undefined {
  if (PROCESS_CAPTURE === undefined || !existsSync(PROCESS_CAPTURE)) return undefined
  const value = JSON.parse(readFileSync(PROCESS_CAPTURE, 'utf8')) as Partial<ProcessSubmitCapture>
  if (typeof value.log !== 'string' || value.log.trim() === '') {
    throw new Error('issue18 process capture: log must be a non-empty JSONL string')
  }
  if (typeof value.sessionId !== 'string' || value.sessionId.trim() === '') {
    throw new Error('issue18 process capture: sessionId is required')
  }
  if (typeof value.callId !== 'string' || value.callId.trim() === '') {
    throw new Error('issue18 process capture: callId is required')
  }
  if (typeof value.turn !== 'number' || typeof value.step !== 'number'
    || typeof value.callSeq !== 'number' || typeof value.resultSeq !== 'number'
    || typeof value.submissionId !== 'string' || (typeof value.revision !== 'number' && typeof value.revision !== 'string')) {
    throw new Error('issue18 process capture: turn/step/callSeq/resultSeq/submissionId/revision must be present')
  }
  return value as ProcessSubmitCapture
}

/** First non-empty user prompt text, used only to search the seeded Session. */
function firstUserText(events: readonly SessionEvent[]): string {
  for (const event of events) {
    if (event.type !== 'user/message') continue
    for (const block of event.data.content) {
      if (block.type === 'text' && block.text.trim() !== '') return block.text
    }
  }
  throw new Error('issue18 process capture: no user message text found')
}

/** A search-safe prefix of the captured prompt. */
function searchablePrompt(prompt: string): string {
  const line = prompt.split(/\r?\n/u).find(candidate => candidate.trim() !== '') ?? prompt
  const trimmed = line.trim()
  if (trimmed === '') throw new Error('issue18 process capture: empty prompt')
  return trimmed.slice(0, 48)
}

/**
 * Measure the card against the exact call row, every other call row in the
 * same Turn, the owning process group, and the next root row.
 * @param page - page displaying the seeded Session.
 * @param input - card id, target call id, and all call ids in the Turn.
 * @returns measured DOM and vertical relations.
 */
async function measureProcessAnchor(
  page: Page,
  input: { readonly cardId: string; readonly callId: string; readonly toolCallIds: readonly string[] },
): Promise<ProcessAnchorScene> {
  return page.evaluate(({ cardId, callId, toolCallIds }) => {
    const rectOf = (element: HTMLElement): AnchorRect => {
      const rect = element.getBoundingClientRect()
      return {
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        bottom: rect.bottom,
        right: rect.right,
        visible: element.getClientRects().length > 0
          && getComputedStyle(element).display !== 'none'
          && getComputedStyle(element).visibility !== 'hidden',
      }
    }
    const labelOf = (element: HTMLElement): string => (
      element.getAttribute('aria-label') ?? element.textContent ?? ''
    ).replace(/\s+/gu, ' ').trim().slice(0, 160)
    const describe = (element: HTMLElement): AnchorRow => ({
      kind: element.getAttribute('data-chat-flow-kind')
        ?? (element.hasAttribute('data-chat-group-key') ? 'group' : 'unknown'),
      label: labelOf(element),
      rect: rectOf(element),
    })
    const card = document.querySelector(`[data-chat-attachment="${cardId}"]`)
    if (!(card instanceof HTMLElement)) {
      return {
        card: null, tool: null, tools: [], nearestTool: null, group: null,
        groupCollapsed: false, previousRoot: null, nextRoot: null,
        roots: [] as readonly (AnchorRow & { readonly index: number })[],
        rootCount: 0, cardRootIndex: null, groupRootIndex: null,
        cardInsideGroup: false, cardInTargetToolSeat: false, cardInGroupBody: false,
        cardAtGroupEntry: false, cardInTurnEntry: false, cardSeatKind: null,
        toolBeforeCard: false, toolToCardGap: null,
        groupToCardGap: null, cardToNextRootGap: null, precise: false,
      } satisfies ProcessAnchorScene
    }
    const cardRow = card.closest<HTMLElement>('[data-chat-attachment-row]')
    const parent = cardRow?.parentElement ?? null
    const roots = parent === null
      ? []
      : [...parent.children].filter((element): element is HTMLElement => (
        element instanceof HTMLElement
          && (element.hasAttribute('data-chat-flow-key') || element.hasAttribute('data-chat-group-key')
            || element.hasAttribute('data-chat-attachment-row'))
      ))
    const cardIndex = cardRow === null ? -1 : roots.indexOf(cardRow)
    const previousRoot = cardIndex > 0 ? describe(roots[cardIndex - 1] as HTMLElement) : null
    const nextRootElement = cardIndex >= 0 ? roots[cardIndex + 1] : undefined
    const nextRoot = nextRootElement instanceof HTMLElement ? describe(nextRootElement) : null
    const cardRect = rectOf(card)
    const tools: MeasuredTool[] = []
    for (const toolCallId of toolCallIds) {
      const candidate = document.querySelector(`[data-chat-call-id="${toolCallId}"]`)
      if (!(candidate instanceof HTMLElement)) continue
      const rect = rectOf(candidate)
      tools.push({
        callId: toolCallId,
        label: labelOf(candidate),
        rect,
        beforeCard: (candidate.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
        gapToCard: Math.round(cardRect.top - rect.bottom),
        insideGroup: candidate.closest('[data-chat-group-key]') !== null,
      })
    }
    const targetCandidate = document.querySelector(`[data-chat-call-id="${callId}"]`)
    const tool = targetCandidate instanceof HTMLElement ? describe(targetCandidate) : null
    const nearestTool = tools
      .filter(candidate => candidate.gapToCard !== null)
      .sort((left, right) => Math.abs(left.gapToCard ?? Number.POSITIVE_INFINITY)
        - Math.abs(right.gapToCard ?? Number.POSITIVE_INFINITY))[0] ?? null
    const groupElement = targetCandidate instanceof HTMLElement
      ? targetCandidate.closest('[data-chat-group-key]')
      : null
    const group = groupElement instanceof HTMLElement
      ? {
        ...rectOf(groupElement),
        key: groupElement.getAttribute('data-chat-group-key'),
        label: labelOf(groupElement),
      }
      : null
    const groupRootIndex = groupElement instanceof HTMLElement ? roots.indexOf(groupElement) : null
    const cardInsideGroup = groupElement instanceof HTMLElement && groupElement.contains(cardRow)
    const cardSeat = cardRow?.parentElement?.closest('[data-chat-flow-kind]') ?? null
    const targetSeat = targetCandidate instanceof HTMLElement
      ? targetCandidate.closest('[data-chat-flow-kind="tool-call"]')
      : null
    const cardToolSeat = cardRow?.parentElement?.closest('[data-chat-flow-kind="tool-call"]') ?? null
    const cardInTargetToolSeat = cardToolSeat !== null && targetSeat !== null && cardToolSeat === targetSeat
    const cardInGroupBody = cardRow?.closest('[data-step-process-body]') !== null
    const cardInTurnEntry = cardRow?.closest('[data-chat-flow-kind="turn-process"]') !== null
    // "Group entry" means the target row's OWN group, before its body: a card
    // at some other group's header would not satisfy this.
    const cardAtGroupEntry = cardInsideGroup && !cardInGroupBody
    const cardSeatKind = cardSeat === null ? null : cardSeat.getAttribute('data-chat-flow-kind')
    const toolBeforeCard = targetCandidate instanceof HTMLElement
      && (targetCandidate.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    const toolToCardGap = tool === null ? null : Math.round(cardRect.top - tool.rect.bottom)
    const groupToCardGap = group === null ? null : Math.round(cardRect.top - group.bottom)
    const cardToNextRootGap = nextRoot === null ? null : Math.round(nextRoot.rect.top - cardRect.bottom)
    const within = (gap: number | null): boolean => gap !== null && gap >= -4 && gap <= 24
    const rootsAround = roots.slice(Math.max(0, cardIndex - 6), cardIndex + 7)
      .map((element, offset) => ({
        ...describe(element),
        index: Math.max(0, cardIndex - 6) + offset,
      }))
    return {
      card: {
        ...cardRect,
        site: card.getAttribute('data-chat-attachment-site'),
        turn: card.getAttribute('data-chat-attachment-turn'),
        seq: card.getAttribute('data-chat-attachment-seq'),
        label: labelOf(card),
      },
      tool,
      tools,
      nearestTool,
      group,
      groupCollapsed: group !== null && group.height === 0,
      previousRoot,
      nextRoot,
      roots: rootsAround,
      rootCount: roots.length,
      cardRootIndex: cardIndex >= 0 ? cardIndex : null,
      groupRootIndex,
      cardInsideGroup,
      cardInTargetToolSeat,
      cardInGroupBody,
      cardAtGroupEntry,
      cardInTurnEntry,
      cardSeatKind,
      toolBeforeCard,
      toolToCardGap,
      groupToCardGap,
      cardToNextRootGap,
      precise: cardInTargetToolSeat && toolBeforeCard && within(toolToCardGap),
    } satisfies ProcessAnchorScene
  }, input)
}

/** One card registration passed to the fixture plugin. */
interface ProbeCard {
  id: string
  sessionId: string
  side: 'left' | 'right'
  anchor:
    | { kind: 'turn-start' | 'turn-end'; turn: number }
    | { kind: 'event'; turn: number; seq: number }
    | { kind: 'tool-call'; turn: number; callId: string }
  presentation?: 'auto' | 'inline'
}

/** Fixture-registered browser API used only by this scenario. */
interface ProbeApi {
  registerChatAttachment(card: ProbeCard): string
  disposeChatAttachment(id: string): boolean
  setClassification(value: {
    parentSessionId: string
    supportIds?: readonly string[]
    unavailable?: boolean
  }): void
  withdrawClassification(): void
  getClassificationState(): {
    parentSessionId: string | undefined
    support: string[]
    unavailable: boolean
    classified: string[]
  }
  getLastCatalogEntries(): readonly { id: string; mode: string; activity: string }[]
}

declare global {
  interface Window {
    __issue18Probe: ProbeApi
  }
}

// Cross-repository integration probe. The real Nodes checkout is supplied by
// `NODES_REPO`; without it this suite skips instead of assuming a machine-local
// adjacent checkout.
const NODES_REPO = process.env.NODES_REPO
const REAL_NODES_ID = 'issue18-real-nodes'
const REAL_NODES_PROVIDER = 'nodes-scripted'
const REAL_NODES_PROMPT = 'ISSUE18_REAL_NODES_PROCESS'
const REAL_NODES_SOURCES_CALL = ToolCallId('call-real-sources')
const REAL_NODES_PROCESS_CALL = ToolCallId('call-real-process')
const REAL_NODES_EVIDENCE_PATH = fileURLToPath(
  new URL('../../../.artifacts/issue18-real-nodes-active-evidence.json', import.meta.url),
)
const NODES_PACKAGE_NAME = '@nodes/dsh-plugin'
const NODES_POLICY_ID = '@nodes/dsh-plugin:conversation'

/** Shared route surface for the controlled probe models. */
abstract class ProbeLlmAdapter extends LlmAdapter {
  protected releaseHeld: (() => void) | undefined

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Issue 18 probe' }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider, id: MODEL, name: 'Probe' }])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, contextWindow: 128_000 })
  }

  release(): void {
    const release = this.releaseHeld
    this.releaseHeld = undefined
    release?.()
  }
}

/** Text response chunks for controlled model calls. */
function textResponseChunks(text: string): readonly StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** One tool-call response for controlled model calls. */
function toolCallChunks(id: ToolCallId, name: string, args: string): readonly StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** Concatenate text blocks in one tool result message. */
function messageText(message: { readonly content?: readonly { readonly type?: string; readonly text?: string }[] } | undefined): string {
  if (message?.content === undefined) return ''
  return message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
}

/**
 * Hold one controlled model request until its own gate releases; a canceled
 * turn rejects instead of leaving a permanently pending generator.
 * @param signal - the request's turn signal.
 * @param assign - installs the release action for this hold.
 * @returns settles on release, rejects on abort.
 */
function heldRequest(signal: AbortSignal | undefined, assign: (release: () => void) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const abort = (): void => {
      if (settled) return
      settled = true
      assign(() => {})
      reject(signal?.reason instanceof Error ? signal.reason : new Error('issue18 probe: held model request aborted'))
    }
    const release = (): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      assign(() => {})
      resolve()
    }
    assign(release)
    if (signal?.aborted === true) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
}

/** Scripted main-Agent model: real sources receipt, real process submit, then hold. */
class RealNodesAdapter extends ProbeLlmAdapter {
  mainCalls = 0
  auxiliaryCalls = 0
  requests: GenerateOptions[] = []
  toolResults: string[] = []
  sourceRef: string | undefined
  stage: 'sources' | 'process' | 'hold' | 'done' = 'sources'
  holdStarted = false
  /**
   * Independent gate for the real extraction child: the first model request
   * from a non-main Session is held until the browser assertions finish.
   */
  childHoldStarted = false
  childSessionId: string | undefined
  #releaseChild: (() => void) | undefined

  /** Release the held extraction-child request, if any. */
  releaseChild(): void {
    const release = this.#releaseChild
    this.#releaseChild = undefined
    release?.()
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (options.sessionId !== SessionId(REAL_NODES_ID)) {
      this.auxiliaryCalls += 1
      if (this.childSessionId === undefined) {
        // The real extraction work attempt's own child Session makes this
        // request; holding it keeps the child and its real work running.
        this.childSessionId = options.sessionId
        this.childHoldStarted = true
        try {
          await heldRequest(options.signal, (release) => { this.#releaseChild = release })
        } finally {
          this.childHoldStarted = false
        }
      }
      yield* textResponseChunks('REAL_NODES_AUXILIARY')
      return
    }
    this.mainCalls += 1
    const last = options.messages.at(-1)
    if (last?.role === 'user') {
      yield* toolCallChunks(REAL_NODES_SOURCES_CALL, 'nodes_extraction_sources', '{}')
      return
    }
    if (last?.role !== 'tool') {
      yield* textResponseChunks('ISSUE18_REAL_NODES_DONE')
      return
    }
    const text = messageText(last)
    this.toolResults.push(text)
    if (this.stage === 'sources') {
      this.sourceRef = /nsrc1\.[A-Za-z0-9_-]+/u.exec(text)?.[0]
      if (this.sourceRef === undefined) throw new Error('real Nodes probe: sources receipt has no source_ref')
      this.stage = 'process'
      yield* toolCallChunks(REAL_NODES_PROCESS_CALL, 'nodes_extraction_submit', JSON.stringify({
        kind: 'process',
        findings: '真实过程提交：保留五份。',
        sources: [this.sourceRef],
      }))
      return
    }
    if (this.stage === 'process') {
      this.stage = 'hold'
      this.holdStarted = true
      try {
        await heldRequest(options.signal, (release) => { this.releaseHeld = release })
      } finally {
        this.holdStarted = false
        this.releaseHeld = undefined
      }
      this.stage = 'done'
      yield* textResponseChunks('ISSUE18_REAL_NODES_DONE')
      return
    }
    yield* textResponseChunks('ISSUE18_REAL_NODES_DONE')
  }
}

/** Loader surface used to mount the real Nodes package. */
interface LoaderView {
  create(options: { name: string }): Promise<string>
  entries(): Iterable<{
    id?: string
    options: { name?: string }
    fiber?: { state?: FiberState; await(): Promise<void> }
  }>
  await(): Promise<void>
  remove(id: string): void
  internal?: { loadCache?: { keys?: () => Iterable<string> } }
}

/** Real Nodes Host service methods used by this probe. */
interface NodesServiceView {
  setContextSelection(
    request: { sessionId: string; expectedRevision: number; items: readonly { nodeId: string; version: number }[] },
    signal: AbortSignal,
  ): Promise<{ outcome: string; message?: string }>
  getContextView(
    request: { sessionId: string },
    signal: AbortSignal,
  ): Promise<{ policy?: { mode: string; policyRevision: number } }>
  setContextMode(
    request: { sessionId: string; expectedPolicyRevision: number; mode: 'auto' | 'manual' },
    signal: AbortSignal,
  ): Promise<{ outcome: string; message?: string }>
  getSubmissionViews(
    request: { sessionId?: string; limit?: number },
    signal: AbortSignal,
  ): Promise<{
    available: boolean
    message?: string
    turns: readonly {
      readonly turnRef: string
      readonly sessionId: string
      readonly turn: number
      readonly submissions: readonly {
        readonly submissionId: string
        readonly kind: 'process' | 'final'
        readonly revision: number
        readonly references: readonly string[]
      }[]
    }[]
  }>
  getExtractionViews(
    request: { sessionId?: string; turnRef?: string; limit?: number },
    signal: AbortSignal,
  ): Promise<readonly {
    readonly workId: string
    readonly turnRef: string
    readonly kind: 'process' | 'final'
    readonly state: string
    /** Submission revision the work was dispatched from, when recorded. */
    readonly submissionId?: string
    readonly revision?: number
  }[]>
}

/** Mount @nodes/dsh-plugin through the real Loader and wait for activation. */
async function mountNodes(ctx: WebScaffold['ctx']): Promise<string> {
  const loader = (ctx as WebScaffold['ctx'] & { loader: LoaderView }).loader
  const entryId = await loader.create({ name: NODES_PACKAGE_NAME })
  const entry = [...loader.entries()].find(candidate => candidate.options.name === NODES_PACKAGE_NAME)
  await loader.await()
  if (entry?.fiber?.state !== FiberState.ACTIVE) {
    throw new Error(`real Nodes probe: Loader did not activate ${NODES_PACKAGE_NAME}`)
  }
  return entryId
}

/** Register the real Nodes ownership of one already-created Session. */
async function registerNodesSession(
  scaffold: WebScaffold,
  workspaceId: WorkspaceIdValue,
  sessionId: SessionIdValue,
  operationId: string,
): Promise<void> {
  const policy = scaffold.ctx.sessionController.creationPolicies.get(NODES_POLICY_ID)
  if (policy?.beginOperation === undefined) throw new Error('real Nodes probe: Nodes creation policy is missing')
  const participant = await policy.beginOperation({
    operationId: brandString<SessionOperationId>(operationId),
    kind: 'new',
    workspaceId,
    reuseBlank: false,
  })
  await participant.prepareSession?.({ sessionId, workspaceId, reused: false })
  await participant.finishOperation?.({ kind: 'created', sessionId, workspaceId, reused: false })
}

/** Read the presentation metadata written by the real Nodes submit tool. */
function acceptedSubmissionMeta(meta: unknown): { submissionId: string; revision: number } | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined
  if (!('state' in meta) || meta.state !== 'accepted') return undefined
  if (!('submissionId' in meta) || typeof meta.submissionId !== 'string') return undefined
  if (!('revision' in meta) || typeof meta.revision !== 'number') return undefined
  return { submissionId: meta.submissionId, revision: meta.revision }
}

/** Model arguments recorded on the real process-submission tool call. */
interface ProcessSubmitArguments {
  readonly kind: 'process'
  readonly findings: string
  readonly sources: readonly string[]
}

/** Copy a tool argument JSON array of non-empty strings. */
function sourceRefList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const refs: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') return undefined
    refs.push(entry)
  }
  return refs
}

/**
 * Read the model's real `nodes_extraction_submit` arguments, rejecting any
 * submission that is not a process submission.
 * @param raw - recorded tool argument JSON.
 * @returns the process kind, findings, and submitted source refs.
 */
function readProcessSubmitArguments(raw: string): ProcessSubmitArguments {
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('real Nodes probe: process submit arguments are not an object')
  }
  if (!('kind' in parsed) || parsed.kind !== 'process') {
    throw new Error(`real Nodes probe: submit kind is ${String('kind' in parsed ? parsed.kind : undefined)}, not process`)
  }
  if (!('findings' in parsed) || typeof parsed.findings !== 'string' || parsed.findings.trim() === '') {
    throw new Error('real Nodes probe: process submit has no findings')
  }
  const sources = 'sources' in parsed ? sourceRefList(parsed.sources) : undefined
  if (sources === undefined) throw new Error('real Nodes probe: process submit has no source_ref list')
  return { kind: 'process', findings: parsed.findings, sources }
}

/** Controlled model: alternating completed and parked calls. */
class ProbeAdapter extends ProbeLlmAdapter {
  calls = 0
  holding = 0
  /** Configure which call indexes stay parked at their first block. */
  constructor(private readonly parked: ReadonlySet<number>) {
    super()
  }

  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const call = this.calls
    this.calls += 1
    const reply = call === 1 ? SECOND_REPLY : FIRST_REPLY
    yield { type: 'block-start', index: 0, blockType: 'text' }
    if (this.parked.has(call)) {
      this.holding += 1
      await new Promise<void>((resolve) => { this.releaseHeld = resolve })
      this.holding -= 1
      this.releaseHeld = undefined
    }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function nextPaint(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })
    })
  })
}

/**
 * Wait inside a setup hook, where vitest assertions are unavailable.
 * @param predicate - condition to observe.
 * @param timeout - maximum wait in milliseconds.
 * @param label - failure description.
 */
async function waitUntil(predicate: () => boolean | Promise<boolean>, timeout: number, label: string): Promise<void> {
  const deadline = Date.now() + timeout
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(label)
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
}

async function openSessionBySearch(page: Page, query: string): Promise<void> {
  if (await page.locator('[data-sidebar-drawer][data-sidebar-collapsed]').count() > 0) {
    await page.locator('[data-shell-leading]').getByRole('button', { name: 'Open sidebar', exact: true }).click()
  }
  const searchButton = page.getByRole('button', { name: 'Search sessions' })
  if (await searchButton.getAttribute('aria-expanded') !== 'true') await searchButton.click()
  const search = page.getByRole('textbox', { name: 'Search session names', exact: true })
  await search.fill(query)
  const results = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
  await results.first().waitFor({ timeout: 60_000 })
  await results.first().click()
  await page.getByRole('tab', { name: 'Chat', exact: true }).waitFor({ timeout: 30_000 })
  await nextPaint(page)
}

/**
 * Whether `target` follows `source` in document order.
 * @param page - page holding both elements.
 * @param source - CSS selector of the earlier candidate.
 * @param target - CSS selector of the later candidate.
 * @returns true when target comes after source, or null when either is absent.
 */
async function follows(page: Page, source: string, target: string): Promise<boolean | null> {
  return page.evaluate(({ source, target }) => {
    const earlier = document.querySelector(source)
    const later = document.querySelector(target)
    if (!(earlier instanceof HTMLElement) || !(later instanceof HTMLElement)) return null
    return (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
  }, { source, target })
}

function attachmentSelector(id: string): string {
  return `[data-chat-attachment="${id}"]`
}

/** Measured placement of one card against the content column. */
interface AttachmentPlacementScene {
  readonly layout: string | null
  /** This card's own host, which a mixed row can set per card. */
  readonly host: string | null
  /** Row summary: `side` only when every card in the row uses the blank. */
  readonly rowHost: string | null
  readonly rowCards: number
  readonly side: string | null
  readonly site: string | null
  /** Card's right edge is left of the content column's left edge. */
  readonly inLeftBlank: boolean
  /** Card's left edge is right of the content column's right edge. */
  readonly inRightBlank: boolean
  /** Card is horizontally inside the content column. */
  readonly insideColumn: boolean
  readonly cardCount: number
  readonly rowHeight: number
  readonly card: AnchorRect
  readonly column: AnchorRect
  readonly activeProbeFocus: string | null
}

/**
 * Measure one card against the real content column and the side blank.
 * @param page - page displaying the Session.
 * @param cardId - stable card id.
 * @returns placement facts, or null before the card mounts.
 */
async function measureAttachmentPlacement(page: Page, cardId: string): Promise<AttachmentPlacementScene | null> {
  return page.evaluate((id) => {
    const rectOf = (element: HTMLElement): AnchorRect => {
      const rect = element.getBoundingClientRect()
      return {
        top: rect.top, left: rect.left, width: rect.width, height: rect.height,
        bottom: rect.bottom, right: rect.right, visible: element.getClientRects().length > 0,
      }
    }
    const card = document.querySelector(`[data-chat-attachment="${id}"]`)
    const columns = [...document.querySelectorAll<HTMLElement>('[data-chat-flow]')]
      .filter(element => element.hasAttribute('data-chat-attachment-layout'))
    const column = columns[0]
    if (!(card instanceof HTMLElement) || column === undefined) return null
    const cardRect = rectOf(card)
    const columnRect = rectOf(column)
    const row = card.closest<HTMLElement>('[data-chat-attachment-row]')
    const active = document.activeElement
    return {
      layout: column.getAttribute('data-chat-attachment-layout'),
      host: card.getAttribute('data-chat-attachment-host'),
      rowHost: row?.getAttribute('data-chat-attachment-host') ?? null,
      rowCards: row?.querySelectorAll('[data-chat-attachment]').length ?? 0,
      side: card.getAttribute('data-chat-attachment-side'),
      site: card.getAttribute('data-chat-attachment-site'),
      inLeftBlank: cardRect.right <= columnRect.left + 0.5,
      inRightBlank: cardRect.left >= columnRect.right - 0.5,
      insideColumn: cardRect.left >= columnRect.left - 0.5 && cardRect.right <= columnRect.right + 0.5,
      cardCount: document.querySelectorAll(`[data-chat-attachment="${id}"]`).length,
      rowHeight: row === null ? -1 : rectOf(row).height,
      card: cardRect,
      column: columnRect,
      activeProbeFocus: active instanceof HTMLElement ? active.getAttribute('data-probe-focus') : null,
    } satisfies AttachmentPlacementScene
  }, cardId)
}

/**
 * Whether two cards share one row, which is what puts them at one resolved site.
 * @param page - page displaying the Session.
 * @param first - one card's stable id.
 * @param second - the other card's stable id.
 * @returns whether both cards are mounted, and inside the same row.
 */
async function shareAttachmentRow(page: Page, first: string, second: string): Promise<boolean | null> {
  return page.evaluate((ids) => {
    const rows = ids.map(id => document.querySelector(`[data-chat-attachment="${id}"]`)
      ?.closest('[data-chat-attachment-row]') ?? null)
    const [left, right] = rows
    return left !== null && left !== undefined && left === right
  }, [first, second])
}

/**
 * Read card ids in rendered order inside one row.
 * @param page - page displaying the Session.
 * @param cardId - card whose row to read.
 * @returns rendered card ids in that row, in DOM order.
 */
async function rowCardOrder(page: Page, cardId: string): Promise<readonly (string | null)[] | null> {
  return page.evaluate((id) => {
    const row = document.querySelector(`[data-chat-attachment="${id}"]`)
      ?.closest('[data-chat-attachment-row]')
    if (row === null || row === undefined) return null
    return [...row.querySelectorAll('[data-chat-attachment]')]
      .map(card => card.getAttribute('data-chat-attachment'))
  }, cardId)
}

/**
 * Measure a card against another element and the wide-table breakout limit.
 * @param page - page displaying the Session.
 * @param cardId - stable card id.
 * @param selector - element the card must not cover.
 * @returns both rectangles, their intersection, and the table's spare width.
 */
async function measureOverlap(page: Page, cardId: string, selector: string): Promise<{
  readonly card: AnchorRect
  readonly other: AnchorRect
  readonly intersects: boolean
  /** Measured element stays inside the content column, so no blank breakout. */
  readonly otherInsideColumn: boolean
  readonly sideCards: string | null
} | null> {
  return page.evaluate(({ id, selector: target }) => {
    const card = document.querySelector(`[data-chat-attachment="${id}"]`)
    const other = document.querySelector(target)
    const column = [...document.querySelectorAll<HTMLElement>('[data-chat-flow]')]
      .find(element => element.hasAttribute('data-chat-attachment-layout'))
    if (!(card instanceof HTMLElement) || !(other instanceof HTMLElement) || column === undefined) return null
    const cardBox = card.getBoundingClientRect()
    const otherBox = other.getBoundingClientRect()
    const columnBox = column.getBoundingClientRect()
    const cardRect: AnchorRect = {
      top: cardBox.top, left: cardBox.left, width: cardBox.width, height: cardBox.height,
      bottom: cardBox.bottom, right: cardBox.right, visible: card.getClientRects().length > 0,
    }
    const otherRect: AnchorRect = {
      top: otherBox.top, left: otherBox.left, width: otherBox.width, height: otherBox.height,
      bottom: otherBox.bottom, right: otherBox.right, visible: other.getClientRects().length > 0,
    }
    return {
      card: cardRect,
      other: otherRect,
      intersects: cardRect.left < otherRect.right && otherRect.left < cardRect.right
        && cardRect.top < otherRect.bottom && otherRect.top < cardRect.bottom,
      otherInsideColumn: otherRect.left >= columnBox.left - 0.5 && otherRect.right <= columnBox.right + 0.5,
      sideCards: getComputedStyle(column).getPropertyValue('--dsh-chat-side-cards').trim() || null,
    }
  }, { id: cardId, selector })
}

/** Native seat currently hosting one card. */
interface CardHost {
  /** `data-chat-node-key` of the row wrapping the card, or null at a group/Turn entry. */
  readonly nodeKey: string | null
  readonly inGroupEntry: boolean
  readonly inTurnEntry: boolean
  readonly visible: boolean
  readonly count: number
}

/**
 * Read which native seat hosts one card and whether it is visible there.
 * @param page - page displaying the Session.
 * @param cardId - stable card id.
 * @returns hosting facts, or null before the card mounts.
 */
async function measureCardHost(page: Page, cardId: string): Promise<CardHost | null> {
  return page.evaluate((id) => {
    const card = document.querySelector(`[data-chat-attachment="${id}"]`)
    if (!(card instanceof HTMLElement)) return null
    const row = card.closest('[data-chat-attachment-row]')
    const flowItem = row?.parentElement?.closest('[data-chat-node-key]') ?? null
    return {
      nodeKey: flowItem?.getAttribute('data-chat-node-key') ?? null,
      inGroupEntry: row?.closest('[data-chat-group-key]') != null
        && row?.closest('[data-step-process-body]') == null,
      inTurnEntry: row?.closest('[data-chat-flow-kind="turn-process"]') != null,
      visible: card.getClientRects().length > 0 && getComputedStyle(card).display !== 'none',
      count: document.querySelectorAll(`[data-chat-attachment="${id}"]`).length,
    } satisfies CardHost
  }, cardId)
}

/**
 * Read the reader's position once it has stopped moving.
 *
 * Fold animations and viewport changes settle over a few frames; two equal
 * samples prove the measurement is the reader's resting position.
 * @param page - page displaying the Session.
 * @returns the settled reading position.
 */
async function stableReadingPosition(page: Page): Promise<ReadingPosition> {
  let previous = await measureReadingPosition(page)
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await page.waitForTimeout(80)
    const next = await measureReadingPosition(page)
    if (next.scrollTop === previous.scrollTop && next.firstVisibleTop === previous.firstVisibleTop
      && next.firstVisibleLabel === previous.firstVisibleLabel) return next
    previous = next
  }
  return previous
}

/** Read every root row's identity and position in the current transcript. */
interface ReadingPosition {
  readonly scrollTop: number
  readonly firstVisibleTop: number
  readonly firstVisibleLabel: string
  readonly activeTurn: string | null
}

/**
 * Measure the reader's current position: scroll offset and the first root row
 * still visible at the top of the scrollport.
 * @param page - page displaying the Session.
 * @returns scroll offset and the top visible row's viewport offset.
 */
async function measureReadingPosition(page: Page): Promise<ReadingPosition> {
  return page.evaluate(() => {
    const column = [...document.querySelectorAll<HTMLElement>('[data-chat-flow]')]
      .find(element => element.hasAttribute('data-chat-attachment-layout'))
    let scroller = column?.closest<HTMLElement>('[data-conversation-scroll]') ?? null
    for (let element = column?.parentElement ?? null; scroller === null && element !== null; element = element.parentElement) {
      if (element.scrollHeight > element.clientHeight + 1) scroller = element
    }
    scroller ??= column?.parentElement ?? null
    const top = scroller === null ? 0 : scroller.getBoundingClientRect().top
    const flow = column?.querySelector(':scope > [data-slot="conversation.chat.flow"]') ?? null
    const rows = flow === null ? [] : [...flow.children].filter((element): element is HTMLElement => (
      element instanceof HTMLElement && (element.hasAttribute('data-chat-flow-key')
        || element.hasAttribute('data-chat-group-key'))
    ))
    const visible = rows.find(row => row.getBoundingClientRect().bottom > top + 1) ?? null
    const active = document.querySelector('nav [data-index][aria-current="true"]')
    return {
      scrollTop: scroller === null ? 0 : Math.round(scroller.scrollTop),
      firstVisibleTop: visible === null ? 0 : Math.round(visible.getBoundingClientRect().top - top),
      firstVisibleLabel: visible === null
        ? ''
        : (visible.getAttribute('aria-label') ?? visible.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 80),
      activeTurn: active?.getAttribute('aria-label') ?? null,
    }
  })
}

/** Canonical JSONL for one seeded session body. */
function seededLog(session: Session): string {
  return [
    JSON.stringify({
      type: 'session',
      version: SESSION_FORMAT_VERSION,
      id: '{{sessionId}}',
      createdAt: Date.now() - 60_000,
      cwd: '{{cwd}}',
      isSeeded: false,
      delegationDepth: 0,
    }),
    ...session.snapshotEvents().map(event => JSON.stringify(event)),
    '',
  ].join('\n')
}

/**
 * Build a closed Turn whose reply carries a four-column Markdown table, the
 * shape a hosting layout widens past the content column.
 * @returns canonical JSONL and its searchable prompt and title.
 */
function wideTableFixture(): { log: string; prompt: string; title: string } {
  const prompt = 'ISSUE18_PROBE_TABLE_PROMPT'
  const title = 'ISSUE18_PROBE_TABLE'
  const session = Session.create(SessionId('issue18-probe-table-template'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('system/message', {
    turn: 1,
    step: 1,
    message: createSystemMessage('Synthetic Session with a wide table.'),
  }, { surfaceOp: 'append' })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', { title, messageSeqs: [user.seq], source: { kind: 'fallback' } })
  session.append('request/header', {
    header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
    reason: 'initial',
  })
  session.append('assistant/message', {
    stream: [],
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [{
        type: 'text',
        text: '| 列 A | 列 B | 列 C | 列 D |\n| --- | --- | --- | --- |\n'
          + '| 第一行内容 | 第二列内容 | 第三列内容 | 第四列内容 |\n'
          + '| 第二行内容 | 第二列内容 | 第三列内容 | 第四列内容 |',
      }],
      source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }),
    usage: { inputTokens: 1_000, outputTokens: 120 },
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return { log: seededLog(session), prompt, title }
}

/**
 * Build a Turn whose process group holds twelve Tool rows, long enough to be a
 * capped scroll body on its own.
 * @returns canonical JSONL, searchable prompt, title, and the call ids in order.
 */
function longToolGroupFixture(): { log: string; prompt: string; title: string; callIds: readonly string[] } {
  const prompt = 'ISSUE18_PROBE_LONG_GROUP_PROMPT'
  const title = 'ISSUE18_PROBE_LONG_GROUP'
  const session = Session.create(SessionId('issue18-probe-long-group-template'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('system/message', {
    turn: 1,
    step: 1,
    message: createSystemMessage('Synthetic Session with a long process group.'),
  }, { surfaceOp: 'append' })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', { title, messageSeqs: [user.seq], source: { kind: 'fallback' } })
  session.append('request/header', {
    header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
    reason: 'initial',
  })
  const callIds = Array.from({ length: 12 }, (_, index) => `issue18-long-call-${String(index)}`)
  session.append('assistant/message', {
    stream: [],
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: callIds.map(callId => ({
        type: 'tool-call' as const,
        id: ToolCallId(callId),
        name: 'bash',
        arguments: JSON.stringify({ command: `echo ${callId}`, description: callId }),
      })),
      source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }),
    usage: { inputTokens: 1_000, outputTokens: 240 },
  }, { surfaceOp: 'append' })
  for (const callId of callIds) {
    const call = session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: ToolCallId(callId),
      name: 'bash',
      arguments: JSON.stringify({ command: `echo ${callId}`, description: callId }),
    })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId(callId),
        content: [{ type: 'text', text: `${callId} output` }],
        isError: false,
      }),
    }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  }
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return { log: seededLog(session), prompt, title, callIds }
}

/**
 * Build a closed Turn whose log ends with `turn/end` and carries no Assistant
 * answer at all, the shape a real cancelled or content-less attempt leaves.
 * @returns canonical JSONL, searchable prompt, and title.
 */
function turnWithoutReplyFixture(): { log: string; prompt: string; title: string } {
  const prompt = 'ISSUE18_PROBE_NO_REPLY_PROMPT'
  const title = 'ISSUE18_PROBE_NO_REPLY'
  const session = Session.create(SessionId('issue18-probe-no-reply-template'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('system/message', {
    turn: 1,
    step: 1,
    message: createSystemMessage('Synthetic Session without an Assistant answer.'),
  }, { surfaceOp: 'append' })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', {
    title,
    messageSeqs: [user.seq],
    source: { kind: 'fallback' },
  })
  session.append('request/header', {
    header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
    reason: 'initial',
  })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return { log: seededLog(session), prompt, title }
}

describe.skipIf(MODE === 'record')('web e2e: issue 18 Chat attachment anchors', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let adapter: ProbeAdapter
  let live: AgentHandle
  let liveSessionId: SessionIdValue
  let nextTurn = 0
  /** Turn anchored by the first scenario and reused by the withdrawal scenario. */
  let anchoredTurn = 0
  let noReply: { log: string; prompt: string; title: string }
  const NO_REPLY_ID = 'issue18-probe-no-reply'
  let table: { log: string; prompt: string; title: string }
  const TABLE_ID = 'issue18-probe-table'
  let longGroup: { log: string; prompt: string; title: string; callIds: readonly string[] }
  const LONG_GROUP_ID = 'issue18-probe-long-group'

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ profile: { packages: [{ dir: FIXTURE, enabled: true }] } })
    adapter = new ProbeAdapter(new Set([1]))
    scaffold.ctx.effect(
      () => scaffold.ctx.llm.registerAdapter([PROVIDER], adapter),
      'issue18 probe adapter',
    )
    scaffold.ctx.on('session/event', (session, event) => {
      if (session.id !== SessionId(LIVE_ID) || event.type !== 'turn/start') return
      nextTurn = event.data.turn + 1
    })
    const cwd = join(scaffold.workspaceCwd, 'workspace')
    await mkdir(cwd, { recursive: true })
    live = await scaffold.ctx.agents.create({
      sessionId: SessionId(LIVE_ID),
      meta: { cwd },
      agentOptions: { provider: PROVIDER, model: MODEL },
    })
    liveSessionId = live.agent.session.id
    live.agent.followup(createUserMessage({
      content: [{ type: 'text', text: FIRST_PROMPT }],
      source: { kind: 'user' },
    }))
    await live.agent.whenIdle()
    await seedSession(scaffold, HISTORY_FIXTURE.log, HISTORY_ID)
    await seedSession(scaffold, PAGING_FIXTURE.log, PAGING_ID)
    noReply = turnWithoutReplyFixture()
    await seedSession(scaffold, noReply.log, NO_REPLY_ID)
    table = wideTableFixture()
    await seedSession(scaffold, table.log, TABLE_ID)
    longGroup = longToolGroupFixture()
    await seedSession(scaffold, longGroup.log, LONG_GROUP_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const workspace = await scaffold.ctx.workspaceRegistry.resolveByPath(cwd)
    if (workspace === undefined) throw new Error('live workspace was not registered')
    await workspace.attachSession(liveSessionId)
    await openSessionBySearch(page, FIRST_PROMPT)
    await page.getByText(FIRST_REPLY, { exact: false }).last().waitFor({ timeout: 30_000 })
  }, 180_000)

  afterAll(async () => {
    const failures: unknown[] = []
    adapter?.release()
    await live?.dispose().catch((error: unknown) => failures.push(error))
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'issue 18 attachment teardown failed')
  })

  it('mounts both sides in the blank beside the content and keeps one card through narrow, focus, and the real turn end', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-issue18-attachment-move'))
    const anchorTurn = nextTurn
    expect(anchorTurn).toBeGreaterThan(0)
    anchoredTurn = anchorTurn
    await page.evaluate((cards: ProbeCard[]) => {
      for (const card of cards) window.__issue18Probe.registerChatAttachment(card)
    }, [
      {
        id: 'live-left',
        sessionId: liveSessionId,
        side: 'left' as const,
        anchor: { kind: 'turn-end' as const, turn: anchorTurn },
      },
      {
        id: 'live-right',
        sessionId: liveSessionId,
        side: 'right' as const,
        anchor: { kind: 'turn-start' as const, turn: anchorTurn },
      },
    ])
    // The Turn is not loaded yet, so neither contribution has a place to mount.
    expect(await page.locator('[data-chat-attachment]').count()).toBe(0)

    live.agent.followup(createUserMessage({
      content: [{ type: 'text', text: SECOND_PROMPT }],
      source: { kind: 'user' },
    }))
    await expect.poll(() => adapter.holding, { timeout: 20_000 }).toBe(1)
    const left = page.locator(attachmentSelector('live-left'))
    const right = page.locator(attachmentSelector('live-right'))
    await left.waitFor({ timeout: 20_000 })
    await right.waitFor({ timeout: 20_000 })
    expect(await left.getAttribute('data-chat-attachment-site')).toBe('turn-start')
    expect(await left.getAttribute('data-chat-attachment-side')).toBe('left')
    expect(await right.getAttribute('data-chat-attachment-site')).toBe('turn-start')
    expect(await right.getAttribute('data-chat-attachment-side')).toBe('right')
    expect(await left.getAttribute('data-chat-attachment-turn')).toBe(String(anchorTurn))
    expect(await page.locator('[data-probe-card="live-left"]').getAttribute('data-probe-session'))
      .toBe(liveSessionId)
    // Both cards precede the running Turn's real input, each with one mount.
    const inputSelector = `[data-chat-turn="${anchorTurn}"][data-chat-flow-kind="user"]`
    await expect.poll(() => follows(page, attachmentSelector('live-left'), inputSelector), { timeout: 10_000 })
      .toBe(true)
    await expect.poll(() => follows(page, attachmentSelector('live-right'), inputSelector), { timeout: 10_000 })
      .toBe(true)
    expect(await page.getByText(SECOND_PROMPT, { exact: false }).count()).toBe(1)

    // Wide: both cards stand in the real blank on their own side, out of flow.
    await page.setViewportSize({ width: 1920, height: 1080 })
    await nextPaint(page)
    const wide = await measureAttachmentPlacement(page, 'live-left')
    const wideRight = await measureAttachmentPlacement(page, 'live-right')
    expect(wide?.layout, JSON.stringify(wide)).toBe('side')
    expect(wide?.host, JSON.stringify(wide)).toBe('side')
    expect(wide?.inLeftBlank, JSON.stringify(wide)).toBe(true)
    expect(wide?.rowHeight).toBe(0)
    expect(wideRight?.host, JSON.stringify(wideRight)).toBe('side')
    expect(wideRight?.inRightBlank, JSON.stringify(wideRight)).toBe(true)
    expect(wideRight?.rowHeight).toBe(0)
    expect(wide?.cardCount).toBe(1)
    expect(wideRight?.cardCount).toBe(1)

    // Focus inside a card survives the layout switch: the card keeps one mount.
    const focusButton = page.locator('[data-probe-focus="live-left"]')
    await focusButton.focus()
    expect(await focusButton.evaluate(element => document.activeElement === element)).toBe(true)
    const narrowViewport = { width: 420, height: 820 }
    await page.setViewportSize(narrowViewport)
    await nextPaint(page)
    const narrow = await measureAttachmentPlacement(page, 'live-left')
    expect(narrow?.layout, JSON.stringify(narrow)).toBe('inline')
    expect(narrow?.host, JSON.stringify(narrow)).toBe('inline')
    expect(narrow?.insideColumn, JSON.stringify(narrow)).toBe(true)
    expect(narrow?.cardCount).toBe(1)
    expect(await focusButton.evaluate(element => document.activeElement === element)).toBe(true)
    await page.setViewportSize({ width: 1920, height: 1080 })
    await nextPaint(page)
    const wideAgain = await measureAttachmentPlacement(page, 'live-left')
    expect(wideAgain?.layout).toBe('side')
    expect(wideAgain?.host).toBe('side')
    expect(wideAgain?.inLeftBlank).toBe(true)
    expect(await focusButton.evaluate(element => document.activeElement === element)).toBe(true)

    adapter.release()
    await live.agent.whenIdle()
    await expect.poll(
      () => left.getAttribute('data-chat-attachment-site'),
      { timeout: 20_000 },
    ).toBe('turn-end')
    expect(await page.locator('[data-probe-card="live-left"]').count()).toBe(1)
    expect(await page.locator('[data-probe-card="live-right"]').count()).toBe(1)
    expect(await page.getByText(SECOND_REPLY, { exact: false }).last().count()).toBeGreaterThan(0)
    // The moved card now follows the Turn's last real row (its turn/end footer)
    // and still stands in the same side blank.
    const tailSelector = `[data-chat-turn="${anchorTurn}"][data-chat-flow-kind="turn-tail"]`
    await expect.poll(() => follows(page, tailSelector, attachmentSelector('live-left')), { timeout: 10_000 })
      .toBe(true)
    const afterEnd = await measureAttachmentPlacement(page, 'live-left')
    expect(afterEnd?.layout).toBe('side')
    expect(afterEnd?.inLeftBlank, JSON.stringify(afterEnd)).toBe(true)
    console.log(`ISSUE18_ATTACHMENT_PLACEMENT ${JSON.stringify({ wide, wideRight, narrow, wideAgain, afterEnd })}`)
  }, 150_000)

  it('keeps the moved card through folding and re-registration', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-issue18-attachment-resize'))
    const card = page.locator(attachmentSelector('live-left'))
    await card.waitFor({ timeout: 10_000 })
    const process = page.locator('[data-turn-process]').last()
    if (await process.count() > 0 && await process.getAttribute('aria-expanded') === 'true') {
      await process.click()
      await nextPaint(page)
      expect(await card.isVisible()).toBe(true)
    }

    await page.setViewportSize({ width: 420, height: 820 })
    await nextPaint(page)
    expect(await card.isVisible()).toBe(true)
    expect(await card.getAttribute('data-chat-attachment-site')).toBe('turn-end')
    await page.setViewportSize({ width: 1920, height: 1080 })
    await nextPaint(page)
    expect(await card.isVisible()).toBe(true)

    await page.evaluate(() => {
      window.__issue18Probe.disposeChatAttachment('live-left')
      window.__issue18Probe.disposeChatAttachment('live-right')
    })
    await expect.poll(() => page.locator('[data-chat-attachment]').count(), { timeout: 10_000 }).toBe(0)
    await page.evaluate((card: ProbeCard) => {
      window.__issue18Probe.registerChatAttachment(card)
    }, {
      id: 'live-left',
      sessionId: liveSessionId,
      side: 'left' as const,
      anchor: { kind: 'turn-end' as const, turn: anchoredTurn },
    })
    await expect.poll(() => page.locator(attachmentSelector('live-left')).count(), { timeout: 10_000 }).toBe(1)
    expect(await page.locator(attachmentSelector('live-left')).getAttribute('data-chat-attachment-site'))
      .toBe('turn-end')
    const placement = await measureAttachmentPlacement(page, 'live-left')
    expect(placement?.layout).toBe('side')
    expect(placement?.inLeftBlank, JSON.stringify(placement)).toBe(true)
  }, 120_000)

  it('anchors a closed Turn without a final reply at its real turn end and maps a durable event to its own row', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-issue18-no-reply'))
    await openSessionBySearch(page, noReply.prompt)
    await page.getByText(noReply.prompt, { exact: false }).last().waitFor({ timeout: 30_000 })
    // The seeded Turn really ends without an Assistant answer: its footer row is
    // present (a Turn with no reply renders no visible tail content).
    await page.locator('[data-turn-tail="1"]').waitFor({ state: 'attached', timeout: 30_000 })
    const events = await readPersistedEvents(scaffold, SessionId(NO_REPLY_ID))
    const turnEnd = events.find(event => event.type === 'turn/end')
    const turnStart = events.find(event => event.type === 'turn/start')
    const userMessage = events.find(event => event.type === 'user/message')
    if (turnEnd === undefined || turnStart === undefined || userMessage === undefined) {
      throw new Error('issue 18 no-reply fixture is missing its durable boundaries')
    }
    await page.evaluate((cards: ProbeCard[]) => {
      for (const card of cards) window.__issue18Probe.registerChatAttachment(card)
    }, [
      {
        id: 'no-reply-end',
        sessionId: NO_REPLY_ID,
        side: 'left' as const,
        anchor: { kind: 'turn-end' as const, turn: 1 },
      },
      {
        id: 'event-exact',
        sessionId: NO_REPLY_ID,
        side: 'right' as const,
        anchor: { kind: 'event' as const, turn: 1, seq: userMessage.seq },
      },
      {
        id: 'event-fallback',
        sessionId: NO_REPLY_ID,
        side: 'right' as const,
        anchor: { kind: 'event' as const, turn: 1, seq: turnStart.seq },
      },
    ])
    const endCard = page.locator(attachmentSelector('no-reply-end'))
    await endCard.waitFor({ timeout: 20_000 })
    expect(await endCard.getAttribute('data-chat-attachment-site')).toBe('turn-end')
    expect(await endCard.getAttribute('data-chat-attachment-seq')).toBe(String(turnEnd.seq))
    // The real turn/end footer row precedes the card even without a reply.
    const tailSelector = '[data-chat-turn="1"][data-chat-flow-kind="turn-tail"]'
    await expect.poll(() => follows(page, tailSelector, attachmentSelector('no-reply-end')), { timeout: 10_000 })
      .toBe(true)

    // A durable event with its own loaded row mounts before that row.
    const exact = page.locator(attachmentSelector('event-exact'))
    await exact.waitFor({ timeout: 20_000 })
    expect(await exact.getAttribute('data-chat-attachment-site')).toBe('event')
    expect(await exact.getAttribute('data-chat-attachment-seq')).toBe(String(userMessage.seq))
    await expect.poll(
      () => follows(page, attachmentSelector('event-exact'), '[data-chat-turn="1"][data-chat-flow-kind="user"]'),
      { timeout: 10_000 },
    ).toBe(true)
    // A durable event with no loaded row keeps the confirmed Turn entry.
    const fallback = page.locator(attachmentSelector('event-fallback'))
    await fallback.waitFor({ timeout: 20_000 })
    expect(await fallback.getAttribute('data-chat-attachment-site')).toBe('turn-start')
    expect(await fallback.getAttribute('data-chat-attachment-seq')).toBe(String(turnStart.seq))
  }, 120_000)

  it('keeps a side card clear of a wide table that would otherwise break out under it', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-issue18-table-overlap'))
    await openSessionBySearch(page, table.prompt)
    await page.getByText(table.prompt, { exact: false }).last().waitFor({ timeout: 30_000 })
    await page.locator('.md-table-wide').first().waitFor({ timeout: 30_000 })
    const events = await readPersistedEvents(scaffold, SessionId(TABLE_ID))
    const assistant = events.find(event => event.type === 'assistant/message')
    if (assistant === undefined) throw new Error('issue 18 table fixture has no assistant message')
    await page.setViewportSize({ width: 1920, height: 1080 })
    await nextPaint(page)
    await page.evaluate((card: ProbeCard) => {
      window.__issue18Probe.registerChatAttachment(card)
    }, {
      id: 'table-card',
      sessionId: TABLE_ID,
      side: 'left' as const,
      anchor: { kind: 'event' as const, turn: 1, seq: assistant.seq },
    })
    const card = page.locator(attachmentSelector('table-card'))
    await card.waitFor({ timeout: 20_000 })
    expect(await card.getAttribute('data-chat-attachment-site')).toBe('event')
    const placement = await measureAttachmentPlacement(page, 'table-card')
    expect(placement?.host, JSON.stringify(placement)).toBe('side')
    expect(placement?.inLeftBlank, JSON.stringify(placement)).toBe(true)
    const overlap = await measureOverlap(page, 'table-card', '.md-table-wide')
    expect(overlap, 'wide table or card was not measurable').not.toBeNull()
    // The card really is in the table's vertical band; the breakout limit keeps
    // the table inside the content column so the two never cover each other.
    expect(overlap?.card.top ?? 0).toBeLessThan(overlap?.other.bottom ?? 0)
    expect(overlap?.card.bottom ?? 0).toBeGreaterThan(overlap?.other.top ?? 0)
    expect(overlap?.sideCards, JSON.stringify(overlap)).toBe('1')
    expect(overlap?.otherInsideColumn, JSON.stringify(overlap)).toBe(true)
    expect(overlap?.intersects, JSON.stringify(overlap)).toBe(false)
    console.log(`ISSUE18_TABLE_OVERLAP ${JSON.stringify({ placement, overlap })}`)
    await page.evaluate(() => { window.__issue18Probe.disposeChatAttachment('table-card') })
  }, 120_000)

  it('keeps two cards on one side in the flow so they cannot cover each other', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-issue18-same-side'))
    await openSessionBySearch(page, longGroup.prompt)
    await page.getByText(longGroup.prompt, { exact: false }).last().waitFor({ timeout: 30_000 })
    await page.setViewportSize({ width: 1920, height: 1080 })
    await nextPaint(page)
    const [firstCall, lastCall] = [longGroup.callIds[2], longGroup.callIds[9]]
    await page.evaluate((cards: ProbeCard[]) => {
      for (const card of cards) window.__issue18Probe.registerChatAttachment(card)
    }, [
      {
        id: 'same-side-a',
        sessionId: LONG_GROUP_ID,
        side: 'left' as const,
        anchor: { kind: 'tool-call' as const, turn: 1, callId: firstCall as string },
      },
      {
        id: 'same-side-b',
        sessionId: LONG_GROUP_ID,
        side: 'left' as const,
        anchor: { kind: 'tool-call' as const, turn: 1, callId: lastCall as string },
      },
    ])
    await page.locator(attachmentSelector('same-side-a')).waitFor({ timeout: 20_000 })
    await page.locator(attachmentSelector('same-side-b')).waitFor({ timeout: 20_000 })
    const a = await measureAttachmentPlacement(page, 'same-side-a')
    const b = await measureAttachmentPlacement(page, 'same-side-b')
    // A second card on one side would stand at an unmeasured nearby anchor, so
    // both stay in the flow instead of risking mutual occlusion.
    expect(a?.host, JSON.stringify(a)).toBe('inline')
    expect(b?.host, JSON.stringify(b)).toBe('inline')
    const overlap = await measureOverlap(page, 'same-side-a', attachmentSelector('same-side-b'))
    expect(overlap?.intersects, JSON.stringify(overlap)).toBe(false)
    await page.evaluate(() => {
      window.__issue18Probe.disposeChatAttachment('same-side-a')
      window.__issue18Probe.disposeChatAttachment('same-side-b')
    })
    console.log(`ISSUE18_SAME_SIDE ${JSON.stringify({ a, b, overlap })}`)
  }, 120_000)

  it('keeps an explicit inline entry in the flow while the auto active card takes the blank', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-issue18-inline-entry'))
    await openSessionBySearch(page, longGroup.prompt)
    await page.getByText(longGroup.prompt, { exact: false }).last().waitFor({ timeout: 30_000 })
    await page.setViewportSize({ width: 1920, height: 1080 })
    await nextPaint(page)
    const historyCall = longGroup.callIds[2] as string
    const activeCall = longGroup.callIds[9] as string
    // Open the completed Turn and its group so the member rows own the cards.
    const turnProcess = page.locator('[data-turn-process="1"]')
    if (await turnProcess.count() > 0 && await turnProcess.getAttribute('aria-expanded') === 'false') {
      await turnProcess.click()
      await nextPaint(page)
    }
    const activeRow = page.locator(`[data-chat-call-id="${activeCall}"]`).first()
    await expect.poll(() => activeRow.count(), { timeout: 20_000 }).toBe(1)
    const header = activeRow.locator('xpath=ancestor::*[@data-chat-group-key]').first()
      .locator('[data-process-activity]').first()
    await header.scrollIntoViewIfNeeded()
    if (await header.getAttribute('aria-expanded') === 'false') {
      await header.click()
      await nextPaint(page)
    }
    await page.evaluate((cards: ProbeCard[]) => {
      for (const card of cards) window.__issue18Probe.registerChatAttachment(card)
    }, [
      {
        // A business-declared historical entry stays inside its Turn.
        id: 'inline-history',
        sessionId: LONG_GROUP_ID,
        side: 'left' as const,
        presentation: 'inline' as const,
        anchor: { kind: 'tool-call' as const, turn: 1, callId: historyCall },
      },
      {
        // The active card keeps the default auto request.
        id: 'auto-active',
        sessionId: LONG_GROUP_ID,
        side: 'left' as const,
        anchor: { kind: 'tool-call' as const, turn: 1, callId: activeCall },
      },
    ])
    await page.locator(attachmentSelector('inline-history')).waitFor({ timeout: 20_000 })
    await page.locator(attachmentSelector('auto-active')).waitFor({ timeout: 20_000 })
    const history = await measureAttachmentPlacement(page, 'inline-history')
    const active = await measureAttachmentPlacement(page, 'auto-active')
    expect(history?.host, JSON.stringify(history)).toBe('inline')
    expect(history?.insideColumn, JSON.stringify(history)).toBe(true)
    // The explicit inline entry does not consume the side: the auto active
    // card still reaches the measured blank and its own native row seat.
    expect(active?.host, JSON.stringify(active)).toBe('side')
    expect(active?.inLeftBlank, JSON.stringify(active)).toBe(true)
    expect(active?.rowHeight).toBe(0)
    const activeHost = await measureCardHost(page, 'auto-active')
    expect(activeHost?.nodeKey).toBe(await page.locator(attachmentSelector('auto-active'))
      .getAttribute('data-chat-attachment-target'))
    expect(activeHost?.count).toBe(1)
    const noOverlap = await measureOverlap(page, 'auto-active', attachmentSelector('inline-history'))
    expect(noOverlap?.intersects, JSON.stringify(noOverlap)).toBe(false)

    // Two auto cards on one side still fall back together, so the conflict
    // guard remains for cards the host cannot place apart by measurement.
    await page.evaluate((card: ProbeCard) => {
      window.__issue18Probe.registerChatAttachment(card)
    }, {
      id: 'auto-conflict',
      sessionId: LONG_GROUP_ID,
      side: 'left' as const,
      anchor: { kind: 'tool-call' as const, turn: 1, callId: longGroup.callIds[11] as string },
    })
    await page.locator(attachmentSelector('auto-conflict')).waitFor({ timeout: 20_000 })
    const activeAgain = await measureAttachmentPlacement(page, 'auto-active')
    const conflict = await measureAttachmentPlacement(page, 'auto-conflict')
    expect(activeAgain?.host, JSON.stringify(activeAgain)).toBe('inline')
    expect(conflict?.host, JSON.stringify(conflict)).toBe('inline')
    const historyAgain = await measureAttachmentPlacement(page, 'inline-history')
    expect(historyAgain?.host).toBe('inline')
    console.log(`ISSUE18_INLINE_ENTRY ${JSON.stringify({ history, active, activeHost, noOverlap, activeAgain, conflict })}`)
    await page.evaluate(() => {
      window.__issue18Probe.disposeChatAttachment('inline-history')
      window.__issue18Probe.disposeChatAttachment('auto-active')
      window.__issue18Probe.disposeChatAttachment('auto-conflict')
    })
  }, 120_000)

  it('keeps one host per card when an inline history card and an auto active card meet at one folded entry', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-issue18-mixed-entry'))
    await openSessionBySearch(page, longGroup.prompt)
    await page.getByText(longGroup.prompt, { exact: false }).last().waitFor({ timeout: 30_000 })
    await page.setViewportSize({ width: 1920, height: 1080 })
    await nextPaint(page)
    const historyCall = longGroup.callIds[2] as string
    const activeCall = longGroup.callIds[9] as string
    // Fold the completed Turn so both member cards resolve to the one visible
    // Turn process entry: same side, same site, one row.
    const turnProcess = page.locator('[data-turn-process="1"]')
    if (await turnProcess.count() > 0 && await turnProcess.getAttribute('aria-expanded') === 'true') {
      await turnProcess.click()
      await nextPaint(page)
    }
    await turnProcess.scrollIntoViewIfNeeded()
    const attach = async (cards: readonly ProbeCard[]): Promise<void> => {
      await page.evaluate((entries: ProbeCard[]) => {
        for (const card of entries) window.__issue18Probe.registerChatAttachment(card)
      }, [...cards])
      for (const card of cards) {
        await page.locator(attachmentSelector(card.id)).waitFor({ timeout: 20_000 })
      }
    }
    // A business-declared historical entry stays inside its Turn.
    const historyCard = (id: string): ProbeCard => ({
      id,
      sessionId: LONG_GROUP_ID,
      side: 'left' as const,
      presentation: 'inline' as const,
      anchor: { kind: 'tool-call' as const, turn: 1, callId: historyCall },
    })
    // The active card keeps the default auto request.
    const activeCard = (id: string): ProbeCard => ({
      id,
      sessionId: LONG_GROUP_ID,
      side: 'left' as const,
      anchor: { kind: 'tool-call' as const, turn: 1, callId: activeCall },
    })

    // Registration order: history first. The row's first card must not decide
    // the host of the card after it.
    await attach([historyCard('mixed-history-a'), activeCard('mixed-active-a')])
    const historyA = await measureAttachmentPlacement(page, 'mixed-history-a')
    const activeA = await measureAttachmentPlacement(page, 'mixed-active-a')
    expect(await shareAttachmentRow(page, 'mixed-history-a', 'mixed-active-a'), JSON.stringify({ historyA, activeA }))
      .toBe(true)
    expect(await rowCardOrder(page, 'mixed-history-a')).toEqual(['mixed-history-a', 'mixed-active-a'])
    expect(historyA?.site, JSON.stringify(historyA)).toBe('tool-call')
    expect(activeA?.site, JSON.stringify(activeA)).toBe('tool-call')
    expect(historyA?.host, JSON.stringify(historyA)).toBe('inline')
    expect(historyA?.insideColumn, JSON.stringify(historyA)).toBe(true)
    expect(activeA?.host, JSON.stringify(activeA)).toBe('side')
    expect(activeA?.inLeftBlank, JSON.stringify(activeA)).toBe(true)
    expect(activeA?.rowCards, JSON.stringify(activeA)).toBe(2)
    expect(activeA?.rowHost, JSON.stringify(activeA)).toBe('inline')
    expect(activeA?.rowHeight ?? 0).toBeGreaterThan(0)
    const activeHostA = await measureCardHost(page, 'mixed-active-a')
    expect(activeHostA?.inTurnEntry, JSON.stringify(activeHostA)).toBe(true)
    expect(activeHostA?.count).toBe(1)
    const noOverlapA = await measureOverlap(page, 'mixed-active-a', attachmentSelector('mixed-history-a'))
    expect(noOverlapA?.intersects, JSON.stringify(noOverlapA)).toBe(false)
    const sideCardsA = await page.evaluate(() => {
      const column = [...document.querySelectorAll<HTMLElement>('[data-chat-flow]')]
        .find(element => element.hasAttribute('data-chat-attachment-layout'))
      return column === undefined ? null : getComputedStyle(column).getPropertyValue('--dsh-chat-side-cards').trim()
    })
    expect(sideCardsA).toBe('1')
    await page.evaluate(() => {
      window.__issue18Probe.disposeChatAttachment('mixed-history-a')
      window.__issue18Probe.disposeChatAttachment('mixed-active-a')
    })

    // Registration order: active first. The same two cards must keep the same
    // per-card hosts and rendered order at one entry.
    await attach([activeCard('mixed-active-b'), historyCard('mixed-history-b')])
    const historyB = await measureAttachmentPlacement(page, 'mixed-history-b')
    const activeB = await measureAttachmentPlacement(page, 'mixed-active-b')
    expect(await shareAttachmentRow(page, 'mixed-history-b', 'mixed-active-b'), JSON.stringify({ historyB, activeB }))
      .toBe(true)
    expect(await rowCardOrder(page, 'mixed-history-b')).toEqual(['mixed-active-b', 'mixed-history-b'])
    expect(historyB?.host, JSON.stringify(historyB)).toBe('inline')
    expect(historyB?.insideColumn, JSON.stringify(historyB)).toBe(true)
    expect(activeB?.host, JSON.stringify(activeB)).toBe('side')
    expect(activeB?.inLeftBlank, JSON.stringify(activeB)).toBe(true)
    expect(activeB?.rowCards, JSON.stringify(activeB)).toBe(2)
    const noOverlapB = await measureOverlap(page, 'mixed-active-b', attachmentSelector('mixed-history-b'))
    expect(noOverlapB?.intersects, JSON.stringify(noOverlapB)).toBe(false)
    await page.evaluate(() => {
      window.__issue18Probe.disposeChatAttachment('mixed-history-b')
      window.__issue18Probe.disposeChatAttachment('mixed-active-b')
    })
    console.log(`ISSUE18_MIXED_ENTRY ${JSON.stringify({ historyA, activeA, activeHostA, noOverlapA, sideCardsA, historyB, activeB, noOverlapB })}`)
  }, 120_000)

  it('keeps a side card visible in a long process group and through its fold', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-issue18-long-group'))
    await openSessionBySearch(page, longGroup.prompt)
    await page.getByText(longGroup.prompt, { exact: false }).last().waitFor({ timeout: 30_000 })
    await page.setViewportSize({ width: 1920, height: 1080 })
    await nextPaint(page)
    const targetCall = longGroup.callIds[6] as string
    await page.evaluate((card: ProbeCard) => {
      window.__issue18Probe.registerChatAttachment(card)
    }, {
      id: 'long-group-card',
      sessionId: LONG_GROUP_ID,
      side: 'left' as const,
      anchor: { kind: 'tool-call' as const, turn: 1, callId: targetCall },
    })
    const card = page.locator(attachmentSelector('long-group-card'))
    await card.waitFor({ timeout: 20_000 })
    const targetRow = page.locator(`[data-chat-call-id="${targetCall}"]`).first()
    await expect.poll(() => targetRow.count(), { timeout: 20_000 }).toBe(1)
    // The completed Turn may start folded; open it before reaching its group.
    const turnProcess = page.locator('[data-turn-process="1"]')
    if (await turnProcess.count() > 0 && await turnProcess.getAttribute('aria-expanded') === 'false') {
      await turnProcess.click()
      await nextPaint(page)
    }
    const group = targetRow.locator('xpath=ancestor::*[@data-chat-group-key]').first()
    const header = group.locator('[data-process-activity]').first()
    await expect.poll(() => header.count(), { timeout: 20_000 }).toBe(1)
    await header.scrollIntoViewIfNeeded()
    if (await header.getAttribute('aria-expanded') === 'false') {
      await header.click()
      await nextPaint(page)
    }
    const expanded = await measureAttachmentPlacement(page, 'long-group-card')
    expect(expanded?.host, JSON.stringify(expanded)).toBe('side')
    expect(expanded?.inLeftBlank, JSON.stringify(expanded)).toBe(true)
    // The capped group body is a scroll container; hosting a side card drops
    // the cap so the blank is not clipped.
    const bodyCap = await group.locator('[data-step-process-body]').first()
      .evaluate(element => getComputedStyle(element).maxHeight)
    expect(bodyCap).toBe('none')
    await card.scrollIntoViewIfNeeded()
    await nextPaint(page)
    expect(await card.isVisible()).toBe(true)
    // Folding the group keeps the same card at its visible entry.
    await header.scrollIntoViewIfNeeded()
    await header.click()
    await expect.poll(() => targetRow.isVisible(), { timeout: 10_000 }).toBe(false)
    const folded = await measureCardHost(page, 'long-group-card')
    expect(folded?.visible, JSON.stringify(folded)).toBe(true)
    expect(folded?.inGroupEntry, JSON.stringify(folded)).toBe(true)
    await header.click()
    await expect.poll(() => targetRow.isVisible(), { timeout: 10_000 }).toBe(true)
    const reopened = await measureCardHost(page, 'long-group-card')
    expect(reopened?.nodeKey, JSON.stringify(reopened)).toBe(await card.getAttribute('data-chat-attachment-target'))
    console.log(`ISSUE18_LONG_GROUP ${JSON.stringify({ expanded, bodyCap, folded, reopened })}`)
    await page.evaluate(() => { window.__issue18Probe.disposeChatAttachment('long-group-card') })
  }, 120_000)

  it('mounts only after an older page loads and does not follow a fork', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-issue18-attachment-paging'))
    await openSessionBySearch(page, PAGING_FIXTURE.markers.user(1))
    await page.getByText(PAGING_FIXTURE.markers.assistant(PAGING_TURNS), { exact: false }).last().waitFor({ timeout: 30_000 })
    await page.evaluate((card: ProbeCard) => {
      window.__issue18Probe.registerChatAttachment(card)
    }, {
      id: 'history-start',
      sessionId: PAGING_ID,
      side: 'right' as const,
      anchor: { kind: 'turn-start' as const, turn: 1 },
    })
    await page.evaluate((card: ProbeCard) => {
      window.__issue18Probe.registerChatAttachment(card)
    }, {
      id: 'history-end',
      sessionId: PAGING_ID,
      side: 'right' as const,
      anchor: { kind: 'turn-end' as const, turn: PAGING_TURNS },
    })
    // Turn 1 is outside the first loaded page; Turn 40's footer is present.
    expect(await page.locator(attachmentSelector('history-start')).count()).toBe(0)
    const endCard = page.locator(attachmentSelector('history-end'))
    await endCard.waitFor({ timeout: 10_000 })
    expect(await endCard.getAttribute('data-chat-attachment-site')).toBe('turn-end')

    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (await page.locator(attachmentSelector('history-start')).count() > 0) break
      const older = page.getByRole('button', { name: 'Load earlier', exact: true })
      if (await older.count() === 0) break
      await older.click()
      await nextPaint(page)
    }
    const startCard = page.locator(attachmentSelector('history-start'))
    await startCard.waitFor({ timeout: 30_000 })
    expect(await startCard.getAttribute('data-chat-attachment-site')).toBe('turn-start')
    // The card precedes the historical Turn's real input and appears once.
    await expect.poll(
      () => follows(page, attachmentSelector('history-start'), '[data-chat-turn="1"][data-chat-flow-kind="user"]'),
      { timeout: 10_000 },
    ).toBe(true)
    expect(await page.locator(attachmentSelector('history-start')).count()).toBe(1)

    // Real scrolling keeps each card beside the Turn it is anchored to, and a
    // folded Turn process stays outside the visible turn-end card.
    await page.getByText(PAGING_FIXTURE.markers.user(1), { exact: false }).last().scrollIntoViewIfNeeded()
    await nextPaint(page)
    expect(await startCard.isVisible()).toBe(true)
    await endCard.scrollIntoViewIfNeeded()
    await nextPaint(page)
    expect(await endCard.isVisible()).toBe(true)
    const turnProcess = page.locator(`[data-turn-process="${PAGING_TURNS}"]`)
    if (await turnProcess.count() > 0 && await turnProcess.getAttribute('aria-expanded') === 'true') {
      await turnProcess.click()
      await nextPaint(page)
      expect(await endCard.isVisible()).toBe(true)
    }

    // A fork inherits these events under another Session id; the scoped cards
    // must not mount there.
    const branch = page.getByRole('button', { name: 'Branch into a new conversation' }).last()
    await branch.click()
    await page.getByText(`${PAGING_FIXTURE.title} (1)`, { exact: false }).first().waitFor({ timeout: 30_000 })
    await page.getByRole('tab', { name: 'Chat', exact: true }).waitFor({ timeout: 30_000 })
    await page.getByText(PAGING_FIXTURE.markers.assistant(PAGING_TURNS), { exact: false }).last().waitFor({ timeout: 30_000 })
    expect(await page.locator('[data-chat-attachment]').count()).toBe(0)
  }, 120_000)

  it('keeps the reader position when a card appears and when it moves to another anchor', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-issue18-attachment-reading'))
    await openSessionBySearch(page, HISTORY_FIXTURE.markers.user(1))
    await page.getByText(HISTORY_FIXTURE.markers.assistant(HISTORY_TURNS), { exact: false }).last()
      .waitFor({ timeout: 30_000 })
    // The first Turn must be loaded before a card can mount there.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (await page.locator('[data-chat-turn="1"]').count() > 0) break
      const older = page.getByRole('button', { name: 'Load earlier', exact: true })
      if (await older.count() === 0) break
      await older.click()
      await nextPaint(page)
    }
    await expect.poll(() => page.locator('[data-chat-turn="1"]').count(), { timeout: 30_000 })
      .toBeGreaterThan(0)
    const readingTurn = HISTORY_TURNS - 20
    await page.getByText(HISTORY_FIXTURE.markers.user(readingTurn), { exact: false }).last()
      .scrollIntoViewIfNeeded()
    await nextPaint(page)
    const before = await stableReadingPosition(page)
    expect(before.firstVisibleLabel.length).toBeGreaterThan(0)

    // A card for a Turn above the reader appears in the side blank.
    await page.evaluate((card: ProbeCard) => {
      window.__issue18Probe.registerChatAttachment(card)
    }, {
      id: 'reading-card',
      sessionId: HISTORY_ID,
      side: 'left' as const,
      anchor: { kind: 'turn-start' as const, turn: 1 },
    })
    await expect.poll(() => page.locator(attachmentSelector('reading-card')).count(), { timeout: 10_000 })
      .toBe(1)
    await nextPaint(page)
    const afterAppear = await stableReadingPosition(page)
    // The reading row keeps its screen position; the scroll offset may move a
    // few pixels to hold it when the new row lands above the viewport.
    expect(Math.abs(afterAppear.scrollTop - before.scrollTop), JSON.stringify({ before, afterAppear }))
      .toBeLessThanOrEqual(8)
    expect(afterAppear.firstVisibleTop).toBe(before.firstVisibleTop)
    expect(afterAppear.firstVisibleLabel).toBe(before.firstVisibleLabel)
    expect(afterAppear.activeTurn).toBe(before.activeTurn)

    // Moving the same card to another Turn's anchor must not follow it.
    await page.evaluate((card: ProbeCard) => {
      window.__issue18Probe.disposeChatAttachment('reading-card')
      window.__issue18Probe.registerChatAttachment(card)
    }, {
      id: 'reading-card',
      sessionId: HISTORY_ID,
      side: 'left' as const,
      anchor: { kind: 'turn-end' as const, turn: HISTORY_TURNS },
    })
    await expect.poll(
      () => page.locator(attachmentSelector('reading-card')).getAttribute('data-chat-attachment-site'),
      { timeout: 10_000 },
    ).toBe('turn-end')
    await nextPaint(page)
    const afterMove = await stableReadingPosition(page)
    expect(Math.abs(afterMove.scrollTop - before.scrollTop), JSON.stringify({ before, afterMove }))
      .toBeLessThanOrEqual(8)
    expect(afterMove.firstVisibleTop).toBe(before.firstVisibleTop)
    expect(afterMove.firstVisibleLabel).toBe(before.firstVisibleLabel)
    expect(afterMove.activeTurn).toBe(before.activeTurn)
    await page.evaluate(() => { window.__issue18Probe.disposeChatAttachment('reading-card') })

    // Narrow viewport: the card joins the flow, so a card appearing above the
    // reader changes the flow height. Native scroll anchoring must keep the
    // reading row on screen, and focus inside the card must survive.
    await page.setViewportSize({ width: 420, height: 820 })
    await nextPaint(page)
    await page.evaluate((card: ProbeCard) => {
      window.__issue18Probe.registerChatAttachment(card)
    }, {
      id: 'narrow-anchor',
      sessionId: HISTORY_ID,
      side: 'left' as const,
      anchor: { kind: 'turn-start' as const, turn: readingTurn },
    })
    const narrowAnchor = page.locator(attachmentSelector('narrow-anchor'))
    await narrowAnchor.waitFor({ timeout: 20_000 })
    await page.getByText(HISTORY_FIXTURE.markers.user(readingTurn), { exact: false }).last()
      .scrollIntoViewIfNeeded()
    const narrowFocus = page.locator('[data-probe-focus="narrow-anchor"]')
    await narrowFocus.focus()
    expect(await narrowFocus.evaluate(element => document.activeElement === element)).toBe(true)
    const narrowBefore = await stableReadingPosition(page)
    expect((await measureAttachmentPlacement(page, 'narrow-anchor'))?.host).toBe('inline')
    await page.evaluate((card: ProbeCard) => {
      window.__issue18Probe.registerChatAttachment(card)
    }, {
      id: 'narrow-above',
      sessionId: HISTORY_ID,
      side: 'left' as const,
      anchor: { kind: 'turn-start' as const, turn: 2 },
    })
    await expect.poll(() => page.locator(attachmentSelector('narrow-above')).count(), { timeout: 10_000 })
      .toBe(1)
    await nextPaint(page)
    const narrowAfter = await stableReadingPosition(page)
    expect(Math.abs(narrowAfter.firstVisibleTop - narrowBefore.firstVisibleTop),
      JSON.stringify({ narrowBefore, narrowAfter })).toBeLessThanOrEqual(2)
    expect(narrowAfter.firstVisibleLabel).toBe(narrowBefore.firstVisibleLabel)
    expect(await narrowFocus.evaluate(element => document.activeElement === element)).toBe(true)
    await page.evaluate(() => {
      window.__issue18Probe.disposeChatAttachment('narrow-anchor')
      window.__issue18Probe.disposeChatAttachment('narrow-above')
    })
    await page.setViewportSize({ width: 1920, height: 1080 })
    await nextPaint(page)
    console.log(`ISSUE18_READING_POSITION ${JSON.stringify({ before, afterAppear, afterMove, narrowBefore, narrowAfter })}`)
  }, 120_000)

})

describe.skipIf(MODE === 'record')('web e2e: issue 18 native subagent menu classification', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let adapter: ProbeAdapter
  let parent: AgentHandle
  let parentId: SessionIdValue
  let normalChild: SessionIdValue
  let supportChild: SessionIdValue

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ profile: { packages: [{ dir: FIXTURE, enabled: true }] } })
    adapter = new ProbeAdapter(new Set([2]))
    scaffold.ctx.effect(
      () => scaffold.ctx.llm.registerAdapter([PROVIDER], adapter),
      'issue18 subagent probe adapter',
    )
    const cwd = join(scaffold.workspaceCwd, 'workspace')
    await mkdir(cwd, { recursive: true })
    parent = await scaffold.ctx.agents.create({
      sessionId: SessionId('issue18-probe-parent'),
      meta: { cwd },
      agentOptions: { provider: PROVIDER, model: MODEL },
    })
    parentId = parent.agent.session.id
    const prompt = 'ISSUE18_SUBAGENT_PARENT'
    parent.agent.followup(createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    }))
    await parent.agent.whenIdle()

    const normal = await scaffold.ctx.subagents.startActivation({
      delivery: 'caller',
      provider: 'spawn',
      label: 'normal-child',
      signal: new AbortController().signal,
      request: {
        prompt: [{ type: 'text', text: 'Normal delegated task.' }],
        parent: parent.agent,
      },
    })
    normalChild = normal.childId
    await normal.result

    const support = await scaffold.ctx.subagents.startActivation({
      delivery: 'caller',
      provider: 'spawn',
      label: 'support-child',
      signal: new AbortController().signal,
      request: {
        prompt: [{ type: 'text', text: 'Support delegated task stays running.' }],
        parent: parent.agent,
      },
    })
    supportChild = support.childId
    await waitUntil(
      () => scaffold.ctx.agents.get(supportChild)?.status === 'running' && adapter.holding === 1,
      20_000,
      'support child did not enter its parked model call',
    )

    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const workspace = await scaffold.ctx.workspaceRegistry.resolveByPath(cwd)
    if (workspace === undefined) throw new Error('subagent workspace was not registered')
    await workspace.attachSession(parentId)
    await openSessionBySearch(page, prompt)
    await page.getByText(FIRST_REPLY, { exact: false }).last().waitFor({ timeout: 30_000 })
  }, 180_000)

  afterAll(async () => {
    const failures: unknown[] = []
    adapter?.release()
    const support = supportChild === undefined ? undefined : scaffold?.ctx.agents.get(supportChild)
    if (support !== undefined) {
      support.cancel({ kind: 'user' })
      await support.whenIdle().catch((error: unknown) => failures.push(error))
    }
    await browser?.close().catch((error: unknown) => failures.push(error))
    await parent?.dispose().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'issue 18 menu teardown failed')
  })

  async function openMenu(): Promise<void> {
    const trigger = page.getByRole('button', { name: /^\d+ subagents?(?: running)?$/ })
    await trigger.waitFor({ timeout: 20_000 })
    await trigger.hover()
    await page.getByRole('tree', { name: 'Subagent sessions' }).waitFor({ timeout: 10_000 })
  }

  it('splits the classified support child from native rows, totals, and running count', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-issue18-subagent-menu'))
    await expect.poll(
      () => page.getByRole('button', { name: '1 subagent running', exact: true }).count(),
      { timeout: 20_000 },
    ).toBe(1)
    await openMenu()
    let rows = page.getByRole('tree', { name: 'Subagent sessions' }).getByRole('treeitem')
    await expect.poll(() => rows.count(), { timeout: 10_000 }).toBe(2)
    expect(await rows.filter({ hasText: 'normal-child' }).count()).toBe(1)
    expect(await rows.filter({ hasText: 'support-child' }).count()).toBe(1)

    await page.evaluate(({ parentSessionId, supportIds }) => {
      window.__issue18Probe.setClassification({ parentSessionId, supportIds })
    }, { parentSessionId: parentId, supportIds: [supportChild] })
    await expect.poll(
      () => page.getByRole('button', { name: '1 subagent', exact: true }).count(),
      { timeout: 10_000 },
    ).toBe(1)
    await openMenu()
    rows = page.getByRole('tree', { name: 'Subagent sessions' }).getByRole('treeitem')
    await expect.poll(() => rows.count(), { timeout: 10_000 }).toBe(1)
    expect(await rows.filter({ hasText: 'normal-child' }).count()).toBe(1)
    expect(await rows.filter({ hasText: 'support-child' }).count()).toBe(0)

    const entries = await page.evaluate(() => window.__issue18Probe.getLastCatalogEntries())
    expect(entries.map(entry => entry.id).sort()).toEqual([normalChild, supportChild].sort())
    expect(entries.find(entry => entry.id === supportChild)?.activity).toBe('running')
    expect(entries.find(entry => entry.id === normalChild)?.activity).toBe('inactive')
    expect(await page.evaluate(() => window.__issue18Probe.getClassificationState()))
      .toMatchObject({ parentSessionId: parentId, support: [supportChild], unavailable: false })

    // The surviving native row still opens its real parent/child address.
    await rows.filter({ hasText: 'normal-child' }).click()
    await page.getByRole('button', { name: 'Switch subagent: normal-child', exact: true })
      .waitFor({ timeout: 30_000 })
  }, 120_000)

  it('restores native rows after withdrawal and hides the menu when all children are classified', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-issue18-subagent-withdraw'))
    await openSessionBySearch(page, 'ISSUE18_SUBAGENT_PARENT')
    await page.evaluate(() => { window.__issue18Probe.withdrawClassification() })
    await expect.poll(
      () => page.getByRole('button', { name: '1 subagent running', exact: true }).count(),
      { timeout: 10_000 },
    ).toBe(1)
    await openMenu()
    const rows = page.getByRole('tree', { name: 'Subagent sessions' }).getByRole('treeitem')
    await expect.poll(() => rows.count(), { timeout: 10_000 }).toBe(2)
    expect(await rows.filter({ hasText: 'support-child' }).count()).toBe(1)

    await page.evaluate(({ parentSessionId, supportIds }) => {
      window.__issue18Probe.setClassification({ parentSessionId, supportIds })
    }, { parentSessionId: parentId, supportIds: [normalChild, supportChild] })
    await expect.poll(
      () => page.getByRole('button', { name: /^\d+ subagents?(?: running)?$/ }).count(),
      { timeout: 10_000 },
    ).toBe(0)

    await page.evaluate(({ parentSessionId }) => {
      window.__issue18Probe.setClassification({ parentSessionId, supportIds: [] })
    }, { parentSessionId: parentId })
    await expect.poll(
      () => page.getByRole('button', { name: '1 subagent running', exact: true }).count(),
      { timeout: 10_000 },
    ).toBe(1)
  }, 120_000)
})

// This single case records whether the current event-anchor candidate lands on
// the exact process-submit call row. `site="event"` and the returned seq are
// only bookkeeping: the asserted target is the DOM row addressed by
// `data-chat-call-id`, its owning native process group, and its neighbours.
describe.skipIf(MODE === 'record')('web e2e: issue 18 process-submit call-row anchor', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let anchor: ProcessAnchorSetup
  let tripwireErrors: () => string[]

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ profile: { packages: [{ dir: FIXTURE, enabled: true }] } })
    const capture = readProcessCapture()
    const sessionId = capture?.sessionId ?? ANCHOR_ID
    await seedSession(scaffold, capture?.log ?? ANCHOR_FIXTURE.log, sessionId)
    const events = await readPersistedEvents(scaffold, SessionId(sessionId))
    const calls = events.filter(event => event.type === 'tool/call')
    const target = capture === undefined
      ? calls.filter(event => event.data.turn === ANCHOR_TURN).at(-1)
      : calls.find(event => event.data.callId === capture.callId)
    if (target === undefined) {
      throw new Error(
        `issue 18 process anchor: no tool/call row for ${capture === undefined
          ? `fixture turn ${String(ANCHOR_TURN)}`
          : `captured call ${capture.callId}`}`,
      )
    }
    const turnCalls = calls.filter(event => event.data.turn === target.data.turn)
    const result = events.find(event => event.type === 'tool/result'
      && event.sourceEventSeqs?.includes(target.seq))
    const query = capture === undefined
      ? ANCHOR_FIXTURE.markers.user(1)
      : searchablePrompt(firstUserText(events))
    anchor = {
      sessionId: SessionId(sessionId),
      turn: target.data.turn,
      step: target.data.step,
      callId: target.data.callId,
      toolCallIds: turnCalls.map(event => event.data.callId),
      query,
      source: capture === undefined ? 'fixture' : 'capture',
      seededCallSeq: target.seq,
      seededResultSeq: result?.seq,
      capture,
    }
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    const consoleWatch = watchConsole(page)
    tripwireErrors = () => [...consoleWatch.pageErrors, ...consoleWatch.warnings]
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    await openSessionBySearch(page, query)
  }, 180_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'issue 18 process anchor teardown failed')
  })

  it('anchors the process submit call row precisely in every process disclosure state', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-issue18-process-anchor'))
    // The in-Turn layout keeps the card at the exact row; the side layout is
    // measured separately below.
    await page.setViewportSize({ width: 900, height: 900 })
    await nextPaint(page)
    const turnRow = page.locator(`[data-chat-turn="${anchor.turn}"]`)
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (await turnRow.count() > 0) break
      const older = page.getByRole('button', { name: 'Load earlier', exact: true })
      if (await older.count() === 0) break
      await older.click()
      await nextPaint(page)
    }
    await expect.poll(() => turnRow.count(), { timeout: 30_000 }).toBeGreaterThan(0)
    const toolRow = page.locator(`[data-chat-call-id="${anchor.callId}"]`).first()
    await expect.poll(() => toolRow.count(), { timeout: 30_000 }).toBe(1)

    await page.evaluate((card) => {
      window.__issue18Probe.registerChatAttachment(card)
    }, {
      id: 'process-submit-anchor',
      sessionId: anchor.sessionId,
      side: 'left' as const,
      anchor: { kind: 'tool-call' as const, turn: anchor.turn, callId: anchor.callId },
    })
    const card = page.locator('[data-chat-attachment="process-submit-anchor"]')
    await card.waitFor({ timeout: 30_000 })
    expect(await card.getAttribute('data-chat-attachment-site')).toBe('tool-call')
    expect(await card.getAttribute('data-chat-attachment-turn')).toBe(String(anchor.turn))
    expect(await card.getAttribute('data-chat-attachment-target')).not.toBeNull()

    const group = toolRow.locator('xpath=ancestor::*[@data-chat-group-key]').first()
    const groupHeader = group.locator('[data-process-activity]').first()
    const turnProcess = page.locator(`[data-turn-process="${anchor.turn}"]`)
    // Start from a fully open Turn with its process group collapsed: the card
    // must stand at that group's visible entry.
    if (await turnProcess.count() > 0 && await turnProcess.getAttribute('aria-expanded') === 'false') {
      await turnProcess.click()
      await nextPaint(page)
    }
    await expect.poll(() => groupHeader.isVisible(), { timeout: 10_000 }).toBe(true)
    if (await groupHeader.getAttribute('aria-expanded') === 'true') {
      await groupHeader.click()
      await nextPaint(page)
    }
    const groupEntry = await measureProcessAnchor(page, {
      cardId: 'process-submit-anchor',
      callId: anchor.callId,
      toolCallIds: anchor.toolCallIds,
    })
    expect(await card.count()).toBe(1)
    expect(await card.isVisible()).toBe(true)
    expect(groupEntry.cardAtGroupEntry, JSON.stringify(groupEntry)).toBe(true)
    expect(groupEntry.cardInTargetToolSeat, JSON.stringify(groupEntry)).toBe(false)

    // Open the native process group: the card must move to the exact submit
    // row's own Chat seat and nowhere else.
    await groupHeader.click()
    await expect.poll(() => toolRow.isVisible(), { timeout: 10_000 }).toBe(true)
    const expanded = await measureProcessAnchor(page, {
      cardId: 'process-submit-anchor',
      callId: anchor.callId,
      toolCallIds: anchor.toolCallIds,
    })
    expect(await card.count()).toBe(1)
    expect(expanded.cardInTargetToolSeat, JSON.stringify(expanded)).toBe(true)
    expect(expanded.precise, JSON.stringify(expanded)).toBe(true)

    // Close only the group: the card returns to that group's visible entry.
    await groupHeader.click()
    await expect.poll(() => toolRow.isVisible(), { timeout: 10_000 }).toBe(false)
    const groupEntryAgain = await measureProcessAnchor(page, {
      cardId: 'process-submit-anchor',
      callId: anchor.callId,
      toolCallIds: anchor.toolCallIds,
    })
    expect(await card.count()).toBe(1)
    expect(groupEntryAgain.cardAtGroupEntry, JSON.stringify(groupEntryAgain)).toBe(true)
    expect(groupEntryAgain.precise).toBe(false)

    // Fold the whole Turn process: the same card must stand at the visible Turn
    // process entry rather than floating after the group.
    await expect.poll(() => turnProcess.getAttribute('aria-expanded'), { timeout: 10_000 }).toBe('true')
    await turnProcess.click()
    const turnEntry = await measureProcessAnchor(page, {
      cardId: 'process-submit-anchor',
      callId: anchor.callId,
      toolCallIds: anchor.toolCallIds,
    })
    expect(await card.count()).toBe(1)
    expect(await card.isVisible()).toBe(true)
    expect(turnEntry.cardInTurnEntry, JSON.stringify(turnEntry)).toBe(true)
    expect(turnEntry.precise).toBe(false)

    // Reopen the Turn and its group: the card returns to the exact row.
    await turnProcess.click()
    await expect.poll(() => groupHeader.getAttribute('aria-expanded'), { timeout: 10_000 }).toBe('false')
    await groupHeader.click()
    await expect.poll(() => toolRow.isVisible(), { timeout: 10_000 }).toBe(true)
    const expandedAgain = await measureProcessAnchor(page, {
      cardId: 'process-submit-anchor',
      callId: anchor.callId,
      toolCallIds: anchor.toolCallIds,
    })
    expect(await card.count()).toBe(1)
    expect(expandedAgain.precise, JSON.stringify(expandedAgain)).toBe(true)

    // Wide: the same precise card stands in the side blank at its row, and
    // folding the group keeps that card visible at the group's own entry.
    await page.setViewportSize({ width: 1920, height: 1080 })
    await nextPaint(page)
    const wideExpanded = await measureAttachmentPlacement(page, 'process-submit-anchor')
    expect(wideExpanded?.layout, JSON.stringify(wideExpanded)).toBe('side')
    expect(wideExpanded?.inLeftBlank, JSON.stringify(wideExpanded)).toBe(true)
    expect(await card.isVisible()).toBe(true)
    await groupHeader.click()
    await expect.poll(() => toolRow.isVisible(), { timeout: 10_000 }).toBe(false)
    const wideFolded = await measureAttachmentPlacement(page, 'process-submit-anchor')
    expect(wideFolded?.layout).toBe('side')
    expect(wideFolded?.inLeftBlank, JSON.stringify(wideFolded)).toBe(true)
    expect(await card.isVisible()).toBe(true)
    await groupHeader.click()
    await expect.poll(() => toolRow.isVisible(), { timeout: 10_000 }).toBe(true)

    const evidence = {
      source: anchor.source,
      capturePresent: anchor.capture !== undefined,
      sessionId: anchor.sessionId,
      turn: anchor.turn,
      step: anchor.step,
      callId: anchor.callId,
      toolCallIds: anchor.toolCallIds,
      seededCallSeq: anchor.seededCallSeq,
      seededResultSeq: anchor.seededResultSeq,
      captureCallSeq: anchor.capture?.callSeq,
      captureResultSeq: anchor.capture?.resultSeq,
      captureSubmissionId: anchor.capture?.submissionId,
      captureRevision: anchor.capture?.revision,
      cardSite: await card.getAttribute('data-chat-attachment-site'),
      cardTurn: await card.getAttribute('data-chat-attachment-turn'),
      cardTarget: await card.getAttribute('data-chat-attachment-target'),
      groupEntry,
      expanded,
      groupEntryAgain,
      turnEntry,
      expandedAgain,
      wideExpanded,
      wideFolded,
      pageErrors: tripwireErrors(),
    }
    mkdirSync(dirname(PROCESS_ANCHOR_EVIDENCE_PATH), { recursive: true })
    writeFileSync(PROCESS_ANCHOR_EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`)
    console.log(`ISSUE18_PROCESS_ANCHOR_EVIDENCE ${JSON.stringify(evidence)}`)

    expect(expanded.card, 'attachment card was not measurable').not.toBeNull()
    expect(expanded.tool, 'exact call row was not measurable after opening the group').not.toBeNull()
    expect(expanded.group, 'owning process group was not measurable').not.toBeNull()
  }, 120_000)

  it('mounts a step/start event at that loaded Step entry and falls back for an unknown seq', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-issue18-step-event'))
    const events = await readPersistedEvents(scaffold, anchor.sessionId)
    const stepStarts = events.filter(event => event.type === 'step/start' && event.data.turn === anchor.turn)
    expect(stepStarts.length).toBeGreaterThanOrEqual(2)
    const laterStep = stepStarts.at(-1)
    const turnStart = events.find(event => event.type === 'turn/start' && event.data.turn === anchor.turn)
    if (laterStep === undefined || turnStart === undefined) {
      throw new Error('issue 18 step-event: durable step/start or turn/start is missing')
    }
    await page.evaluate((cards: ProbeCard[]) => {
      for (const card of cards) window.__issue18Probe.registerChatAttachment(card)
    }, [
      {
        id: 'step-event',
        sessionId: String(anchor.sessionId),
        side: 'left' as const,
        anchor: { kind: 'event' as const, turn: anchor.turn, seq: laterStep.seq },
      },
      {
        id: 'unknown-event',
        sessionId: String(anchor.sessionId),
        side: 'right' as const,
        anchor: { kind: 'event' as const, turn: anchor.turn, seq: turnStart.seq },
      },
    ])
    const stepCard = page.locator(attachmentSelector('step-event'))
    await stepCard.waitFor({ timeout: 20_000 })
    expect(await stepCard.getAttribute('data-chat-attachment-site')).toBe('event')
    expect(await stepCard.getAttribute('data-chat-attachment-seq')).toBe(String(laterStep.seq))
    const targetKey = await stepCard.getAttribute('data-chat-attachment-target')
    const targetGroup = await stepCard.getAttribute('data-chat-attachment-group')
    expect(targetKey ?? targetGroup, 'Step entry did not resolve to one rendered entry').not.toBeNull()
    const expandedHost = await measureCardHost(page, 'step-event')
    expect(expandedHost?.count).toBe(1)
    expect(expandedHost?.visible, JSON.stringify(expandedHost)).toBe(true)
    if (targetGroup !== null) {
      // The Step's rows live in a process group; the card stands at that
      // group's visible entry in both disclosure states.
      expect(expandedHost?.inGroupEntry, JSON.stringify(expandedHost)).toBe(true)
    } else {
      expect(expandedHost?.nodeKey, JSON.stringify(expandedHost)).toBe(targetKey)
    }

    // Folding that row's native process group keeps the same card at the
    // group's own visible entry; reopening returns it to the Step entry.
    const targetRow = targetGroup !== null
      ? page.locator(`[data-chat-group-key="${targetGroup}"]`).first()
      : page.locator(`[data-chat-node-key="${targetKey}"]`).first()
    const group = targetGroup !== null
      ? targetRow
      : targetRow.locator('xpath=ancestor::*[@data-chat-group-key]').first()
    if (await group.count() > 0) {
      const header = group.locator('[data-process-activity]').first()
      if (await header.getAttribute('aria-expanded') === 'true') {
        await header.click()
        await nextPaint(page)
      }
      const foldedHost = await measureCardHost(page, 'step-event')
      expect(foldedHost?.count).toBe(1)
      expect(foldedHost?.visible, JSON.stringify(foldedHost)).toBe(true)
      expect(foldedHost?.inGroupEntry, JSON.stringify(foldedHost)).toBe(true)
      await header.click()
      await expect.poll(
        async () => (await measureCardHost(page, 'step-event'))?.count,
        { timeout: 10_000 },
      ).toBe(1)
    }

    // A durable seq that neither a row nor a Step boundary declares keeps the
    // Turn's confirmed start entry.
    const unknown = page.locator(attachmentSelector('unknown-event'))
    await unknown.waitFor({ timeout: 20_000 })
    expect(await unknown.getAttribute('data-chat-attachment-site')).toBe('turn-start')
    expect(await unknown.getAttribute('data-chat-attachment-seq')).toBe(String(turnStart.seq))
    console.log(`ISSUE18_STEP_EVENT ${JSON.stringify({
      turn: anchor.turn,
      stepStartSeq: laterStep.seq,
      targetKey,
      expandedHost,
      turnStartSeq: turnStart.seq,
    })}`)
  }, 120_000)
})

// Real Nodes integration: mount @nodes/dsh-plugin through the real Loader over
// the same Web scaffold, use the actual Nodes material tools and submission
// ledger, and verify the resulting process call identity anchors the card.
/** A held real extraction work's identity and state. */
interface RunningWorkEvidence {
  readonly workId: string
  readonly state: string
  readonly turnRef: string
  readonly submissionId?: string
  readonly revision?: number
}

/** Read this Turn's real process work; a ledger read failure surfaces to the caller. */
async function readExtractionWork(
  nodes: NodesServiceView,
  sessionId: string,
  turnRef: string,
): Promise<RunningWorkEvidence | undefined> {
  const views = await nodes.getExtractionViews({ sessionId, turnRef, limit: 20 }, new AbortController().signal)
  return views.find(candidate => candidate.kind === 'process')
}

/** Wait for the real work attempt to report running; never substitute a placeholder. */
async function waitForRunningExtractionWork(
  nodes: NodesServiceView,
  sessionId: string,
  turnRef: string,
  timeout: number,
): Promise<RunningWorkEvidence> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const work = await readExtractionWork(nodes, sessionId, turnRef)
    if (work !== undefined && work.state === 'running') return work
    await new Promise<void>(resolve => setTimeout(resolve, 100))
  }
  throw new Error('real Nodes probe: real extraction work did not reach running')
}

/** Wait until the real work leaves running; the bounded result lets cleanup cancel the child. */
async function workLeavesRunning(
  nodes: NodesServiceView,
  sessionId: string,
  turnRef: string,
  timeout: number,
): Promise<boolean> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const work = await readExtractionWork(nodes, sessionId, turnRef)
    if (work === undefined || work.state !== 'running') return true
    await new Promise<void>(resolve => setTimeout(resolve, 100))
  }
  return false
}

describe.skipIf(MODE === 'record' || NODES_REPO === undefined)('web e2e: issue 18 real Nodes process-submit call-row anchor (requires NODES_REPO)', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let adapter: RealNodesAdapter
  let agent: AgentHandle
  let events: SessionEvent[]
  let turn = 0
  let nodes: NodesServiceView
  let loaderEvidence: { entryId: string; state: number | undefined; nodesModules: string[] } | undefined
  let manualPlan: { outcome: string; message?: string } | undefined
  let modeSwitch: { outcome: string; message?: string } | undefined
  let submissionEvidence: {
    turnRef: string
    submissionId: string
    revision: number
    references: readonly string[]
  } | undefined
  let workEvidence: RunningWorkEvidence | undefined
  let childSessionId: SessionIdValue | undefined
  let submitArguments: ProcessSubmitArguments | undefined
  let tripwireErrors: () => string[]

  beforeAll(async () => {
    const nodesRepo = NODES_REPO
    if (nodesRepo === undefined) throw new Error('real Nodes probe requires NODES_REPO')
    const nodesPackageDir = join(nodesRepo, 'packages', 'nodes')
    if (!existsSync(join(nodesPackageDir, 'lib', 'index.js'))) {
      throw new Error(`real Nodes probe: built package missing at ${join(nodesPackageDir, 'lib', 'index.js')}`)
    }
    scaffold = await launchWebScaffold({
      extraInstallAnchors: [join(nodesPackageDir, 'package.json')],
      profile: { packages: [{ dir: FIXTURE, enabled: true }] },
    })
    await scaffold.ctx.settings.update('ui-chat', { transcriptView: 'standard' })
    adapter = new RealNodesAdapter()
    scaffold.ctx.effect(
      () => scaffold.ctx.llm.registerAdapter([REAL_NODES_PROVIDER], adapter),
      'issue18 real Nodes adapter',
    )
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const entryId = await mountNodes(scaffold.ctx)
    const loader = (scaffold.ctx as WebScaffold['ctx'] & { loader: LoaderView }).loader
    const entry = [...loader.entries()].find(candidate => candidate.id === entryId)
    const cache = [...(loader.internal?.loadCache?.keys?.() ?? [])]
    const nodesModules = cache.filter(url => url.includes('/packages/nodes/lib/'))
    loaderEvidence = { entryId, state: entry?.fiber?.state, nodesModules }
    if (entry?.fiber?.state !== FiberState.ACTIVE) throw new Error('real Nodes probe: Nodes package did not activate')
    if (nodesModules.length === 0) throw new Error('real Nodes probe: Loader cache has no Nodes package module')
    const service = scaffold.ctx.get('nodes') as NodesServiceView | undefined
    if (service === undefined) throw new Error('real Nodes probe: nodes service is missing')
    nodes = service
    const handle = await scaffold.ctx.agents.create({
      sessionId: SessionId(REAL_NODES_ID),
      meta: { cwd: scaffold.workspaceCwd },
      agentOptions: { provider: REAL_NODES_PROVIDER, model: 'nodes-scripted' },
    })
    agent = handle
    await scaffold.ctx.sessions.flush(agent.agent.session)
    await registerNodesSession(scaffold, workspace.id, SessionId(REAL_NODES_ID), 'real-nodes-op-1')
    // The browser lists Sessions by workspace membership, so the registered
    // Session must be a member of the workspace the page connects to.
    await workspace.attachSession(SessionId(REAL_NODES_ID))

    // Save a legal empty manual plan and switch to manual so a Context child
    // cannot compete with the scripted main-Agent model calls.
    manualPlan = await nodes.setContextSelection({
      sessionId: REAL_NODES_ID,
      expectedRevision: 0,
      items: [],
    }, new AbortController().signal)
    if (manualPlan.outcome !== 'saved') {
      throw new Error(`real Nodes probe: empty manual plan not saved: ${manualPlan.message ?? ''}`)
    }
    const beforeMode = await nodes.getContextView({ sessionId: REAL_NODES_ID }, new AbortController().signal)
    if (beforeMode.policy !== undefined && beforeMode.policy.mode !== 'manual') {
      modeSwitch = await nodes.setContextMode({
        sessionId: REAL_NODES_ID,
        expectedPolicyRevision: beforeMode.policy.policyRevision,
        mode: 'manual',
      }, new AbortController().signal)
      if (modeSwitch.outcome !== 'saved') {
        throw new Error(`real Nodes probe: manual mode not saved: ${modeSwitch.message ?? ''}`)
      }
    }

    // The Agent object is the scope key the tools registry routes by; reading
    // it here avoids depending on which module copy minted the scope tag.
    await waitUntil(
      () => scaffold.ctx.tools.get('nodes_extraction_sources', agent.agent) !== undefined
        && scaffold.ctx.tools.get('nodes_extraction_submit', agent.agent) !== undefined,
      15_000,
      'real Nodes probe: material tools were not installed for the registered main Agent',
    )

    events = []
    scaffold.ctx.on('session/event', (session, event) => {
      if (session.id !== SessionId(REAL_NODES_ID)) return
      events.push(event)
      if (event.type === 'turn/start') turn = event.data.turn
    })
    agent.agent.followup(createUserMessage({
      content: [{ type: 'text', text: REAL_NODES_PROMPT }],
      source: { kind: 'user' },
    }))
    // Gate A holds the main continuation after the accepted process result;
    // Gate B independently holds the real extraction child's model request.
    await waitUntil(
      () => adapter.holdStarted && adapter.childHoldStarted && agent.agent.status === 'running' && turn > 0,
      60_000,
      'real Nodes probe: main hold or real extraction child hold was not reached',
    )
    if (adapter.childSessionId === undefined) {
      throw new Error('real Nodes probe: held extraction child has no Session id')
    }
    childSessionId = SessionId(adapter.childSessionId)
    await waitUntil(
      () => scaffold.ctx.agents.get(childSessionId as SessionIdValue)?.status === 'running',
      15_000,
      'real Nodes probe: real extraction child did not start running',
    )
    if (events.some(event => event.type === 'turn/end')) {
      throw new Error('real Nodes probe: turn/end exists before the measured hold window')
    }
    const calls = events.filter(event => event.type === 'tool/call')
    const results = events.filter(event => event.type === 'tool/result')
    const processCall = calls.find(event => event.data.callId === REAL_NODES_PROCESS_CALL)
    const processResult = results.find(event => event.data.message.source.callId === REAL_NODES_PROCESS_CALL)
    if (processCall === undefined || processResult === undefined) {
      throw new Error('real Nodes probe: real process tool call/result is missing')
    }
    if (processResult.data.message.isError !== false) {
      throw new Error('real Nodes probe: real process tool result failed')
    }
    const meta = acceptedSubmissionMeta(processResult.data.meta)
    if (meta === undefined) throw new Error('real Nodes probe: process result has no accepted metadata')
    if (processResult.sourceEventSeqs?.includes(processCall.seq) !== true) {
      throw new Error('real Nodes probe: process result sourceEventSeqs does not point at its native call')
    }
    if (processResult.data.turn !== processCall.data.turn || processResult.data.step !== processCall.data.step) {
      throw new Error('real Nodes probe: process call/result turn or step differs')
    }
    const sourceCall = calls.find(event => event.data.callId === REAL_NODES_SOURCES_CALL)
    const sourceResult = results.find(event => event.data.message.source.callId === REAL_NODES_SOURCES_CALL)
    if (sourceCall === undefined || sourceResult === undefined) {
      throw new Error('real Nodes probe: real sources tool call/result is missing')
    }
    if (sourceResult.data.message.isError !== false) {
      throw new Error('real Nodes probe: real sources tool result failed')
    }
    if (adapter.sourceRef === undefined) throw new Error('real Nodes probe: sources receipt produced no source_ref')
    // The model must submit the reference it actually read, in this same Turn,
    // after that read: a self-written or missing reference cannot stand in.
    submitArguments = readProcessSubmitArguments(processCall.data.arguments)
    if (!submitArguments.sources.includes(adapter.sourceRef)) {
      throw new Error('real Nodes probe: process submit does not carry the read source_ref')
    }
    if (sourceCall.data.turn !== processCall.data.turn || sourceResult.data.turn !== processCall.data.turn) {
      throw new Error('real Nodes probe: sources read and process submit are in different Turns')
    }
    if (!(sourceResult.seq < processCall.seq)) {
      throw new Error('real Nodes probe: process submit does not follow the sources receipt')
    }
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const views = await nodes.getSubmissionViews({ sessionId: REAL_NODES_ID }, new AbortController().signal)
      if (views.available) {
        const view = views.turns.find(candidate => candidate.sessionId === REAL_NODES_ID
          && candidate.turn === processCall.data.turn)
        const processSubmission = view?.submissions.find(candidate => candidate.kind === 'process'
          && candidate.submissionId === meta.submissionId)
        if (view !== undefined && processSubmission !== undefined) {
          submissionEvidence = {
            turnRef: view.turnRef,
            submissionId: processSubmission.submissionId,
            revision: processSubmission.revision,
            references: processSubmission.references,
          }
          break
        }
      }
      await new Promise<void>(resolve => setTimeout(resolve, 100))
    }
    if (submissionEvidence === undefined) {
      throw new Error('real Nodes probe: persistent submission ledger did not return the accepted process submission')
    }
    if (submissionEvidence.submissionId !== meta.submissionId || submissionEvidence.revision !== meta.revision) {
      throw new Error('real Nodes probe: submission ledger identity differs from the tool receipt metadata')
    }
    // The real work was dispatched from that accepted revision; its own view
    // must name the same submission identity while the child is still running.
    workEvidence = await waitForRunningExtractionWork(
      nodes, REAL_NODES_ID, submissionEvidence.turnRef, 30_000,
    )
    if (workEvidence.submissionId !== submissionEvidence.submissionId
      || workEvidence.revision !== submissionEvidence.revision) {
      throw new Error('real Nodes probe: running work identity differs from the accepted receipt')
    }

    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    // The in-Turn layout keeps the precise row card measurable at its own row.
    await page.setViewportSize({ width: 900, height: 900 })
    const consoleWatch = watchConsole(page)
    tripwireErrors = () => [...consoleWatch.pageErrors, ...consoleWatch.warnings]
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    await openSessionBySearch(page, REAL_NODES_PROMPT)
    await page.locator(`[data-chat-call-id="${REAL_NODES_PROCESS_CALL}"]`).first()
      .waitFor({ state: 'attached', timeout: 30_000 })
  }, 180_000)

  afterAll(async () => {
    const failures: unknown[] = []
    adapter?.release()
    adapter?.releaseChild()
    await agent?.dispose().catch((error: unknown) => failures.push(error))
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'issue 18 real Nodes anchor teardown failed')
  })

  it('anchors the auto-registered card from the real Nodes accepted process submission in every disclosure state', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-issue18-real-nodes-anchor'))
    if (submissionEvidence === undefined || workEvidence === undefined || childSessionId === undefined) {
      throw new Error('real Nodes probe: hold-window evidence is incomplete')
    }
    const submission = submissionEvidence
    const work = workEvidence
    const childId = childSessionId
    /** Re-read the real main/child/work facts while the card is under assertion. */
    const assertRunningFacts = async (): Promise<void> => {
      expect(agent.agent.status).toBe('running')
      expect(adapter.holdStarted).toBe(true)
      expect(adapter.childHoldStarted).toBe(true)
      expect(events.some(event => event.type === 'turn/end')).toBe(false)
      expect(scaffold.ctx.agents.get(childId)?.status).toBe('running')
      const running = await readExtractionWork(nodes, REAL_NODES_ID, submission.turnRef)
      expect(running?.workId).toBe(work.workId)
      expect(running?.state).toBe('running')
      expect(running?.submissionId).toBe(submission.submissionId)
      expect(running?.revision).toBe(submission.revision)
      expect(await page.getByRole('button', { name: 'Stop generating' }).count()).toBe(1)
    }

    const toolRow = page.locator(`[data-chat-call-id="${REAL_NODES_PROCESS_CALL}"]`).first()
    const sourceRow = page.locator(`[data-chat-call-id="${REAL_NODES_SOURCES_CALL}"]`).first()
    await expect.poll(() => sourceRow.count(), { timeout: 10_000 }).toBe(1)
    const groupHeader = toolRow.locator('xpath=ancestor::*[@data-chat-group-key]').first()
      .locator('[data-process-activity]').first()
    await expect.poll(() => groupHeader.isVisible(), { timeout: 20_000 }).toBe(true)
    if (await groupHeader.getAttribute('aria-expanded') === 'true') {
      await groupHeader.click()
      await nextPaint(page)
    }

    // No fixture or manual card: the Nodes client registers from the real
    // running extraction work and its accepted native submit identity.
    const card = page.locator('[data-nodes-extraction-card]')
    await expect.poll(() => card.count(), { timeout: 30_000 }).toBe(1)
    const cardRow = page.locator('[data-chat-flow-kind="attachment"]').first()
    await expect.poll(
      () => cardRow.getAttribute('data-chat-attachment-site'),
      { timeout: 30_000 },
    ).toBe('tool-call')
    const cardId = await cardRow.getAttribute('data-chat-attachment')
    const targetNodeKey = await cardRow.getAttribute('data-chat-attachment-target')
    expect(cardId).toMatch(/^nodes-extraction-/u)
    expect(cardId).toContain(work.workId)
    expect(await card.getAttribute('data-nodes-extraction-state')).toBe('running')
    expect(await card.getAttribute('data-nodes-extraction-turn')).toBe(String(turn))
    expect(await cardRow.getAttribute('data-chat-attachment-call')).toBe(REAL_NODES_PROCESS_CALL)
    expect(await page.locator('[data-chat-flow-kind="attachment"]').count()).toBe(1)
    const cardLocator = page.locator(`[data-chat-attachment="${cardId}"]`)

    await assertRunningFacts()
    const groupEntry = await measureProcessAnchor(page, {
      cardId: cardId as string,
      callId: REAL_NODES_PROCESS_CALL,
      toolCallIds: [REAL_NODES_PROCESS_CALL, REAL_NODES_SOURCES_CALL],
    })
    expect(await cardLocator.count()).toBe(1)
    expect(await cardLocator.isVisible()).toBe(true)
    expect(groupEntry.cardAtGroupEntry, JSON.stringify(groupEntry)).toBe(true)
    expect(groupEntry.cardInGroupBody).toBe(false)
    expect(groupEntry.precise).toBe(false)
    expect(groupEntry.card?.site).toBe('tool-call')

    await groupHeader.click()
    await expect.poll(() => toolRow.isVisible(), { timeout: 10_000 }).toBe(true)
    await assertRunningFacts()
    const expanded = await measureProcessAnchor(page, {
      cardId: cardId as string,
      callId: REAL_NODES_PROCESS_CALL,
      toolCallIds: [REAL_NODES_PROCESS_CALL, REAL_NODES_SOURCES_CALL],
    })
    expect(await cardLocator.count()).toBe(1)
    expect(expanded.cardInTargetToolSeat, JSON.stringify(expanded)).toBe(true)
    expect(expanded.precise, JSON.stringify(expanded)).toBe(true)
    const processGap = expanded.tools.find(tool => tool.callId === REAL_NODES_PROCESS_CALL)?.gapToCard
    const sourceGap = expanded.tools.find(tool => tool.callId === REAL_NODES_SOURCES_CALL)?.gapToCard
    expect(processGap).not.toBeNull()
    expect(sourceGap).not.toBeNull()
    expect(Math.abs(processGap ?? 0)).toBeLessThan(Math.abs(sourceGap ?? 0))

    await groupHeader.click()
    await expect.poll(() => toolRow.isVisible(), { timeout: 10_000 }).toBe(false)
    const groupEntryAgain = await measureProcessAnchor(page, {
      cardId: cardId as string,
      callId: REAL_NODES_PROCESS_CALL,
      toolCallIds: [REAL_NODES_PROCESS_CALL, REAL_NODES_SOURCES_CALL],
    })
    expect(await cardLocator.count()).toBe(1)
    expect(groupEntryAgain.cardAtGroupEntry, JSON.stringify(groupEntryAgain)).toBe(true)
    expect(groupEntryAgain.cardInGroupBody).toBe(false)

    await groupHeader.click()
    await expect.poll(() => toolRow.isVisible(), { timeout: 10_000 }).toBe(true)
    const expandedAgain = await measureProcessAnchor(page, {
      cardId: cardId as string,
      callId: REAL_NODES_PROCESS_CALL,
      toolCallIds: [REAL_NODES_PROCESS_CALL, REAL_NODES_SOURCES_CALL],
    })
    expect(await cardLocator.count()).toBe(1)
    expect(expandedAgain.precise, JSON.stringify(expandedAgain)).toBe(true)
    expect(targetNodeKey).toBeTruthy()
    expect(await cardRow.getAttribute('data-chat-attachment-target')).toBe(targetNodeKey)

    // Still inside the real Nodes active window: main Agent running, its
    // continuation parked, the extraction child running, no turn/end.
    await assertRunningFacts()

    const calls = events.filter(event => event.type === 'tool/call')
    const results = events.filter(event => event.type === 'tool/result')
    const processCall = calls.find(event => event.data.callId === REAL_NODES_PROCESS_CALL)
    const processResult = results.find(event => event.data.message.source.callId === REAL_NODES_PROCESS_CALL)
    const sourceResult = results.find(event => event.data.message.source.callId === REAL_NODES_SOURCES_CALL)
    const sourceCall = calls.find(event => event.data.callId === REAL_NODES_SOURCES_CALL)
    if (processCall === undefined || processResult === undefined || sourceResult === undefined
      || sourceCall === undefined) {
      throw new Error('real Nodes probe: real tool events disappeared from the hold window')
    }
    const meta = acceptedSubmissionMeta(processResult.data.meta)
    if (meta === undefined) {
      throw new Error('real Nodes probe: accepted submission evidence is incomplete')
    }
    if (submitArguments === undefined) {
      throw new Error('real Nodes probe: process submit arguments were not captured')
    }
    if (submission.submissionId !== meta.submissionId || submission.revision !== meta.revision
      || work.submissionId !== meta.submissionId || work.revision !== meta.revision) {
      throw new Error('real Nodes probe: receipt, ledger, and work identities differ')
    }

    const holdEvidence = {
      agentStatus: agent.agent.status,
      adapterHoldStarted: adapter.holdStarted,
      childHoldStarted: adapter.childHoldStarted,
      childSessionId: adapter.childSessionId,
      childStatus: scaffold.ctx.agents.get(childId)?.status,
      turnEnded: false,
      mainCalls: adapter.mainCalls,
      auxiliaryCalls: adapter.auxiliaryCalls,
      sourceRef: adapter.sourceRef,
      processCall: {
        callId: processCall.data.callId,
        name: processCall.data.name,
        turn: processCall.data.turn,
        step: processCall.data.step,
        seq: processCall.seq,
        arguments: submitArguments,
      },
      sourceCall: {
        callId: sourceCall.data.callId,
        name: sourceCall.data.name,
        turn: sourceCall.data.turn,
        step: sourceCall.data.step,
        seq: sourceCall.seq,
      },
      processResult: {
        turn: processResult.data.turn,
        step: processResult.data.step,
        seq: processResult.seq,
        isError: processResult.data.message.isError,
        meta: processResult.data.meta,
        sourceEventSeqs: processResult.sourceEventSeqs,
      },
      sourceResult: {
        callId: sourceResult.data.message.source.callId,
        isError: sourceResult.data.message.isError,
        seq: sourceResult.seq,
      },
      submissionEvidence: submission,
      workEvidence: work,
      loaderEvidence,
      manualPlan,
      modeSwitch,
      pageErrors: tripwireErrors(),
    }
    const cardEvidence = {
      id: cardId,
      workId: work.workId,
      state: await card.getAttribute('data-nodes-extraction-state'),
      turn: await card.getAttribute('data-nodes-extraction-turn'),
      anchor: await card.getAttribute('data-nodes-extraction-anchor'),
      site: await cardRow.getAttribute('data-chat-attachment-site'),
      call: await cardRow.getAttribute('data-chat-attachment-call'),
      target: await cardRow.getAttribute('data-chat-attachment-target'),
      count: await page.locator('[data-nodes-extraction-card]').count(),
    }
    console.log(`ISSUE18_REAL_NODES_ANCHOR_EVIDENCE ${JSON.stringify({
      holdEvidence, cardEvidence, groupEntry, expanded, groupEntryAgain, expandedAgain,
    })}`)

    // Release the real follow-up request and verify normal completion while the
    // extraction card keeps its exact call row.
    adapter.release()
    await agent.agent.whenIdle()
    await expect.poll(
      () => events.find(event => event.type === 'turn/end')?.data.reason.kind,
      { timeout: 20_000 },
    ).toBe('completed')
    await page.locator(`[data-turn-tail="${turn}"]`).waitFor({ timeout: 20_000 })
    await expect.poll(
      () => page.getByText('ISSUE18_REAL_NODES_DONE', { exact: false }).count(),
      { timeout: 20_000 },
    ).toBeGreaterThan(0)
    const finalTextVisible = await page.getByText('ISSUE18_REAL_NODES_DONE', { exact: false }).count() > 0

    // The approved design moves a still-running process card to the real turn
    // tail once that Turn ends; the work is still running under its child gate.
    await expect.poll(
      () => cardRow.getAttribute('data-chat-attachment-site'),
      { timeout: 20_000 },
    ).toBe('turn-end')
    const afterTurnEnd = await measureProcessAnchor(page, {
      cardId: cardId as string,
      callId: REAL_NODES_PROCESS_CALL,
      toolCallIds: [REAL_NODES_PROCESS_CALL, REAL_NODES_SOURCES_CALL],
    })
    expect(await cardLocator.count()).toBe(1)
    expect(await cardLocator.isVisible()).toBe(true)
    expect(afterTurnEnd.card?.site).toBe('turn-end')
    expect(afterTurnEnd.card?.turn).toBe(String(turn))
    const previousRoot = await page.evaluate((id) => {
      const card = document.querySelector(`[data-chat-attachment="${id}"]`)
      const row = card?.closest('[data-chat-attachment-row]')
      const previous = row?.previousElementSibling ?? null
      return {
        kind: previous?.getAttribute('data-chat-flow-kind') ?? null,
        turnTail: previous?.querySelector('[data-turn-tail]')?.getAttribute('data-turn-tail') ?? null,
      }
    }, cardId as string)
    expect(previousRoot.kind).toBe('turn-tail')
    expect(previousRoot.turnTail).toBe(String(turn))
    expect(await card.getAttribute('data-nodes-extraction-state')).toBe('running')
    expect(agent.agent.status).toBe('idle')

    // Ordered teardown: release the extraction child's gate, let the real work
    // settle, and only cancel the child if it does not settle on its own. The
    // activity card must leave with the work; the review path stays unchanged.
    adapter.releaseChild()
    let settled = await workLeavesRunning(nodes, REAL_NODES_ID, submission.turnRef, 20_000)
    let childCanceled = false
    if (!settled) {
      const child = scaffold.ctx.agents.get(childId)
      if (child !== undefined) {
        childCanceled = true
        child.cancel({ kind: 'user' })
        await child.whenIdle()
      }
      settled = await workLeavesRunning(nodes, REAL_NODES_ID, submission.turnRef, 20_000)
    }
    await expect.poll(
      () => page.locator('[data-nodes-extraction-card]').count(),
      { timeout: 20_000 },
    ).toBe(0)
    const finalWork = await readExtractionWork(nodes, REAL_NODES_ID, submission.turnRef)
    expect(finalWork?.state).not.toBe('running')
    expect(tripwireErrors()).toEqual([])

    mkdirSync(dirname(REAL_NODES_EVIDENCE_PATH), { recursive: true })
    writeFileSync(REAL_NODES_EVIDENCE_PATH, `${JSON.stringify({
      sessionId: REAL_NODES_ID,
      turn,
      processCallId: REAL_NODES_PROCESS_CALL,
      sourcesCallId: REAL_NODES_SOURCES_CALL,
      sourceRef: adapter.sourceRef,
      loader: loaderEvidence,
      manualPlan,
      modeSwitch,
      holdWindow: holdEvidence,
      submissionEvidence: submission,
      workEvidence: work,
      cardEvidence,
      groupEntry,
      expanded,
      groupEntryAgain,
      expandedAgain,
      completed: {
        agentStatus: agent.agent.status,
        turnEnd: events.find(event => event.type === 'turn/end')?.data.reason,
        finalTextVisible,
        afterTurnEnd,
        turnTailPreviousRoot: previousRoot,
      },
      cleanup: {
        childReleased: !adapter.childHoldStarted,
        childCanceled,
        workFinalState: finalWork?.state ?? 'unknown',
        cardStillMounted: await page.locator('[data-nodes-extraction-card]').count(),
      },
    }, null, 2)}\n`)
  }, 180_000)
})
