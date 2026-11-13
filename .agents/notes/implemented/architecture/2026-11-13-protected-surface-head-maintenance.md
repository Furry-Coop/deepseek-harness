# Agent Note: Protected surface-head maintenance for plugin-owned first writes

Status: implemented

English | [中文](2026-11-13-protected-surface-head-maintenance.zh.md)

## Problem

A plugin that owns durable surface messages — a workdesk card block, for example — may only learn that its first write is due at `agent/pre-step`. The loop commits its own protected system head later, inside the step, so the plugin's `user/message` lands first. Live appends accept that order; the released V4 reader then refuses the log with `system/message requires a protected first surface head`, so every cold read of that session fails, including the turn lookup a side card performs. The recorded failure was exactly this order at seq 7 (plugin `user/message`), seq 8 (`step/start`), and seq 9 (`system/message`), in an artifact of 24 intact frames and 47 events with no torn tail: the cause is the produced order, not damage, framing, or file permissions.

No existing API preserves both the plugin's pre-step materialization and the first-step-empty path. `agent/pre-step` runs before `step/start`, so no listener can append after the head there. The `agent/request` waterfall also runs before the loop commits the head. Moving `step/start` ahead of the decision would open a step for an empty or rejected first batch, which is the zero-step path the loop must keep. A `session/event` observer is a notification, not an awaited append barrier. `maintainIdleHistory()` is true-idle only and always writes a message.

## Decision

`Agent.maintainSurfaceHead()` establishes or verifies the protected system head from the true idle phase without writing a message. It claims the same maintenance phase as `runMaintenance()` and `maintainIdleHistory()`, shares their scoped assembly and rendering, the single maintenance-head append, and the live and cancellation rechecks. The head position comes from the session's host-internal maintenance admission, which also answers a head-only read. On an empty surface the call commits one `system/message` carrying `maintenance: true` and no turn or step. This operation appends at most that one head and never a second; later prompt updates keep following the existing route and series policy of prompt admission, which it does not change. An existing head, including an empty rendering, is never replaced, duplicated, or moved. A surface that holds any node without a protected system head is refused as `history-conflict`, because adding a head there would reorder another writer's messages.

The commit and the durability checkpoint are separate outcomes, and the no-op path runs the same checkpoint: a head being present does not by itself confirm that it is durable. A failed checkpoint, a cancellation, or a replaced owner after the commit reports the committed position in `SurfaceHeadError.head` instead of claiming nothing was written, and a later call verifies durability instead of appending a second head. The durability checkpoint is a second await boundary, so the same live-identity and cancellation check runs again after it on both the no-op and the first-append path: a checkpoint listener that cancels otherwise lets a stale initialization settle as a confirmed success. The operation starts no request, turn, or step and writes no formal history message.

A caller must own an awaited idle point, such as its session-registration preparation, and must fail closed when that point is not idle. Waiting for idle inside a first `agent/pre-step` would wait on itself, so the operation reports `not-idle` rather than deferring to a later window.

## Producer of the maintenance alternative

The `system/message` alternative introduced for idle-history maintenance gains a second producer: `maintainSurfaceHead()`. Both producers run only at true idle and only as surface node 0 of an empty surface; the ordinary turn loop still writes the turn-committed shape. The persisted payload, its discriminator (`maintenance: true` with no `turn` or `step`), and the released reader are unchanged, so this is a same-version producer change rather than a new representation, and the acknowledgement recorded for that alternative keeps describing the type. The head-only producer writes no user message, so no new record kind or discriminator appears.

## Alternatives considered

**Move `step/start` before `agent/pre-step`, or commit the head from the pre-step waterfall.** Rejected: a turn-committed `system/message` requires an open step, and opening one before the decision admits a step for an empty or rejected first batch, which breaks the zero-step path.

**Defer the plugin's physical write to the `agent/request` waterfall.** Rejected: that waterfall also runs before the loop commits the head, so the append would still precede it; moving the request gate after step admission would consume a rejected batch and lose the reject-with-preserved-input contract.

**Have the ordinary loop commit a maintenance head at turn start or session creation.** Rejected: the alternative is produced only at true idle as node 0, and making every session's first turn write it would change the released producer contract and every log's shape for no plugin's benefit.

**Accept the order and relax the reader.** Rejected: the head rule keeps replacement and compaction from shadowing the prompt, and loosening the released generation would make already unreadable logs look valid.

**Catch the refusal and continue, or retry from a detached idle hook.** Rejected: proceeding produces exactly the unreadable log, and a detached retry cannot promise the first turn is safe.

**Reuse `maintainIdleHistory()` with a synthetic message.** Rejected: it would fabricate formal history the caller never wrote.

## Verification

`packages/core/agent-loop/tests/surface-head.spec.ts` drives the real AgentLoop, the real scoped assembly, and the JSONL backend. It pins the empty-surface head (maintenance marker, no turn or step, one flush, no turn, step, request, or inbox claim), the plugin pre-step append landing after the head with the cold reopen of the committed generation, the existing-head no-op that still flushes, a failed checkpoint on both the no-op and the first-append paths with the committed position and an idempotent retry, a cancellation raised by the head publication that keeps the committed head, a cancellation raised inside the durability checkpoint on both paths that reports the verified or committed head instead of a settled success, a non-empty head-less surface and a concurrent writer during assembly that are refused, `not-idle` during a turn and during another maintenance, cancellation during assembly, and a stale agent after disposal. Public teardown drains an in-flight maintenance, so a replaced owner cannot interleave with the checkpoint; the post-checkpoint gate is the same live-identity check the pre-append gate exercises. `packages/core/agent-loop/tests/idle-history.spec.ts` keeps its existing cases unchanged, so the shared helpers did not change idle history. The released reader's refusal of the original order is pinned by `packages/session/session-persistence-jsonl/tests/native-developer-admission.spec.ts`. Repository policy requires a keyless recorded-session snapshot and both SDK expected outputs for a loop change with user-visible output; those expectations for this capability belong to the snapshot and SDK scope owned beside this note, and the Host unit and JSONL cold-read evidence above does not substitute for them.

## Consequences

The cost is one optional public method, a second producer of one existing payload, and a caller obligation to own an awaited idle point. In exchange, a plugin's first surface write has a legal position without simulating a turn, a failed durability checkpoint is recoverable and never duplicated, and the loop's step ordering, the released reader, and the persisted generation stay untouched.
