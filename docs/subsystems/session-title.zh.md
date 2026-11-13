# 会话标题

[English](session-title.md) | 中文

[`@deepseek-ai/dsh-session-title`](../../packages/session/session-title) 所拥有的持久、后写覆盖的标题状态与可选异步提供方词汇。共享执行模块负责精确的辅助请求记录。标题可以来自直接准入的人类消息，也可以来自 Host 先 claim、再以改写后的 source 准入的人类 Inbox occurrence；后者冻结精确输入引用，而不会把有效消息 seq 表述为人类 `user/message`。各包 README 负责时序、回退、失败与 fork 行为；生成的[持久化日志事件目录](../persistence-catalog.zh.md)负责完整的事件声明。

源码：[`packages/session/session-title/src/index.ts`](../../packages/session/session-title/src/index.ts)、[`packages/session/session-title-llm/src/index.ts`](../../packages/session/session-title-llm/src/index.ts)

## 持久标题状态

提供方生成修订时会记录 `SessionTitleProviderId`。`SessionTitleEventData` 列出生成标题时使用的精确人类消息 seq，`SessionTitleSnapshot` 则加入 `ctx.sessionTitle.get()` 与 `foldSessionTitle()` 返回的持久事件封装信息。来自被 claim 的 Inbox occurrence 的标题由 `session/title-from-input` 记录，其 `SessionTitleInputRef` 逐项标识普通人类消息，或原始 occurrence、其 claim 与准入消息。`title` 投影的客户端视图仍只保留标题字符串或 `null`；版本 2 的折叠同时接受两种标题事件。

```ts type-equiv
/** Identifies one session-title provider registration. */
type SessionTitleProviderId = Branded<'SessionTitleProviderId'>
```

```ts type-equiv
/** Exact auxiliary model route that produced a title. */
interface SessionTitleModelIdentity {
  /** Registered LLM provider route. */
  readonly provider: string
  /** Provider model id. */
  readonly model: string
}
```

```ts type-equiv
/** Durable ownership record for an accepted session title. */
type SessionTitleSource =
  | { readonly kind: 'fallback' }
  | {
    readonly kind: 'provider'
    readonly provider: SessionTitleProviderId
    readonly model?: SessionTitleModelIdentity
  }
  | {
    /** Explicit user rename: pins the title — automatic generation stops scheduling. */
    readonly kind: 'user'
  }
```

```ts type-equiv
/**
 * Non-user source for an origin-derived title.
 *
 * A manual rename must use `session/title` with the user source; the
 * from-input record can therefore never fabricate a user pin.
 */
type SessionTitleGeneratedSource = Exclude<SessionTitleSource, { kind: 'user' }>
```

```ts type-equiv
/** Payload of the log-only `session/title` event. */
interface SessionTitleEventData {
  /** Normalized non-empty title text. */
  readonly title: string
  /**
   * Exact human `user/message` seqs used to derive this title; empty only for
   * an explicit user rename. An origin-derived title never writes this field:
   * it uses `session/title-from-input` and `inputRefs` instead.
   */
  readonly messageSeqs: SessionSeq[]
  /** Whether the built-in fallback, a registered provider, or the user supplied the title. */
  readonly source: SessionTitleSource
}
```

```ts type-equiv
/**
 * One exact input reference frozen by the title service.
 *
 * A directly admitted human message cites only its `user/message` seq. A
 * rewrite of a claimed human Inbox occurrence cites the occurrence, the claim,
 * and the admitted message, because no human `user/message` exists for it.
 */
type SessionTitleInputRef =
  | {
    /** An ordinary human `user/message` and its exact event seq. */
    readonly kind: 'message'
    readonly messageSeq: SessionSeq
  }
  | {
    /** A rewrite of a claimed human Inbox occurrence. */
    readonly kind: 'origin'
    /** Seq of the `agent/inbox/spliced` event that inserted the occurrence. */
    readonly originalInboxSeq: SessionSeq
    /** Message identity repeated by the admitted rewrite. */
    readonly messageId: MessageId
    /** Claim splice seq that removed the occurrence. */
    readonly claimSeq: SessionSeq
    /** Seq of the admitted `user/message` event. */
    readonly admittedSeq: SessionSeq
  }
```

