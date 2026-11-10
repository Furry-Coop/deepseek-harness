import type { ChatNodeKind } from './chat-nodes.ts'

/** Business data for Chat process groups; source Nodes remain in the Chat store. */
export type ProcessActivity = 'read' | 'readImage' | 'search' | 'write' | 'edit' | 'commands' | 'code'
  | 'webSearch' | 'webFetch' | 'subagents' | 'plan' | 'questions' | 'tools'

/** A contributing Node selected as the running group's title. */
export interface ProcessActivityContribution {
  /** Chat Node whose keyed renderer supplies the localized title. */
  readonly key: string
  readonly kind: ChatNodeKind
  /** Node start position compared against the running native selection or the latest visible native activity. */
  readonly anchorSeq: number
}

/** Distinct-call category ranking and the current live task detail. */
export interface ProcessActivitySummary {
  readonly counts: readonly { readonly kind: ProcessActivity; readonly count: number }[]
  readonly running: ProcessActivity | undefined
  readonly runningDetail: string
  /** Present only while the selected live activity has not reached tool/call. */
  readonly preparing?: true
  /** Latest running Node contribution, when it starts after the running native selection or the latest visible native activity. */
  readonly contribution?: ProcessActivityContribution | undefined
}

/** Presentation facts for one group between independent replies or input. */
export interface ProcessGroupData {
  readonly turn: number
  readonly closed: boolean
  readonly summary: ProcessActivitySummary
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationGroupDataMap {
    chat: ProcessGroupData
  }
}
