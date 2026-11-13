/**
 * Local submission echoes: synchronous insertion, observed/failed retirement,
 * and settlement callbacks. Prompts and the follow stream cross the assembled
 * Gateway client and are answered by endpoint name.
 */

import { afterEach, describe, expect, vi } from 'vitest'
import { createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm/types'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import type { PendingSubmissionRetirement } from '../src/client/contract/session.ts'
import type { SessionRequestId } from '../src/types.ts'
import { ev, historyValue } from './event-script.client.ts'
import { sessionBench } from './remote/bench.client.ts'
import {
  FOLLOW, err, fileRef, followScript, history, imageRef, pushEvent,
} from './remote/session.client.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A host-side rewrite keeping the submission request id but not the human kind. */
    'rewrite-fixture': { kind: 'rewrite-fixture'; rpcId: SessionRequestId }
    /** An ordinary non-human producer message with no submission identity at all. */
    'producer-fixture': { kind: 'producer-fixture' }
    /** A non-human producer that copies a submission request id without being its original. */
    'producer-request': { kind: 'producer-request'; rpcId: SessionRequestId }
  }
}

/** A Session talks through the Gateway client; its dependency cone is the Typert registry and the Connection. */
const API_ROSTER = webApp.closure(['@deepseek-ai/dsh-api-gateway'])
const it = createClientTest({ roster: API_ROSTER })
const SID = 'fk-s1' as SessionId
/** The first client boot pays the cold module transform of the api cone. */
const COLD_BOOT_TIMEOUT_MS = 60_000

afterEach(() => {
  vi.unstubAllGlobals()
})

type AttachmentRef = ImageAttachmentRef | FileAttachmentRef

function attachmentBlock(attachment: AttachmentRef) {
  return 'mediaType' in attachment
    ? { type: 'image' as const, attachment }
    : { type: 'file' as const, attachment }
}

/** A durable browser-prompt user/message whose source echoes `rpcId`. */
function promptEvent(seq: SessionSeq, rpcId: SessionRequestId, refs: readonly AttachmentRef[] = []): SessionEvent {
  return {
    seq,
    time: 1_700_000_000_000 + seq,
    type: 'user/message',
    surfaceOp: 'append',
    data: createUserMessage({
      content: [
        ...refs.map(attachmentBlock),
        { type: 'text' as const, text: '发送' },
      ],
      source: { kind: 'user', rpcId },
    }),
  } as unknown as SessionEvent
}

function queuedItem(rpcId: SessionRequestId, refs: readonly AttachmentRef[] = []) {
  return createUserMessage({
    source: { kind: 'user', rpcId },
    content: refs.map(attachmentBlock),
  })
}

/**
 * One durable host-side rewrite of an admitted original: same message and request
 * identities, other producer kind — the Nodes input-handoff shape.
 * @param seq - event position.
 * @param original - the admitted human message being rewritten.
 * @param rpcId - request identity the client minted.
 * @param text - effective prompt text.
 * @returns the durable rewrite event.
 */
function rewriteEvent(
  seq: SessionSeq,
  original: UserMessage,
  rpcId: SessionRequestId,
  text = '有效请求',
): SessionEvent {
  return {
    seq,
    time: 1_700_000_000_000 + seq,
    type: 'user/message',
    surfaceOp: 'append',
    data: freezeMessage({
      ...original,
      content: [{ type: 'text', text }],
      source: { kind: 'rewrite-fixture', rpcId },
    }),
  }
}