```ts type-equiv
/**
 * Payload of the log-only `session/title-from-input` event.
 *
 * Used when at least one selected input is a rewrite of a claimed human Inbox
 * occurrence, so no human `user/message` seq can carry its attribution.
 */
interface SessionTitleFromInputEventData {
  /** Normalized non-empty title text. */
  readonly title: string
  /** Exact admitted input references, in admission order. */
  readonly inputRefs: SessionTitleInputRef[]
  /** Whether the built-in fallback or a registered provider supplied the title. */
  readonly source: SessionTitleGeneratedSource
}
```

```ts type-equiv
/** Latest folded title plus the title event's durable envelope facts. */
interface SessionTitleSnapshot extends SessionTitleEventData {
  /** Seq of the latest title event. */
  readonly eventSeq: SessionSeq
  /** Timestamp of the latest title event. */
  readonly updatedAt: number
  /**
   * Exact input references when the latest title came from
   * `session/title-from-input`; `messageSeqs` is empty for that title.
   */
  readonly inputRefs?: readonly SessionTitleInputRef[]
}
```

## 辅助请求记录

共享执行模块会在调用模型前，记录每一项已经过验证且可分发的标题请求。即使后续生成失败，载荷仍会复现模型可见的系统输入与消息输入、路由、输出上限、解析后的推理强度、提供方归属和源消息归因。若所选输入包含被 claim 的 Inbox occurrence，则写入 `session/title-llm-request-from-input`，以冻结的 `inputRefs` 取代 `messageSeqs`；其 `messages` 恰好是一条 user 消息，以单个 text 块携带提供方输入。

```ts type-equiv
/** Exact model-visible request recorded before one auxiliary title dispatch. */
interface SessionTitleLlmRequestEventData {
  /** Registered title-provider identity responsible for the request. */
  readonly titleProvider: SessionTitleProviderId
  /** Exact human `user/message` seqs represented in `messages`. */
  readonly messageSeqs: SessionSeq[]
  /** Exact auxiliary LLM route. */
  readonly route: SessionTitleModelIdentity
  /** Exact auxiliary system prompt. */
  readonly system: string
  /** Exact auxiliary message list. */
  readonly messages: Message[]
  /** Exact auxiliary output-token cap. */
  readonly maxTokens: number
  /** Resolved reasoning effort when recorded; older requests can omit it. */
  readonly reasoningEffort?: ReasoningEffortId
}
```

```ts type-equiv
/** Exact model-visible request for a title derived from claimed Inbox occurrences. */
interface SessionTitleLlmRequestFromInputEventData {
  /** Registered title-provider identity responsible for the request. */
  readonly titleProvider: SessionTitleProviderId
  /** Exact admitted input references represented in `messages`, in admission order. */
  readonly inputRefs: SessionTitleInputRef[]
  /** Exact auxiliary LLM route. */
  readonly route: SessionTitleModelIdentity
  /** Exact auxiliary system prompt. */
  readonly system: string
  /** The one exact auxiliary user message: one text block from the provider's input. */
  readonly messages: readonly [SessionTitleLlmRequestMessage]
  /** Exact auxiliary output-token cap. */
  readonly maxTokens: number
  /** Resolved reasoning effort when recorded; older requests can omit it. */
  readonly reasoningEffort?: ReasoningEffortId
}
```

```ts type-equiv
/** The one auxiliary user message a from-input title request records. */
interface SessionTitleLlmRequestMessage {
  /** Stable identity created with the auxiliary request. */
  readonly id: MessageId
  /** Auxiliary requests are user-role messages. */
  readonly role: 'user'
  /** Exactly the provider's user input as one text block. */
  readonly content: readonly [Extract<ContentBlock, { type: 'text' }>]
  /** The title-LLM producer, the only source that creates these messages. */
  readonly source: { readonly kind: 'dsh-session-title-llm' }
}
```

## 提供方输入与输出

服务会对截至某一修订的合格输入、以及在每次提供方调用前刚刚确保的回退和最新已接纳标题创建快照。合格输入包括直接准入的人类消息，或经 claim 后同一 Turn 进入 step、再以相同 id 与相同关联准入的人类 Inbox occurrence；后者使用原始 occurrence 的文本与精确引用。提供方返回的 seq 仅可来自该请求；由服务负责的接纳流程会验证顺序、把每个所选 seq 映射到冻结引用、规范化标题、强制执行字节上限，并追加标题及其来源。

