/** Chat resolves attachment anchors against real Turn boundaries and loaded rows. */
import { describe, expect, it } from 'vitest'
import { SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {
  ConversationAttachment, ConversationLocationDataStore, ConversationStepDataMap, ConversationTurnDataMap,
  NodeKey, RenderEntry, StepLocation, TurnLocation,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatConversationViewNode } from '../src/client/contract/chat-nodes.ts'
import {
  resolveChatAttachmentPlacements, sameChatAttachmentPlacements, type ChatAttachmentScene,
} from '../src/client/chat/attachments.ts'

const SESSION = SessionId('attachment-chat')

const turnData: ConversationLocationDataStore<ConversationTurnDataMap> = {
  get: () => undefined,
  source: () => ({ getSnapshot: () => undefined, subscribe: () => () => {} }),
}

function turnStart(turn: number, seq: number): SessionEvent<'turn/start'> {
  return { type: 'turn/start', seq: SessionSeq(seq), time: seq, data: { turn } }
}

function turnEnd(turn: number, seq: number): SessionEvent<'turn/end'> {
  return {
    type: 'turn/end',
    seq: SessionSeq(seq),
    time: seq,
    data: { turn, reason: { kind: 'completed' } },
  }
}

function turn(turnNumber: number, start: number | undefined, end: number | undefined): TurnLocation {
  return {
    turn: turnNumber,
    start: start === undefined ? undefined : turnStart(turnNumber, start),
    end: end === undefined ? undefined : turnEnd(turnNumber, end),
    status: start === undefined && end === undefined ? 'unknown' : end === undefined ? 'open' : 'closed',
    steps: [],
    data: turnData,
  }
}

const STEP_DATA: ConversationLocationDataStore<ConversationStepDataMap> = {
  get: () => undefined,
  source: () => ({ getSnapshot: () => undefined, subscribe: () => () => {} }),
}

function stepLocation(turnNumber: number, step: number, start: number, end?: number): StepLocation {
  return {
    turn: turnNumber,
    step,
    start: { type: 'step/start', seq: SessionSeq(start), time: start, data: { turn: turnNumber, step } },
    end: end === undefined
      ? undefined
      : { type: 'step/end', seq: SessionSeq(end), time: end, data: { turn: turnNumber, step } },
    status: end === undefined ? 'open' : 'closed',
    data: STEP_DATA,
  }
}

function withSteps(location: TurnLocation, steps: readonly StepLocation[]): TurnLocation {
  return { ...location, steps }
}

function node(
  key: string,
  owner: TurnLocation | undefined,
  anchorSeq: number,
  toolCallId?: string,
  sourceSeq?: number,
  step?: StepLocation,
  visibility: 'visible' | 'hidden' = 'visible',
): ChatConversationViewNode {
  return {
    key,
    kind: toolCallId === undefined ? 'probe' : 'tool-call',
    id: key,
    target: 'chat',
    data: toolCallId === undefined ? {} : { root: { callId: toolCallId } },
    anchorSeq,
    ...sourceSeq === undefined ? {} : { sourceSeq },
    location: owner === undefined
      ? { kind: 'session' }
      : step === undefined ? { kind: 'turn', turn: owner } : { kind: 'step', turn: owner, step },
    visibility,
  }
}

function scene(
  turns: readonly TurnLocation[],
  rows: readonly {
    key: string
    turn: number | undefined
    seq: number
    toolCallId?: string
    sourceSeq?: number
    step?: StepLocation
    visibility?: 'visible' | 'hidden'
  }[],
  attachments: readonly ConversationAttachment[],
): ChatAttachmentScene {
  const turnMap = new Map(turns.map(entry => [entry.turn, entry]))
  const nodes = new Map(rows.map((row) => {
    const owner = row.turn === undefined ? undefined : turnMap.get(row.turn)
    return [row.key, node(row.key, owner, row.seq, row.toolCallId, row.sourceSeq, row.step, row.visibility)]
  }))
  const entries: RenderEntry[] = rows.map(row => ({ kind: 'node', key: row.key as NodeKey }))
  return {
    attachments,
    entries,
    turns: turnMap,
    nodes: [...nodes.values()],
    nodeOf: key => nodes.get(key),
    groupMembers: () => undefined,
  }
}

function card(
  id: string,
  anchor: ConversationAttachment['anchor'],
): ConversationAttachment {
  return { id, sessionId: SESSION, side: 'left', anchor }
}

const TURN_1 = turn(1, 1, 5)
const TURN_2_OPEN = turn(2, 6, undefined)
const CLOSED_TURNS = [TURN_1]
const OPEN_TURNS = [TURN_1, TURN_2_OPEN]
const CLOSED_ROWS = [
  { key: 't1-input', turn: 1, seq: 1, sourceSeq: 1 },
  { key: 't1-reply', turn: 1, seq: 4, sourceSeq: 4 },
  { key: 't1-tail', turn: 1, seq: 5, sourceSeq: 5 },
  { key: 't2-input', turn: 2, seq: 6, sourceSeq: 6 },
  { key: 't2-process', turn: 2, seq: 8, sourceSeq: 8 },
]

describe('Chat attachment anchor resolution', () => {
  it('mounts a turn-start card before that Turn input', () => {
    const result = resolveChatAttachmentPlacements(scene(
      CLOSED_TURNS, CLOSED_ROWS, [card('start', { kind: 'turn-start', turn: 1 })],
    ))
    expect(result).toMatchObject([{ site: 'turn-start', turn: 1, seq: 1, index: 0 }])
  })

  it('moves a turn-end card past the real turn/end tail', () => {
    const result = resolveChatAttachmentPlacements(scene(
      CLOSED_TURNS, CLOSED_ROWS, [card('end', { kind: 'turn-end', turn: 1 })],
    ))
    expect(result).toMatchObject([{ site: 'turn-end', turn: 1, seq: 5, index: 3 }])
  })

  it('keeps the same card id at the Turn start while the Turn is open', () => {
    const result = resolveChatAttachmentPlacements(scene(
      OPEN_TURNS, CLOSED_ROWS, [card('same-card', { kind: 'turn-end', turn: 2 })],
    ))
    expect(result).toMatchObject([{ attachment: { id: 'same-card' }, site: 'turn-start', turn: 2, seq: 6, index: 3 }])
  })

  it('places an event card before the loaded row that declares its durable seq', () => {
    const resolved = resolveChatAttachmentPlacements(scene(
      OPEN_TURNS, CLOSED_ROWS, [
        card('event', { kind: 'event', turn: 2, seq: SessionSeq(8) }),
      ],
    ))
    expect(resolved).toMatchObject([{ site: 'event', turn: 2, seq: 8, index: 4 }])
    const covered = resolveChatAttachmentPlacements(scene(
      OPEN_TURNS, CLOSED_ROWS, [
        card('event', { kind: 'event', turn: 2, seq: SessionSeq(6) }),
      ],
    ))
    expect(covered).toMatchObject([{ site: 'event', turn: 2, seq: 6, index: 3 }])
  })

  it('mounts a step/start event at that loaded Step entry instead of approximating a row', () => {
    const stepOne = stepLocation(1, 1, 1, 4)
    const stepTwo = stepLocation(1, 2, 5)
    const turnWithSteps = withSteps(TURN_1, [stepOne, stepTwo])
    const rows = [
      { key: 't1-input', turn: 1, seq: 1, sourceSeq: 1, step: stepOne },
      { key: 't1-reply', turn: 1, seq: 4, sourceSeq: 4, step: stepOne },
      // The second Step's first row is a process row; its own step/start seq
      // never renders as a row of its own.
      { key: 't1-tool', turn: 1, seq: 6, step: stepTwo },
      { key: 't1-tail', turn: 1, seq: 8, sourceSeq: 8, step: stepTwo },
    ]
    const result = resolveChatAttachmentPlacements(scene(
      [turnWithSteps], rows, [card('step', { kind: 'event', turn: 1, seq: SessionSeq(5) })],
    ))
    expect(result).toMatchObject([{
      site: 'event', turn: 1, seq: 5, index: null, targetNodeKey: 't1-tool',
    }])
    expect(result[0]?.targetCallId).toBeUndefined()
    // The first visible row of the Step is its entry; a hidden earlier row does
    // not leave the card without a surface.
    const hiddenFirst = [
      { key: 't1-hidden', turn: 1, seq: 5.5, step: stepTwo, visibility: 'hidden' as const },
      { key: 't1-visible', turn: 1, seq: 6, step: stepTwo },
    ]
    const visibleEntry = resolveChatAttachmentPlacements(scene(
      [turnWithSteps], hiddenFirst, [card('step', { kind: 'event', turn: 1, seq: SessionSeq(5) })],
    ))
    expect(visibleEntry).toMatchObject([{ site: 'event', targetNodeKey: 't1-visible' }])
  })

  it('hosts a step/start whose rows live in the process group at that group entry', () => {
    const stepOne = stepLocation(1, 1, 1, 4)
    const stepTwo = stepLocation(1, 2, 5)
    const turnWithSteps = withSteps(TURN_1, [stepOne, stepTwo])
    const nodes = new Map<string, ChatConversationViewNode>([
      ['t1-input', node('t1-input', turnWithSteps, 1, undefined, 1, stepOne)],
      ['t1-tool', node('t1-tool', turnWithSteps, 6, 'call-tool', undefined, stepTwo)],
      ['t1-tail', node('t1-tail', turnWithSteps, 8, undefined, 8, stepTwo)],
    ])
    const sceneInput: ChatAttachmentScene = {
      attachments: [
        card('step', { kind: 'event', turn: 1, seq: SessionSeq(5) }),
        card('tool', { kind: 'tool-call', turn: 1, callId: 'call-tool' }),
      ],
      entries: [
        { kind: 'node', key: 't1-input' as NodeKey },
        { kind: 'group', key: 'g-1' as never },
        { kind: 'node', key: 't1-tail' as NodeKey },
      ],
      turns: new Map([[1, turnWithSteps]]),
      nodes: [...nodes.values()],
      nodeOf: key => nodes.get(key),
      groupMembers: key => key === 'g-1'
        ? [{ kind: 'node', key: 't1-tool' as NodeKey }]
        : undefined,
    }
    const result = resolveChatAttachmentPlacements(sceneInput)
    // The Step entry is the group's visible entry, and the tool call keeps its
    // own member row inside that group.
    expect(result).toMatchObject([
      { attachment: { id: 'step' }, site: 'event', turn: 1, seq: 5, index: null, targetGroupKey: 'g-1' },
      { attachment: { id: 'tool' }, site: 'tool-call', turn: 1, index: null, targetNodeKey: 't1-tool' },
    ])
  })

  it('keeps a row presented twice from claiming one position', () => {
    const stepOne = stepLocation(1, 1, 1, 4)
    const turnWithSteps = withSteps(TURN_1, [stepOne])
    const nodes = new Map<string, ChatConversationViewNode>([
      ['assistant', node('assistant', turnWithSteps, 2, undefined, undefined, stepOne)],
    ])
    const twice: ChatAttachmentScene = {
      attachments: [card('step', { kind: 'event', turn: 1, seq: SessionSeq(1) })],
      entries: [
        { kind: 'group', key: 'g-1' as never },
        { kind: 'node', key: 'assistant' as NodeKey, groupPart: 'response' },
      ],
      turns: new Map([[1, turnWithSteps]]),
      nodes: [...nodes.values()],
      nodeOf: key => nodes.get(key),
      groupMembers: key => key === 'g-1'
        ? [{ kind: 'node', key: 'assistant' as NodeKey, groupPart: 'reasoning' }]
        : undefined,
    }
    // The reasoning member is the Step's first rendered row, so the card claims
    // the group entry exactly once instead of both rendered parts.
    expect(resolveChatAttachmentPlacements(twice)).toMatchObject([
      { site: 'event', index: null, targetGroupKey: 'g-1' },
    ])
  })

  it('falls back to the Turn entry for an event with no loaded row or Step boundary', () => {
    const stepOne = stepLocation(1, 1, 1, 4)
    const turnWithSteps = withSteps(TURN_1, [stepOne])
    const rows = [{ key: 't1-input', turn: 1, seq: 1, sourceSeq: 1, step: stepOne }]
    const unknown = resolveChatAttachmentPlacements(scene(
      [turnWithSteps], rows, [card('unknown', { kind: 'event', turn: 1, seq: SessionSeq(3) })],
    ))
    expect(unknown).toMatchObject([{ site: 'turn-start', turn: 1, seq: 1, index: 0 }])
    // A Step whose start is outside the loaded window has no boundary to use.
    const unloadedStart = resolveChatAttachmentPlacements(scene(
      [withSteps(TURN_1, [stepLocation(1, 1, 9, 10)])],
      [{ key: 't1-tail', turn: 1, seq: 8, sourceSeq: 8 }],
      [card('unloaded', { kind: 'event', turn: 1, seq: SessionSeq(9) })],
    ))
    expect(unloadedStart).toMatchObject([{ site: 'turn-start', turn: 1, seq: 1, index: 0 }])
  })

  it('keeps an event with no loaded row at the Turn entry instead of approximating by order', () => {
    // Seq 7 is a durable event with no loaded row, and Seq 9 is beyond the open
    // Turn's loaded rows: neither may borrow a neighbour row's position.
    const covered = resolveChatAttachmentPlacements(scene(
      OPEN_TURNS, CLOSED_ROWS, [
        card('middle', { kind: 'event', turn: 2, seq: SessionSeq(7) }),
        card('later', { kind: 'event', turn: 2, seq: SessionSeq(9) }),
      ],
    ))
    expect(covered).toMatchObject([
      { site: 'turn-start', turn: 2, seq: 6, index: 3 },
      { site: 'turn-start', turn: 2, seq: 6, index: 3 },
    ])
    // A row whose sortable anchor is a transient fraction never answers a
    // durable seq: the tool row below sorts after 6 but declares no seq of its own.
    const transient = resolveChatAttachmentPlacements(scene(
      OPEN_TURNS, [
        { key: 't2-input', turn: 2, seq: 6, sourceSeq: 6 },
        { key: 't2-preparing', turn: 2, seq: 6.25 },
        { key: 't2-process', turn: 2, seq: 7 },
      ],
      [card('tool', { kind: 'event', turn: 2, seq: SessionSeq(6) })],
    ))
    expect(transient).toMatchObject([{ site: 'event', turn: 2, seq: 6, index: 0 }])
    expect(transient[0]?.index).not.toBe(1)
  })

  it('falls back to the Turn start for an event outside its boundaries', () => {
    const result = resolveChatAttachmentPlacements(scene(
      CLOSED_TURNS, CLOSED_ROWS, [
        card('past', { kind: 'event', turn: 1, seq: SessionSeq(99) }),
      ],
    ))
    expect(result).toMatchObject([{ site: 'turn-start', turn: 1, seq: 1, index: 0 }])
  })

  it('resolves a tool-call anchor only through the loaded Tool Node callId', () => {
    const rows = [
      { key: 't1-input', turn: 1, seq: 1, sourceSeq: 1 },
      { key: 't1-sources', turn: 1, seq: 2, toolCallId: 'call-sources', sourceSeq: 2 },
      { key: 't1-process', turn: 1, seq: 3, toolCallId: 'call-process', sourceSeq: 3 },
      { key: 't1-reply', turn: 1, seq: 4, sourceSeq: 4 },
      { key: 't1-tail', turn: 1, seq: 5, sourceSeq: 5 },
    ]
    const result = resolveChatAttachmentPlacements(scene(
      CLOSED_TURNS, rows, [card('process', { kind: 'tool-call', turn: 1, callId: 'call-process' })],
    ))
    expect(result).toMatchObject([{
      site: 'tool-call', turn: 1, seq: 3, index: null,
      targetCallId: 'call-process', targetNodeKey: 't1-process',
    }])
    expect(result[0]?.targetNodeKey).not.toBe('t1-sources')
    // A started call whose row declares no durable event reports no seq at all;
    // its own transient anchor position is not presented as a durable one.
    const transientRows = rows.map(row => row.key === 't1-process'
      ? {
        key: row.key,
        turn: row.turn,
        seq: row.seq,
        ...(row.toolCallId === undefined ? {} : { toolCallId: row.toolCallId }),
      }
      : row)
    const transient = resolveChatAttachmentPlacements(scene(
      CLOSED_TURNS, transientRows,
      [card('process', { kind: 'tool-call', turn: 1, callId: 'call-process' })],
    ))
    expect(transient).toMatchObject([{ site: 'tool-call', targetNodeKey: 't1-process' }])
    expect(transient[0]?.seq).toBeUndefined()
  })

  it('uses the Turn start when the callId is missing or belongs to another Turn', () => {
    const rows = [
      { key: 't1-input', turn: 1, seq: 1 },
      { key: 't1-reply', turn: 1, seq: 4 },
      { key: 't1-tail', turn: 1, seq: 5 },
      { key: 't2-input', turn: 2, seq: 6 },
      { key: 't2-process', turn: 2, seq: 8, toolCallId: 'call-other-turn' },
      { key: 't2-tail', turn: 2, seq: 9 },
    ]
    const missing = resolveChatAttachmentPlacements(scene(
      OPEN_TURNS, rows, [card('missing', { kind: 'tool-call', turn: 1, callId: 'call-missing' })],
    ))
    expect(missing).toMatchObject([{ site: 'turn-start', turn: 1, seq: 1, index: 0 }])
    const wrongTurn = resolveChatAttachmentPlacements(scene(
      OPEN_TURNS, rows, [card('wrong', { kind: 'tool-call', turn: 1, callId: 'call-other-turn' })],
    ))
    expect(wrongTurn).toMatchObject([{ site: 'turn-start', turn: 1, seq: 1, index: 0 }])
    expect(wrongTurn[0]?.targetNodeKey).toBeUndefined()
  })

  it('falls back to the Turn start when a callId names more than one row', () => {
    const rows = [
      { key: 't1-input', turn: 1, seq: 1 },
      { key: 't1-sources', turn: 1, seq: 2, toolCallId: 'call-process' },
      { key: 't1-process', turn: 1, seq: 3, toolCallId: 'call-process' },
      { key: 't1-reply', turn: 1, seq: 4 },
      { key: 't1-tail', turn: 1, seq: 5 },
    ]
    // Two loaded rows carry the same callId: no single row can be the anchor,
    // and the first duplicate is not evidence for the real target.
    const duplicate = resolveChatAttachmentPlacements(scene(
      CLOSED_TURNS, rows, [card('process', { kind: 'tool-call', turn: 1, callId: 'call-process' })],
    ))
    expect(duplicate).toMatchObject([{ site: 'turn-start', turn: 1, seq: 1, index: 0 }])
    expect(duplicate[0]?.targetNodeKey).toBeUndefined()
    expect(duplicate[0]?.targetCallId).toBeUndefined()
  })

  it('omits a tool-call whose Turn is not loaded', () => {
    const result = resolveChatAttachmentPlacements(scene(
      [TURN_1], CLOSED_ROWS.filter(row => row.turn === 1), [
        card('later-tool', { kind: 'tool-call', turn: 2, callId: 'call-other-turn' }),
      ],
    ))
    expect(result).toEqual([])
  })

  it('omits a card whose Turn is not loaded and follows it after the page arrives', () => {
    const before = resolveChatAttachmentPlacements(scene(
      [TURN_1], CLOSED_ROWS.filter(row => row.turn === 1),
      [card('later', { kind: 'turn-start', turn: 2 })],
    ))
    expect(before).toEqual([])
    const after = resolveChatAttachmentPlacements(scene(
      OPEN_TURNS, CLOSED_ROWS, [card('later', { kind: 'turn-start', turn: 2 })],
    ))
    expect(after).toMatchObject([{ site: 'turn-start', turn: 2, index: 3 }])
  })

  it('uses the loaded end when paging cut off the Turn start', () => {
    const headlessTurn = turn(3, undefined, 12)
    const rows = [
      { key: 't3-reply', turn: 3, seq: 11 },
      { key: 't3-tail', turn: 3, seq: 12 },
    ]
    const result = resolveChatAttachmentPlacements(scene(
      [headlessTurn], rows, [card('headless', { kind: 'turn-end', turn: 3 })],
    ))
    expect(result).toMatchObject([{ site: 'turn-end', turn: 3, seq: 12, index: 2 }])
    const start = resolveChatAttachmentPlacements(scene(
      [headlessTurn], rows, [card('headless', { kind: 'turn-start', turn: 3 })],
    ))
    expect(start).toMatchObject([{ site: 'turn-start', turn: 3, seq: 12, index: 0 }])
  })

  it('preserves registration order for cards at one position', () => {
    const result = resolveChatAttachmentPlacements(scene(
      CLOSED_TURNS, CLOSED_ROWS, [
        card('left', { kind: 'turn-start', turn: 1 }),
        card('right', { kind: 'turn-start', turn: 1 }),
      ],
    ))
    expect(result.map(entry => entry.attachment.id)).toEqual(['left', 'right'])
  })

  it('compares placements by identity, site, and position', () => {
    const sceneInput = scene(CLOSED_TURNS, CLOSED_ROWS, [card('one', { kind: 'turn-start', turn: 1 })])
    const first = resolveChatAttachmentPlacements(sceneInput)
    const second = resolveChatAttachmentPlacements(sceneInput)
    expect(first).not.toBe(second)
    expect(sameChatAttachmentPlacements(first, second)).toBe(true)
    expect(sameChatAttachmentPlacements(first, resolveChatAttachmentPlacements(scene(
      CLOSED_TURNS, CLOSED_ROWS, [card('one', { kind: 'turn-end', turn: 1 })],
    )))).toBe(false)
  })
})