/** Let the frame-delayed retirement (setTimeout fallback in this node environment) run. */
async function settleFrames(): Promise<void> {
  await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

type BenchSession = Awaited<ReturnType<typeof sessionBench>>

/** Register an echo and let the Host accept its prompt, which publishes the echo. */
async function submitAccepted(
  session: BenchSession,
  input: Parameters<BenchSession['beginSubmission']>[0],
): Promise<ReturnType<BenchSession['beginSubmission']>> {
  const handle = session.beginSubmission(input)
  const result = await session.prompt([{ type: 'text', text: input.text }], input.mode, undefined, handle.requestId)
  expect(result.ok).toBe(true)
  return handle
}

describe('beginSubmission', () => {
  it('publishes the echo and the engaging edge only once the Host accepts the prompt', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    expect(session.getSnapshot()).toMatchObject({ pendingSubmissions: [], promptAttempted: false })
    const onAccept = vi.fn()
    const handle = session.beginSubmission({
      mode: 'queue',
      text: '你好',
      attachments: [{
        type: 'image', value: { previewUrl: 'blob:p1', name: 'a.png', width: 4, height: 3 },
      }],
      onAccept,
    })
    expect(session.getSnapshot()).toMatchObject({ pendingSubmissions: [], promptAttempted: false })
    expect(mock.log.requests()).toEqual([])
    const receipt = Promise.withResolvers<{ ok: true; value: { accepted: true } }>()
    mock.remote.session.prompt.mockImplementationOnce(() => receipt.promise)
    const inFlight = session.prompt([{ type: 'text', text: '你好' }], 'queue', undefined, handle.requestId)
    await Promise.resolve()
    expect(session.getSnapshot()).toMatchObject({ pendingSubmissions: [], promptAttempted: false })
    expect(onAccept).not.toHaveBeenCalled()
    receipt.resolve({ ok: true, value: { accepted: true } })
    expect((await inFlight).ok).toBe(true)
    expect(onAccept).toHaveBeenCalledOnce()
    expect(session.getSnapshot().promptAttempted).toBe(true)
    expect(session.getSnapshot().pendingSubmissions).toMatchObject([{
      requestId: handle.requestId,
      placement: 'transcript',
      text: '你好',
      attachments: [{
        type: 'image', value: { previewUrl: 'blob:p1', name: 'a.png', width: 4, height: 3 },
      }],
    }])
  }, COLD_BOOT_TIMEOUT_MS)

  for (const { mode, running, target, placement } of [
    { mode: 'queue', running: false, target: 'next-turn', placement: 'transcript' },
    { mode: 'steer', running: true, target: 'next-step', placement: 'steering' },
    { mode: 'queue', running: true, target: 'next-turn', placement: 'queued' },
  ] as const) {
    for (const path of ['projection', 'durable event'] as const) {
      it(`accepts a ${placement} prompt once the Inbox holds it, ahead of the Host receipt (${path})`, async ({ mock, start }) => {
        const onEngaged = vi.fn()
        const session = await sessionBench(mock, start, SID, { onEngaged })
        await session.open()
        session.handleBlank(!running)
        session.handleRunning(running)
        const onAccept = vi.fn()
        const handle = session.beginSubmission({ mode, text: '先进收件箱', attachments: [], onAccept })
        const receipt = Promise.withResolvers<{ ok: true; value: { accepted: true } }>()
        mock.remote.session.prompt.mockImplementationOnce(() => receipt.promise)
        const inFlight = session.prompt([{ type: 'text', text: '先进收件箱' }], mode, undefined, handle.requestId)
        const empty = { 'next-turn': [], 'next-step': [] }
        // Projection faces notify in a microtask.
        session.projections.apply('inbox', { ...empty, [target]: [queuedItem('another-request' as SessionRequestId)] }, -1)
        await Promise.resolve()
        expect(session.getSnapshot()).toMatchObject({ pendingSubmissions: [], blank: !running, promptAttempted: false })
        expect(onAccept).not.toHaveBeenCalled()
        const message = queuedItem(handle.requestId)
        if (path === 'projection') {
          session.projections.apply('inbox', { ...empty, [target]: [message] }, SessionSeq(0))
          await Promise.resolve()
        } else {
          await pushEvent(mock, {
            type: 'agent/inbox/spliced', seq: SessionSeq(0), time: 1,
            data: { target, start: 0, inserted: [message] },
          })
        }
        expect(session.getSnapshot()).toMatchObject({
          pendingSubmissions: [{ requestId: handle.requestId, placement, text: '先进收件箱' }],
          blank: false,
          promptAttempted: true,
          ...running ? {} : { awaitingFirstTurn: true },
        })
        expect(onEngaged).toHaveBeenCalledOnce()
        expect(onAccept).toHaveBeenCalledOnce()
        receipt.resolve({ ok: true, value: { accepted: true } })
        expect((await inFlight).ok).toBe(true)
        expect(session.getSnapshot().pendingSubmissions).toHaveLength(1)
        expect(onEngaged).toHaveBeenCalledOnce()
        expect(onAccept).toHaveBeenCalledOnce()
      })
    }
  }

  it('never publishes an echo whose message was observed before the Host receipt', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    await session.open()
    const retirements: PendingSubmissionRetirement[] = []
    const handle = session.beginSubmission({
      mode: 'queue', text: '先到', attachments: [], onRetire: retirement => retirements.push(retirement),
    })
    const receipt = Promise.withResolvers<{ ok: true; value: { accepted: true } }>()
    mock.remote.session.prompt.mockImplementationOnce(() => receipt.promise)
    const inFlight = session.prompt([{ type: 'text', text: '先到' }], 'queue', undefined, handle.requestId)
    await pushEvent(mock, promptEvent(SessionSeq(0), handle.requestId))
    await settleFrames()
    expect(retirements).toEqual([{ reason: 'observed', attachments: [] }])
    receipt.resolve({ ok: true, value: { accepted: true } })
    expect((await inFlight).ok).toBe(true)
    expect(session.getSnapshot().pendingSubmissions).toEqual([])
  })

  it('derives and captures the echo placement from running state and delivery mode', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    await submitAccepted(session, { mode: 'queue', text: '空闲', attachments: [] })
    session.handleRunning(true)
    await submitAccepted(session, { mode: 'queue', text: '排队', attachments: [] })
    await submitAccepted(session, { mode: 'steer', text: '纠偏', attachments: [] })
    session.handleRunning(false)
    expect(session.getSnapshot().pendingSubmissions.map(({ text, placement }) => ({ text, placement }))).toEqual([
      { text: '空闲', placement: 'transcript' },
      { text: '排队', placement: 'queued' },
      { text: '纠偏', placement: 'steering' },
    ])
  })

  it('keeps rapid ordinary submissions in Chat until the running update arrives', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    for (const text of ['A', 'B', 'C']) await submitAccepted(session, { mode: 'queue', text, attachments: [] })
    expect(session.getSnapshot().pendingSubmissions.map(input => input.placement)).toEqual([
      'transcript', 'transcript', 'transcript',
    ])
    session.handleRunning(true)
    await submitAccepted(session, { mode: 'queue', text: 'D', attachments: [] })
    expect(session.getSnapshot().pendingSubmissions.map(input => input.placement)).toEqual([
      'transcript', 'transcript', 'transcript', 'queued',
    ])
  })

  it('abandon retires the echo as failed exactly once', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    const retirements: PendingSubmissionRetirement[] = []
    const handle = session.beginSubmission({
      mode: 'queue',
      text: '放弃',
      attachments: [],
      onRetire: retirement => retirements.push(retirement),
    })
    handle.abandon()
    handle.abandon()
    expect(session.getSnapshot().pendingSubmissions).toEqual([])
    expect(retirements).toEqual([{ reason: 'failed' }])
  })
})

