# Agent Note: session surface ordering and the final assembly seam

Status: implemented

English | [中文](2026-11-16-session-surface-ordering-and-final-assembly-seam.zh.md)

## Problem

A plugin that owns model-visible material needs to arrange it in a fixed order — for example a system prompt, selected nodes, project instructions, a skill catalog, an optional task block, and the remaining temporary material. Two capabilities were missing.

First, no extension point ran after a step's own admission and before the request was frozen. `agent/pre-step` fires before `step/start`, before the system prompt, the accepted user batch, and the refreshed runtime-context snapshot are committed. `agent/request` fires even earlier, inside `prepareConfig`, and cannot change messages. A `session/event` observer cannot append at all: the log refuses a reentrant append so publication stays atomic. The loop's own admission order is not something a plugin can influence by writing at the right moment.

Second, the surface had no durable way to change the order of nodes that already exist. `{ op: 'replace', startSeq, endSeq }` puts the replacement at the position the shadowed range occupied, so moving a node meant recording a copy — losing its identity and bytes — and reordering a tool exchange risked splitting the pair. Derived history was sequence-monotonic by construction; only compaction's removal was positional.

## Decision

The Host provides two constrained seams and no business state.

**`surface/order` is a durable record of a full permutation.** A `Session` appends `{ nodes: SessionSeq[] }` with `session.append('surface/order', { nodes })`. The list must permute exactly the current surface nodes — no additions, omissions, or duplicates — must keep the current first node first (surface node 0 is the protected head), and must genuinely change the order. The fold rewrites node order only: recorded messages, their identities, and the log stay untouched, later appends join the permuted tail, and a later replacement resolves its endpoints in the order in force. The event advances both `replaceGeneration`, so a cached sequence-to-position index rebuilds, and `contentGeneration`, so derived history rebuilds and the next request logs a new series. Replay applies the same rewrite, so a live derivation and a cold reopen agree. The event is required on read: a reader that skipped it would assemble a different request, so refusing the log is the safe interpretation.

**`agent/history-assembling` is the final snapshot point for one attempt.** It is a waterfall fired once per attempt after the step's system-prompt commits, the accepted user batch, and the refreshed runtime-context snapshot are committed, and before the loop logs `request/header`, `request/context`, tool-change records, and the frozen array. Its payload is `{ agent, turn, step, signal }`; its continuation `next()` runs the built-in build synchronously and yields the frozen request. A listener may hold its own serialized writer, await durable work, then call `next()` while still holding it, so no queued update can enter between its commit and the snapshot. A listener must call `next()` exactly once and return that request unchanged; the loop rejects any other return value instead of dispatching an unfrozen request, and re-checks cancellation after the continuation returned so a turn cancelled during late cleanup never reaches the provider.

**Format validation replays the record.** `Relationships` in the V4 format package folds `surface/order` with the same rules before it interprets any later replacement, because replacement coverage is defined against the order in force. The coverage requirement itself is unchanged: every shadowed node must still be cited.

## Alternatives considered

**Reuse `agent/pre-step` or `agent/request`.** Both fire before the material that must be arranged exists. A listener there can only guess at the final admission order, and the request is frozen much later.

**Express ordering as an existing replacement.** `replace` cannot move a node without recording a copy, which changes identity, duplicates bytes, and can orphan a tool pair. The requirement is to reorder what is already recorded.

**Reorder without logging.** A live-only ordering would satisfy the immediate request but breaks the rule that anything model-visible is reconstructable from the log, and a cold reopen would send a different request than the one recorded.

**Ask plugins to append in the right order themselves.** The loop owns system-prompt commits, the accepted batch, and the refreshed runtime-context snapshot; a plugin cannot place its material between them by writing earlier.

**A serial listener that returns nothing.** Awaiting a serial listener and then building the request leaves a window in which the listener's own queued writer work can run between its return and the snapshot. Making the build the continuation closes that window: the snapshot happens inside the caller's serialized work.

**Mark `surface/order` ignorable.** An older reader would then keep sequence order and assemble a transcript the writer never sent. Refusal is the correct failure mode, so the event is required on read.

## Consequences

A reader older than this change refuses a log that contains `surface/order` instead of silently reordering nothing; the existing discriminators already prevent unsafe interpretation, so the Session format version stays V4. Positional consumers must follow the recorded order: the token meter reorders its priced mirror, and the compaction sequence-to-position cache rebuilds because `replaceGeneration` advances. A reorder changes the request prefix, so it starts a new message series — the honest consequence of moving earlier material.

The seam stays generic: it carries no partition, task, version, or environment concept, and it neither rewrites nor removes messages. Removal stays with the plugin's own `replace`, and ordering stays a pure positional record, so the Host never learns what the sections mean.

## Testing

`packages/core/session/tests/surface-order.spec.ts` covers permutation, replay, later appends and replacements, and every refusal. `packages/core/agent-loop/tests/history-assembly.spec.ts` covers the continuation, per-attempt retry, tool continuation, refusal of a non-frozen or unchanged return, and both cancellation windows. `history-assembly-persistence.spec.ts` and `packages/session/session-persistence-jsonl/tests/surface-order-restore.spec.ts` write through the real JSONL backend and cold-reopen. `packages/session/session-format-v3-to-v4/tests/relationships.spec.ts` pins the validator rules, including that a replacement omitting a shadowed node is still refused. `snapshots/session/history-assembly-order/` records the ordering through a shipped profile with a controlled scenario plugin and replays keylessly.