```ts type-equiv
/** One eligible title input exposed to title providers. */
interface SessionTitleUserMessage {
  /** Seq of the `user/message` event that admitted this input. */
  readonly seq: SessionSeq
  /** Exact concatenated text-block content. */
  readonly text: string
}
```

```ts type-equiv
/** Automatic generation cadence owned by a registered provider. */
type SessionTitleAutomaticMode = 'first-prompt' | 'all-prompts'
```

```ts type-equiv
/** Immutable input supplied to one title-provider call. */
interface SessionTitleProviderRequest {
  /** Live session being titled. */
  readonly session: Session
  /** All eligible human messages through this generation revision. */
  readonly messages: readonly SessionTitleUserMessage[]
  /** Exact input references parallel to {@link messages}, frozen by the service. */
  readonly inputRefs: readonly SessionTitleInputRef[]
  /** Exact current logged main-request route, when one has been recorded. */
  readonly route?: SessionTitleModelIdentity
  /**
   * Latest accepted title captured at invocation, including an accepted
   * fallback whose event may follow the last eligible message. Absent before
   * any title is accepted. The provider decides whether and how to use it.
   */
  readonly currentTitle?: SessionTitleSnapshot
  /** Cancellation for supersession, disposal, timeout composition, or the explicit caller. */
  readonly signal: AbortSignal
}
```

```ts type-equiv
/** Provider output before service-owned normalization and log acceptance. */
interface SessionTitleProviderResult {
  /** Proposed title text. */
  readonly title: string
  /** Exact seqs from `request.messages` used by this result. */
  readonly messageSeqs: readonly SessionSeq[]
  /** Auxiliary LLM route, when generation used a model. */
  readonly model?: SessionTitleModelIdentity
}
```

```ts type-equiv
/** One optional asynchronous title implementation registered with the service. */
interface SessionTitleProvider {
  /** Stable id of the provider recorded with the title. */
  readonly id: SessionTitleProviderId
  /** When new human prompts start automatic generation. */
  readonly automatic: SessionTitleAutomaticMode
  /**
   * Produce one title revision.
   * @param request - message snapshot, current title, current route, session, and cancellation.
   * @returns proposed title plus exact input seqs and the optional provider/model route used to generate it.
   */
  generate(request: SessionTitleProviderRequest): Promise<SessionTitleProviderResult>
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxsessiontitle--sessiontitleservice"></a>

### `ctx.sessionTitle` — `SessionTitleService`

Log-backed title fold plus asynchronous fallback generation.

```ts cordis-catalog
/**
 * Read the latest folded title from one live or replayed session.
 * @param session - session whose log is the title source of truth.
 * @returns latest title snapshot, or `undefined` before eligible input.
 */
get(session: Session): SessionTitleSnapshot | undefined

/**
 * Accept an explicit user title. Appends a `session/title` event with the
 * `user` source, which pins the title: in-flight automatic generation is
 * superseded and later user messages schedule none (an explicit
 * {@link SessionTitleService.refresh} remains the deliberate unpin).
 * @param session - exact live session to rename.
 * @param title - raw user input; normalized before acceptance.
 * @returns the accepted title snapshot.
 * @throws {SessionTitleInvalidError} when the title normalizes to empty.
 * @throws {Error} when the session is not live or the service is disposed.
 */
rename(session: Session, title: string): SessionTitleSnapshot

/**
 * Explicitly retry the registered provider, or materialize the built-in
 * fallback when no provider is registered.
 * @param session - exact live session to refresh.
 * @param signal - optional caller cancellation.
 * @returns latest accepted title, or `undefined` when no eligible text exists.
 */
async refresh(session: Session, signal?: AbortSignal): Promise<SessionTitleSnapshot | undefined>

/**
 * Register the sole optional title provider. Disposal aborts its pending and
 * active work; a replacement may register once disposal has started, and the
 * closing provider's late results never commit.
 * @param provider - provider identity, cadence, and generation function.
 * @returns exact Cordis effect disposer, which settles after active calls quiesce.
 */
register(provider: SessionTitleProvider): () => Promise<void>
```

Types: [Session](session.zh.md)

Source: [`packages/session/session-title/src/index.ts`](../../packages/session/session-title/src/index.ts)
<!-- END GENERATED cordis-surface -->