describe('prompt-coupled retirement', () => {
  it('a rejected identified prompt retires its echo immediately alongside promptError', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.remote.session.prompt.mockResolvedValue(err(new RemoteError('session/agent-busy', '忙', { reason: 'busy' })))
    const retirements: PendingSubmissionRetirement[] = []
    const handle = session.beginSubmission({
      mode: 'queue',
      text: '失败的',
      attachments: [],
      onRetire: retirement => retirements.push(retirement),
    })
    const result = await session.prompt([{ type: 'text', text: '失败的' }], 'queue', undefined, handle.requestId)
    expect(result.ok).toBe(false)
    expect(session.getSnapshot().pendingSubmissions).toEqual([])
    expect(session.getSnapshot().promptError).toMatchObject({ op: 'send', error: { code: 'session/agent-busy' } })
    expect(retirements).toEqual([{ reason: 'failed' }])
  })

  it('sends the echo identity as the prompt requestId', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    const handle = session.beginSubmission({ mode: 'queue', text: '带 id', attachments: [] })
    await session.prompt([{ type: 'text', text: '带 id' }], 'queue', undefined, handle.requestId)
    expect(mock.log.requests('session/prompt')).toMatchObject([{ requestId: handle.requestId, sessionId: SID }])
  })

  it('an unidentified prompt failure leaves registered echoes alone', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    await submitAccepted(session, { mode: 'queue', text: '还在', attachments: [] })
    mock.remote.session.prompt.mockResolvedValue(err(new RemoteError('session/agent-busy', '忙', { reason: 'busy' })))
    await session.prompt([{ type: 'text', text: '另一个' }], 'queue')
    expect(session.getSnapshot().pendingSubmissions).toHaveLength(1)
  })
})

