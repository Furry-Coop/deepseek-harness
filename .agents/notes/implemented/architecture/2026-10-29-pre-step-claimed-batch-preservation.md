# Agent Note: Preserve the claimed pre-step batch across a blocking reject

Status: implemented

English | [中文](2026-10-29-pre-step-claimed-batch-preservation.zh.md)

## Problem

`agent/pre-step` receives the batch the loop has already claimed from the inbox. A rejecting listener could previously only consume that batch: the messages were neither entered into the step nor returned to the inbox, and the turn closed `blocked`. A plugin that must delay a turn after its own admission check fails — for example, when the first context assembly cannot yet produce a request — needs to keep the user's question for a later attempt. Re-injecting the messages one by one with `inject` or `splice` appends them to the next-step lane, behind steering or context input that arrived during the failed pre-step, and cannot express the original turn-owning message as one batch. A plugin that also wants cancellation to win has to race the loop's own cancellation handling, which can resurrect input after a clear.

The loop owns the claim because it removes the messages through the durable inbox projection and owns the turn, step, and cancellation lifecycle ([agent-loop README](../../../../packages/core/agent-loop/README.md)). A plugin cannot reconstruct that ownership from the public inbox without duplicating the FIFO and racing the cancellation paths.

## Decision

A reject decision may set `preserveClaimed: true`. The loop snapshots the exact claimed batch at claim time, independently of the waterfall payload, and restores that snapshot when the rejecting decision returns. The restore is one `agent/inbox/spliced` insertion at position zero of `next-step`, so the batch keeps its original order and stays ahead of input inserted during pre-step. The turn still ends `blocked`: the driver does not re-run, and no request, step, or user message is recorded at rejection time. The parked batch is consumed only when a later waking input opens a turn and the loop claims the pending-step lane again.

Cancellation owns the outcome. If the turn signal is aborted, or a synchronous observer cancels during the restore, the batch is not preserved and the restored occurrences are cleared like any other cancelled input. A plain reject keeps the previous consumption semantics, and a thrown listener consumes its claim before reporting the driver error. The preserved batch is ordinary pending input: the durable `inbox` projection folds it from the same splice event, and the next claim emits `agent/inbox/claimed` again for the same messages.

## Alternatives considered

**Re-inject from the plugin.** The pre-step listener could call `inject` for each claimed message. This appends behind input that arrived after the claim, changes the waking message from a next-turn prompt into next-step context, and leaves cancellation and duplicate-identity handling to the plugin. The loop's claim is the only place that still knows the exact batch and its order.

**Keep the claim in a plugin-owned queue.** A second queue in the plugin would duplicate the inbox FIFO and has no authority over the loop's cancellation cut. The loop would still have consumed the original occurrences, so a later clear could not distinguish the copy from new input.

**Add a new session event.** The existing `agent/inbox/spliced` fold already reconstructs pending input and validates duplicate ids and coordinates. A restore is an ordinary insertion, so a new event would add a second representation of the same state without a current consumer.

**Return an enter decision and rely on the next step.** Entering a step commits user messages and can send a model request. A blocked turn must not create a request, and the next turn boundary is what makes the restored prompt a waking input.

## Testing

`packages/core/agent-loop/tests/interception.spec.ts` covers the contract through the real loop and waterfall: a listener reverses and appends to the payload before rejecting, a multi-message claim returns ahead of staged input, the rejected turn records no user message, step, assistant event, or model request, the durable inbox projection folds the same order, a gate that already returned its claim is not duplicated, a synchronous observer's cancel during the restore leaves nothing resurrected, and user cancellation, owner disposal, and a `keepInbox` enter each consume the claim instead of restoring it. `packages/core/agent-loop/tests/resume.spec.ts` writes the restore through the JSONL backend, folds the stored events back to the same order, and shows that only the next wake records the batch and requests it in order. No keyless snapshot scenario changes: no shipped profile opts into `preserveClaimed`, so recorded transcripts and the TypeScript and Python SDK projections keep their current expected output.

## Consequences

The loop keeps one pending-claim slot for the duration of a pre-step. That slot is cleared when the decision is admitted, rejected, or thrown, so it cannot leak into a later step. `PreStepDecision` grows one optional field; the enter and plain reject paths are unchanged. The plugin owns the business decision to preserve, while the loop owns order, identity, atomic restore, cancellation priority, and the absence of an active wake. The durable `inbox` projection remains the single source for pending input, and no model-visible text or request changes for a plugin that does not opt in.