describe('observed retirement', () => {
  it('a live durable event carrying the rpcId retires the echo one frame later with the admitted refs', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    await session.open()
    const retirements: PendingSubmissionRetirement[] = []
    const handle = await submitAccepted(session, {
      mode: 'queue',
      text: '发送',
      attachments: [{ type: 'image', value: { previewUrl: 'blob:p1' } }],
      onRetire: retirement => retirements.push(retirement),
    })
    const refs = [imageRef('att-1')]
    await pushEvent(mock, promptEvent(SessionSeq(0), handle.requestId, refs))
    // Synchronously after the append the echo is still in the snapshot; the
    // render-time dedupe owns the overlap frame.
    expect(session.getSnapshot().pendingSubmissions).toHaveLength(1)
    await settleFrames()
    expect(session.getSnapshot().pendingSubmissions).toEqual([])
    expect(retirements).toEqual([{ reason: 'observed', attachments: refs }])
  })

  it('retains an idle echo when a claim clears the projection before its notification', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    await session.open()
    const onRetire = vi.fn()
    const handle = await submitAccepted(session, { mode: 'steer', text: 'accepted', attachments: [], onRetire })
    const refs = [imageRef('claimed-image')]
    const message = queuedItem(handle.requestId, refs)
    session.projections.apply('inbox', { 'next-turn': [], 'next-step': [message] }, SessionSeq(0))
    session.projections.apply('inbox', { 'next-turn': [], 'next-step': [] }, SessionSeq(1))
    await pushEvent(mock, {
      type: 'agent/inbox/spliced', seq: SessionSeq(0), time: 1,
      data: { target: 'next-step', start: 0, inserted: [message] },
    })
    await settleFrames()
    expect(session.getSnapshot().pendingSubmissions).toHaveLength(1)
    expect(onRetire).not.toHaveBeenCalled()
    await pushEvent(mock, {
      type: 'agent/inbox/spliced', seq: SessionSeq(1), time: 2,
      data: { target: 'next-step', start: 0, removedCount: 1, inserted: [] },
    })
    await pushEvent(mock, promptEvent(SessionSeq(2), handle.requestId, refs))
    await settleFrames()
    expect(session.getSnapshot().pendingSubmissions).toEqual([])
    expect(onRetire).toHaveBeenCalledExactlyOnceWith({ reason: 'observed', attachments: refs })
  })

  for (const { mode, target, order } of [
    { mode: 'queue', target: 'next-turn', order: 'inbox-first' },
    { mode: 'queue', target: 'next-turn', order: 'transcript-first' },
    { mode: 'steer', target: 'next-step', order: 'inbox-first' },
    { mode: 'steer', target: 'next-step', order: 'transcript-first' },
  ] as const) {
    it(`keeps a ${mode} Chat identity until admission and the Inbox claim watermark (${order})`, async ({ mock, start }) => {
      const session = await sessionBench(mock, start, SID)
      await session.open()
      session.projections.apply('inbox', { 'next-turn': [], 'next-step': [] }, -1)
      const frames: FrameRequestCallback[] = []
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
      const onRetire = vi.fn()
      session.handleRunning(mode === 'steer')
      const handle = await submitAccepted(session, { mode, text: 'local input', attachments: [], onRetire })
      const refs = [imageRef('idle-image'), fileRef('idle-file')]
      const message = queuedItem(handle.requestId, refs)
      const queued = { 'next-turn': [], 'next-step': [], [target]: [message] }
      const empty = { 'next-turn': [], 'next-step': [] }
      if (order === 'inbox-first') session.projections.apply('inbox', queued, SessionSeq(0))
      await pushEvent(mock, {
        type: 'agent/inbox/spliced', seq: SessionSeq(0), time: 1,
        data: { target, start: 0, inserted: [message] },
      })
      await pushEvent(mock, {
        type: 'agent/inbox/spliced', seq: SessionSeq(1), time: 2,
        data: { target, start: 0, removedCount: 1, inserted: [] },
      })
      expect(session.getSnapshot().pendingSubmissions).toHaveLength(1)
      expect(frames).toHaveLength(0)
      if (order === 'inbox-first') session.projections.apply('inbox', empty, SessionSeq(1))
      await pushEvent(mock, promptEvent(SessionSeq(2), handle.requestId, refs))
      if (order === 'transcript-first') {
        await pushEvent(mock, ev.turnEnd(SessionSeq(3), 1))
        handle.abandon()
        session.projections.apply('inbox', queued, SessionSeq(0))
        await Promise.resolve()
        expect(frames).toHaveLength(0)
        expect(session.getSnapshot().pendingSubmissions).toHaveLength(1)
        expect(onRetire).not.toHaveBeenCalled()
        session.projections.apply('inbox', empty, SessionSeq(1))
        await Promise.resolve()
      }
      expect(frames).toHaveLength(1)
      frames[0]?.(0)
      expect(session.getSnapshot().pendingSubmissions).toEqual([])
      expect(onRetire).toHaveBeenCalledExactlyOnceWith({ reason: 'observed', attachments: refs })
      session.projections.apply('inbox', queued, SessionSeq(0))
      expect(session.projections.get('inbox')).toEqual(empty)
    })
  }

  for (const projectionFirst of [true, false]) {
    it(`settles overlapping opening, queued and steering inputs independently (${projectionFirst ? 'projection' : 'history'} first)`, async ({ mock, start }) => {
      const session = await sessionBench(mock, start, SID)
      await session.open()
      const frames: FrameRequestCallback[] = []
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
      const flush = () => { for (const callback of frames.splice(0)) callback(0) }
      const normalRetired = vi.fn()
      const queueRetired = vi.fn()
      const steerRetired = vi.fn()
      const normal = await submitAccepted(session, { mode: 'queue', text: 'opening', attachments: [], onRetire: normalRetired })
      session.handleRunning(true)
      const queued = await submitAccepted(session, { mode: 'queue', text: 'queued', attachments: [], onRetire: queueRetired })
      const steer = await submitAccepted(session, { mode: 'steer', text: 'steering', attachments: [], onRetire: steerRetired })
      const normalMessage = queuedItem(normal.requestId, [fileRef('opening-file')])
      const queuedMessage = queuedItem(queued.requestId, [imageRef('queued-image')])
      const steerMessage = queuedItem(steer.requestId, [imageRef('steer-image'), fileRef('steer-file')])
      const pending = () => session.getSnapshot().pendingSubmissions.map(input => input.text)
      const accepted = { 'next-turn': [normalMessage, queuedMessage], 'next-step': [steerMessage] }
      if (projectionFirst) session.projections.apply('inbox', accepted, SessionSeq(1))
      await pushEvent(mock, { type: 'agent/inbox/spliced', seq: SessionSeq(0), time: 1,
        data: { target: 'next-turn', start: 0, inserted: [normalMessage, queuedMessage] } })
      await pushEvent(mock, { type: 'agent/inbox/spliced', seq: SessionSeq(1), time: 2,
        data: { target: 'next-step', start: 0, inserted: [steerMessage] } })
      flush()
      // A queued echo waits for the inbox projection the queue dock renders, not the history event.
      expect(pending()).toEqual(projectionFirst ? ['opening', 'steering'] : ['opening', 'queued', 'steering'])
      if (projectionFirst) {
        expect(queueRetired).toHaveBeenCalledExactlyOnceWith({ reason: 'observed', attachments: [imageRef('queued-image')] })
      } else expect(queueRetired).not.toHaveBeenCalled()
      await pushEvent(mock, ev.turnStart(SessionSeq(2), 1))
      await pushEvent(mock, { type: 'agent/inbox/spliced', seq: SessionSeq(3), time: 4,
        data: { target: 'next-step', start: 0, removedCount: 1, inserted: [] } })
      await pushEvent(mock, { type: 'agent/inbox/spliced', seq: SessionSeq(4), time: 5,
        data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } })
      const claimed = { 'next-turn': [queuedMessage], 'next-step': [] }
      if (projectionFirst) session.projections.apply('inbox', claimed, SessionSeq(4))
      await pushEvent(mock, ev.stepStart(SessionSeq(5), 1, 1))
      await pushEvent(mock, { type: 'user/message', seq: SessionSeq(6), time: 7, surfaceOp: 'append', data: steerMessage })
      flush()
      expect(pending()).toEqual(projectionFirst ? ['opening'] : ['opening', 'queued', 'steering'])
      expect(normalRetired).not.toHaveBeenCalled()
      if (!projectionFirst) expect(steerRetired).not.toHaveBeenCalled()
      await pushEvent(mock, { type: 'user/message', seq: SessionSeq(7), time: 8, surfaceOp: 'append', data: normalMessage })
      flush()
      if (!projectionFirst) {
        expect(pending()).toEqual(['opening', 'queued', 'steering'])
        session.projections.apply('inbox', accepted, SessionSeq(1))
        await Promise.resolve()
        flush()
        expect(queueRetired).toHaveBeenCalledExactlyOnceWith({ reason: 'observed', attachments: [imageRef('queued-image')] })
        expect(normalRetired).not.toHaveBeenCalled()
        session.projections.apply('inbox', claimed, SessionSeq(4))
        await Promise.resolve()
        flush()
      }
      expect(pending()).toEqual([])
      expect(normalRetired).toHaveBeenCalledExactlyOnceWith({ reason: 'observed', attachments: [fileRef('opening-file')] })
      expect(steerRetired).toHaveBeenCalledExactlyOnceWith({
        reason: 'observed', attachments: [imageRef('steer-image'), fileRef('steer-file')],
      })
      await pushEvent(mock, ev.stepEnd(SessionSeq(8), 1, 1))
      await pushEvent(mock, ev.turnEnd(SessionSeq(9), 1))
      await pushEvent(mock, ev.turnStart(SessionSeq(10), 2))
      await pushEvent(mock, { type: 'agent/inbox/spliced', seq: SessionSeq(11), time: 12,
        data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } })
      await pushEvent(mock, ev.stepStart(SessionSeq(12), 2, 2))
      await pushEvent(mock, { type: 'user/message', seq: SessionSeq(13), time: 14, surfaceOp: 'append', data: queuedMessage })
      session.projections.apply('inbox', { 'next-turn': [], 'next-step': [] }, SessionSeq(11))
      flush()
      expect(queueRetired).toHaveBeenCalledTimes(1)
      expect(pending()).toEqual([])
    })
  }

  it('keeps a running steer echo through accepted and claimed Inbox states until transcript admission', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    await session.open()
    session.handleRunning(true)
    const onRetire = vi.fn()
    const handle = await submitAccepted(session, { mode: 'steer', text: 'accepted', attachments: [], onRetire })
    const refs = [imageRef('steer-image')]
    const message = queuedItem(handle.requestId, refs)
    const echo = session.getSnapshot().pendingSubmissions[0]
    session.projections.apply('inbox', { 'next-turn': [], 'next-step': [message] }, SessionSeq(0))
    await settleFrames()
    expect(session.getSnapshot().pendingSubmissions).toEqual([echo])
    await pushEvent(mock, {
      type: 'agent/inbox/spliced', seq: SessionSeq(0), time: 1,
      data: { target: 'next-step', start: 0, inserted: [message] },
    })
    await pushEvent(mock, {
      type: 'agent/inbox/spliced', seq: SessionSeq(1), time: 2,
      data: { target: 'next-step', start: 0, removedCount: 1, inserted: [] },
    })
    session.projections.apply('inbox', { 'next-turn': [], 'next-step': [] }, SessionSeq(1))
    await settleFrames()
    expect(session.getSnapshot().pendingSubmissions).toEqual([echo])
    expect(onRetire).not.toHaveBeenCalled()
    await pushEvent(mock, {
      type: 'user/message', seq: SessionSeq(2), time: 3, surfaceOp: 'append', data: message,
    })
    await settleFrames()
    expect(session.getSnapshot().pendingSubmissions).toEqual([])
    expect(onRetire).toHaveBeenCalledExactlyOnceWith({ reason: 'observed', attachments: refs })
  })

  for (const { target, running, mode, placement } of [
    { target: 'next-step', running: true, mode: 'steer', placement: 'steering' },
    { target: 'next-turn', running: false, mode: 'steer', placement: 'transcript' },
    { target: 'next-turn', running: true, mode: 'queue', placement: 'queued' },
  ] as const) {
    it(`retires canceled or unadmitted ${placement} input without removing still-pending input`, async ({ mock, start }) => {
      const session = await sessionBench(mock, start, SID)
      await session.open()
      session.handleRunning(running)
      const canceled = vi.fn()
      const rejected = vi.fn()
      const first = await submitAccepted(session, { mode, text: 'cancel', attachments: [], onRetire: canceled })
      const second = await submitAccepted(session, { mode, text: 'reject', attachments: [], onRetire: rejected })
      const unclaimed = await submitAccepted(session, { mode, text: 'later', attachments: [] })
      expect(session.getSnapshot().pendingSubmissions.map(echo => echo.placement)).toEqual([placement, placement, placement])
      const foreign = createUserMessage({ source: { kind: 'user' }, content: [] })
      await pushEvent(mock, {
        type: 'agent/inbox/spliced', seq: SessionSeq(0), time: 1,
        data: { target, start: 0, inserted: [queuedItem(first.requestId), queuedItem(second.requestId)] },
      })
      await pushEvent(mock, {
        type: 'agent/inbox/spliced', seq: SessionSeq(1), time: 2,
        data: { target, start: 0, inserted: [foreign] },
      })
      await pushEvent(mock, {
        type: 'agent/inbox/spliced', seq: SessionSeq(2), time: 3,
        data: { target, start: 1, removedCount: 1, inserted: [], outcome: 'canceled' },
      })
      expect(canceled).toHaveBeenCalledExactlyOnceWith({ reason: 'failed' })
      expect(rejected).not.toHaveBeenCalled()
      await pushEvent(mock, {
        type: 'agent/inbox/spliced', seq: SessionSeq(3), time: 4,
        data: { target, start: 0, removedCount: 2, inserted: [] },
      })
      await pushEvent(mock, {
        type: 'agent/inbox/spliced', seq: SessionSeq(4), time: 5,
        data: { target, start: 0, inserted: [queuedItem(unclaimed.requestId)] },
      })
      await pushEvent(mock, {
        type: 'turn/end', seq: SessionSeq(5), time: 6, data: { turn: 1, reason: { kind: 'blocked' } },
      })
      expect(rejected).toHaveBeenCalledExactlyOnceWith({ reason: 'failed' })
      expect(session.getSnapshot().pendingSubmissions.map(echo => echo.requestId)).toEqual([unclaimed.requestId])
    })
  }

  it('a queue occurrence carrying the rpcId retires the echo (running-turn submissions)', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    const retirements: PendingSubmissionRetirement[] = []
    session.handleRunning(true)
    const handle = session.beginSubmission({
      mode: 'queue',
      text: '排队',
      attachments: [{ type: 'image', value: { previewUrl: 'blob:p1' } }],
      onRetire: retirement => retirements.push(retirement),
    })
    const refs = [imageRef('att-q')]
    session.projections.apply('inbox', { 'next-turn': [queuedItem(handle.requestId, refs)], 'next-step': [] }, SessionSeq(1))
    await settleFrames()
    expect(session.getSnapshot().pendingSubmissions).toEqual([])
    expect(retirements).toEqual([{ reason: 'observed', attachments: refs }])
    // The queue projection keeps the correlation id for render-time dedupe.
    expect(session.projections.get('inbox')).toMatchObject({
      'next-turn': [{ source: { rpcId: handle.requestId } }],
    })
  })

  it('retires a mixed echo with durable references in original selection order', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    await session.open()
    const retirements: PendingSubmissionRetirement[] = []
    const file = fileRef('file-1')
    const handle = session.beginSubmission({
      mode: 'queue',
      text: 'mixed',
      attachments: [
        { type: 'image', value: { previewUrl: 'blob:first' } },
        { type: 'file', value: file },
        { type: 'image', value: { previewUrl: 'blob:last' } },
      ],
      onRetire: retirement => retirements.push(retirement),
    })
    const refs = [imageRef('image-1'), file, imageRef('image-2')]
    await pushEvent(mock, promptEvent(SessionSeq(0), handle.requestId, refs))
    await settleFrames()
    expect(retirements).toEqual([{ reason: 'observed', attachments: refs }])
  })

  it('a full-window install (reconnect resync) retires echoes observed in the window', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    const handle = session.beginSubmission({ mode: 'queue', text: '重连', attachments: [] })
    mock.stream(FOLLOW, followScript(history([promptEvent(SessionSeq(12), handle.requestId)])))
    await session.open()
    await settleFrames()
    expect(session.getSnapshot().pendingSubmissions).toEqual([])
  })

  for (const [target, pending] of [
    ['next-step', false], ['next-step', true], ['next-turn', false], ['next-turn', true],
  ] as const) {
    it(`retires confirmed ${target} input on resync with the Host input ${pending ? 'still pending' : 'outside the history window'}`, async ({ mock, start }) => {
      const session = await sessionBench(mock, start, SID)
      await session.open()
      session.handleRunning(target === 'next-step')
      const onRetire = vi.fn()
      const handle = await submitAccepted(session, { mode: 'steer', text: 'accepted', attachments: [], onRetire })
      const refs = [imageRef('steer-image'), fileRef('steer-file')]
      const message = queuedItem(handle.requestId, refs)
      if (target === 'next-turn') {
        session.projections.apply('inbox', { 'next-turn': [message], 'next-step': [] }, SessionSeq(0))
        await Promise.resolve()
      } else {
        await pushEvent(mock, {
          type: 'agent/inbox/spliced', seq: SessionSeq(0), time: 1,
          data: { target, start: 0, inserted: [message] },
        })
      }
      const unconfirmed = await submitAccepted(session, { mode: 'steer', text: 'not accepted yet', attachments: [] })
      const inbox = { 'next-turn': [], 'next-step': [], [target]: pending ? [message] : [] }
      const replacement = {
        ...historyValue([ev.turnEnd(SessionSeq(10), 2)], true),
        projections: { asOfSeq: 10, values: { inbox } },
      }
      mock.stream(FOLLOW, followScript({ ok: true, value: replacement }))
      await session.resync()
      await settleFrames()

      expect(session.getSnapshot().pendingSubmissions.map(item => item.requestId)).toEqual([unconfirmed.requestId])
      expect(session.projections.get('inbox')).toEqual(inbox)
      expect(onRetire).toHaveBeenCalledExactlyOnceWith({ reason: 'observed', attachments: refs })
      await pushEvent(mock, ev.turnEnd(SessionSeq(11), 3))
      expect(onRetire).toHaveBeenCalledTimes(1)
    })
  }

  it('withdraws a confirmed optimistic steer when resync lands between claim and admission', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    await session.open()
    session.handleRunning(true)
    const onRetire = vi.fn()
    const handle = session.beginSubmission({ mode: 'steer', text: 'accepted', attachments: [], onRetire })
    const refs = [imageRef('claimed-image')]
    const message = queuedItem(handle.requestId, refs)
    await pushEvent(mock, {
      type: 'agent/inbox/spliced', seq: SessionSeq(0), time: 1,
      data: { target: 'next-step', start: 0, inserted: [message] },
    })
    const replacement = {
      ...historyValue([{
        type: 'agent/inbox/spliced', seq: SessionSeq(1), time: 2,
        data: { target: 'next-step', start: 0, removedCount: 1, inserted: [] },
      }], true),
      projections: { asOfSeq: 1, values: { inbox: { 'next-turn': [], 'next-step': [] } } },
    }
    mock.stream(FOLLOW, followScript({ ok: true, value: replacement }))
    await session.resync()
    await settleFrames()
    expect(session.getSnapshot().pendingSubmissions).toEqual([])
    expect(onRetire).toHaveBeenCalledExactlyOnceWith({ reason: 'observed', attachments: refs })

    const admitted = promptEvent(SessionSeq(2), handle.requestId, refs)
    await pushEvent(mock, admitted)
    await settleFrames()
    expect(session.eventSource.getSnapshot().entries.at(-1)?.event).toEqual(admitted)
    expect(onRetire).toHaveBeenCalledTimes(1)
  })

  it('the first observation wins: a later prompt failure cannot re-retire an observed echo', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    await session.open()
    const retirements: PendingSubmissionRetirement[] = []
    const handle = session.beginSubmission({
      mode: 'queue',
      text: '先观察',
      attachments: [],
      onRetire: retirement => retirements.push(retirement),
    })
    await pushEvent(mock, promptEvent(SessionSeq(0), handle.requestId))
    handle.abandon()
    await settleFrames()
    expect(retirements).toEqual([{ reason: 'observed', attachments: [] }])
  })

  it('retires once when the queue and durable event report the same request id', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    await session.open()
    const retirements: PendingSubmissionRetirement[] = []
    const handle = session.beginSubmission({
      mode: 'queue',
      text: '同一请求',
      attachments: [],
      onRetire: retirement => retirements.push(retirement),
    })
    session.projections.apply('inbox', { 'next-turn': [queuedItem(handle.requestId, [])], 'next-step': [] }, SessionSeq(1))
    await pushEvent(mock, promptEvent(SessionSeq(0), handle.requestId))
    await settleFrames()
    expect(retirements).toEqual([{ reason: 'observed', attachments: [] }])
    expect(session.getSnapshot().pendingSubmissions).toEqual([])
  })

  it('uses requestAnimationFrame for the retirement delay when the runtime provides one', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    await session.open()
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
      frames.push(fn)
      return frames.length
    })
    const handle = await submitAccepted(session, { mode: 'queue', text: '帧', attachments: [] })
    await pushEvent(mock, promptEvent(SessionSeq(0), handle.requestId))
    expect(session.getSnapshot().pendingSubmissions).toHaveLength(1)
    expect(frames).toHaveLength(1)
    frames[0]?.(0)
    expect(session.getSnapshot().pendingSubmissions).toEqual([])
  })

  it('retires a rewritten submission at admission once the real claim and the copy share both identities', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    await session.open()
    const retirements: PendingSubmissionRetirement[] = []
    const handle = await submitAccepted(session, {
      mode: 'queue', text: '把节点 A 移出，继续修复分页', attachments: [],
      onRetire: retirement => retirements.push(retirement),
    })
    const original = createUserMessage({
      content: [{ type: 'text', text: '把节点 A 移出，继续修复分页' }],
      source: { kind: 'user', rpcId: handle.requestId },
    })
    await pushEvent(mock, {
      type: 'agent/inbox/spliced', seq: SessionSeq(0), time: 1,
      data: { target: 'next-turn', start: 0, inserted: [original] },
    })
    expect(session.getSnapshot().pendingSubmissions).toHaveLength(1)
    await pushEvent(mock, ev.turnStart(SessionSeq(1), 1))
    // The producer's claim: remove-and-run inside the Turn without a cancellation outcome.
    await pushEvent(mock, {
      type: 'agent/inbox/spliced', seq: SessionSeq(2), time: 3,
      data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] },
    })
    session.projections.apply('inbox', { 'next-turn': [], 'next-step': [] }, SessionSeq(2))
    expect(session.getSnapshot().pendingSubmissions).toHaveLength(1)
    await pushEvent(mock, ev.stepStart(SessionSeq(3), 1, 1))
    await pushEvent(mock, rewriteEvent(SessionSeq(4), original, handle.requestId))
    await settleFrames()
    expect(session.getSnapshot().pendingSubmissions).toEqual([])
    expect(retirements).toEqual([{ reason: 'observed', attachments: [] }])
  })

  it('keeps a rewritten submission echo when no step entered after its claim', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    await session.open()
    const retirements: PendingSubmissionRetirement[] = []
    const handle = await submitAccepted(session, {
      mode: 'queue', text: '未进入步骤', attachments: [],
      onRetire: retirement => retirements.push(retirement),
    })
    const original = createUserMessage({
      content: [{ type: 'text', text: '未进入步骤' }],
      source: { kind: 'user', rpcId: handle.requestId },
    })
    await pushEvent(mock, {
      type: 'agent/inbox/spliced', seq: SessionSeq(0), time: 1,
      data: { target: 'next-turn', start: 0, inserted: [original] },
    })
    await pushEvent(mock, ev.turnStart(SessionSeq(1), 1))
    await pushEvent(mock, {
      type: 'agent/inbox/spliced', seq: SessionSeq(2), time: 3,
      data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] },
    })
    await pushEvent(mock, rewriteEvent(SessionSeq(3), original, handle.requestId))
    await settleFrames()
    expect(session.getSnapshot().pendingSubmissions).toHaveLength(1)
    expect(retirements).toEqual([])
  })

  it('consumes a claim at step close, so a later step cannot settle the echo', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    await session.open()
    const retirements: PendingSubmissionRetirement[] = []
    const handle = await submitAccepted(session, {
      mode: 'queue', text: '步骤已关闭', attachments: [],
      onRetire: retirement => retirements.push(retirement),
    })
    const original = createUserMessage({
      content: [{ type: 'text', text: '步骤已关闭' }],
      source: { kind: 'user', rpcId: handle.requestId },
    })
    await pushEvent(mock, {
      type: 'agent/inbox/spliced', seq: SessionSeq(0), time: 1,
      data: { target: 'next-turn', start: 0, inserted: [original] },
    })
    await pushEvent(mock, ev.turnStart(SessionSeq(1), 1))
    await pushEvent(mock, {
      type: 'agent/inbox/spliced', seq: SessionSeq(2), time: 3,
      data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] },
    })
    await pushEvent(mock, ev.stepStart(SessionSeq(3), 1, 1))
    await pushEvent(mock, {
      seq: SessionSeq(4), time: 5, type: 'step/end', data: { turn: 1, step: 1 },
    })
    await pushEvent(mock, rewriteEvent(SessionSeq(5), original, handle.requestId))
    await settleFrames()
    expect(session.getSnapshot().pendingSubmissions).toHaveLength(1)
    expect(retirements).toEqual([])
  })

  it('keeps a rewritten submission echo when no real claim of its original was observed', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    await session.open()
    const retirements: PendingSubmissionRetirement[] = []
    const handle = await submitAccepted(session, {
      mode: 'queue', text: '未领取就被改写', attachments: [],
      onRetire: retirement => retirements.push(retirement),
    })
    const original = createUserMessage({
      content: [{ type: 'text', text: '未领取就被改写' }],
      source: { kind: 'user', rpcId: handle.requestId },
    })
    await pushEvent(mock, {
      type: 'agent/inbox/spliced', seq: SessionSeq(0), time: 1,
      data: { target: 'next-turn', start: 0, inserted: [original] },
    })
    await pushEvent(mock, rewriteEvent(SessionSeq(1), original, handle.requestId))
    await settleFrames()
    // No claim: the copy is not this submission's admitted counterpart.
    expect(session.getSnapshot().pendingSubmissions).toHaveLength(1)
    expect(retirements).toEqual([])
  })

  it('never retires on a producer-only message or on a borrowed request id without the original', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    await session.open()
    const retirements: PendingSubmissionRetirement[] = []
    const handle = await submitAccepted(session, {
      mode: 'queue', text: '真人输入', attachments: [],
      onRetire: retirement => retirements.push(retirement),
    })
    // Producer-only background: no submission identity at all.
    await pushEvent(mock, {
      type: 'user/message', seq: SessionSeq(0), time: 1, surfaceOp: 'append',
      data: freezeMessage({
        id: 'producer-message' as UserMessage['id'],
        role: 'user',
        content: [{ type: 'text', text: 'runtime context' }],
        source: { kind: 'producer-fixture' },
      }),
    })
    // Borrowed request id with no original occurrence ever observed by this Session.
    await pushEvent(mock, {
      type: 'user/message', seq: SessionSeq(1), time: 2, surfaceOp: 'append',
      data: freezeMessage({
        id: 'borrowed-rewrite' as UserMessage['id'],
        role: 'user',
        content: [{ type: 'text', text: '借用 rpcId' }],
        source: { kind: 'rewrite-fixture', rpcId: handle.requestId },
      }),
    })
    await settleFrames()
    expect(session.getSnapshot().pendingSubmissions).toHaveLength(1)
    expect(retirements).toEqual([])
  })

  it('does not build the original relation from a non-human producer Inbox occurrence', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    await session.open()
    const retirements: PendingSubmissionRetirement[] = []
    const handle = await submitAccepted(session, {
      mode: 'queue', text: '真实原始输入', attachments: [],
      onRetire: retirement => retirements.push(retirement),
    })
    // A producer copies the request id into an Inbox occurrence; the real human original
    // was never inserted, so there is no original relationship to consume.
    const forged = createUserMessage({
      content: [{ type: 'text', text: '伪造的原始' }],
      source: { kind: 'producer-request', rpcId: handle.requestId },
    })
    await pushEvent(mock, {
      type: 'agent/inbox/spliced', seq: SessionSeq(0), time: 1,
      data: { target: 'next-turn', start: 0, inserted: [forged] },
    })
    await pushEvent(mock, ev.turnStart(SessionSeq(1), 1))
    await pushEvent(mock, {
      type: 'agent/inbox/spliced', seq: SessionSeq(2), time: 3,
      data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] },
    })
    await pushEvent(mock, {
      type: 'user/message', seq: SessionSeq(3), time: 4, surfaceOp: 'append',
      data: freezeMessage({
        ...forged,
        content: [{ type: 'text', text: '伪造的有效版' }],
      }),
    })
    await settleFrames()
    expect(session.getSnapshot().pendingSubmissions).toHaveLength(1)
    expect(retirements).toEqual([])
  })

  it('clears a stale claim when the original occurrence is re-inserted, and a new claim settles it', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    await session.open()
    const retirements: PendingSubmissionRetirement[] = []
    const handle = await submitAccepted(session, {
      mode: 'queue', text: '被重领的输入', attachments: [],
      onRetire: retirement => retirements.push(retirement),
    })
    const original = createUserMessage({
      content: [{ type: 'text', text: '被重领的输入' }],
      source: { kind: 'user', rpcId: handle.requestId },
    })
    await pushEvent(mock, {
      type: 'agent/inbox/spliced', seq: SessionSeq(0), time: 1,
      data: { target: 'next-turn', start: 0, inserted: [original] },
    })
    await pushEvent(mock, ev.turnStart(SessionSeq(1), 1))
    await pushEvent(mock, {
      type: 'agent/inbox/spliced', seq: SessionSeq(2), time: 3,
      data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] },
    })
    // preserveClaimed re-inserts the same original; the old claim no longer authorizes it.
    await pushEvent(mock, {
      type: 'agent/inbox/spliced', seq: SessionSeq(3), time: 4,
      data: { target: 'next-turn', start: 0, inserted: [original] },
    })
    await pushEvent(mock, rewriteEvent(SessionSeq(4), original, handle.requestId))
    await settleFrames()
    expect(session.getSnapshot().pendingSubmissions).toHaveLength(1)
    expect(retirements).toEqual([])

    // A second real claim of the re-inserted occurrence settles the echo.
    await pushEvent(mock, {
      type: 'agent/inbox/spliced', seq: SessionSeq(5), time: 6,
      data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] },
    })
    session.projections.apply('inbox', { 'next-turn': [], 'next-step': [] }, SessionSeq(5))
    await pushEvent(mock, ev.stepStart(SessionSeq(6), 1, 1))
    await pushEvent(mock, rewriteEvent(SessionSeq(7), original, handle.requestId))
    await settleFrames()
    expect(session.getSnapshot().pendingSubmissions).toEqual([])
    expect(retirements).toEqual([{ reason: 'observed', attachments: [] }])
  })
})

describe('disposal', () => {
  it('settles an admitted transcript as observed when disposed before the Inbox watermark arrives', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    await session.open()
    const onRetire = vi.fn()
    const handle = session.beginSubmission({ mode: 'queue', text: 'admitted', attachments: [], onRetire })
    const refs = [imageRef('held-image')]
    await pushEvent(mock, {
      type: 'agent/inbox/spliced', seq: SessionSeq(0), time: 1,
      data: { target: 'next-turn', start: 0, inserted: [queuedItem(handle.requestId, refs)] },
    })
    await pushEvent(mock, {
      type: 'agent/inbox/spliced', seq: SessionSeq(1), time: 2,
      data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] },
    })
    await pushEvent(mock, promptEvent(SessionSeq(2), handle.requestId, refs))
    expect(onRetire).not.toHaveBeenCalled()
    await session.dispose()
    await settleFrames()
    expect(session.getSnapshot().pendingSubmissions).toEqual([])
    expect(onRetire).toHaveBeenCalledExactlyOnceWith({ reason: 'observed', attachments: refs })
  })

  it('retires unsettled echoes as failed and preserves an already-observed settlement', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    await session.open()
    const retirements: { text: string; retirement: PendingSubmissionRetirement }[] = []
    const observed = session.beginSubmission({
      mode: 'queue',
      text: '已观察',
      attachments: [],
      onRetire: retirement => retirements.push({ text: '已观察', retirement }),
    })
    session.beginSubmission({
      mode: 'queue',
      text: '未settle',
      attachments: [],
      onRetire: retirement => retirements.push({ text: '未settle', retirement }),
    })
    await pushEvent(mock, promptEvent(SessionSeq(0), observed.requestId))
    await session.dispose()
    await settleFrames()
    expect(retirements).toEqual([
      { text: '未settle', retirement: { reason: 'failed' } },
      { text: '已观察', retirement: { reason: 'observed', attachments: [] } },
    ])
    expect(session.getSnapshot().pendingSubmissions).toEqual([])
  })
})
