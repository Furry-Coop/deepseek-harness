# Agent Note: Redeem a latched wakeup by its inserted occurrence

Status: implemented

English | [中文](2026-11-08-wakeup-insertion-identity.zh.md)

## Problem

The loop latches a wake it cannot deliver immediately: a waking send that arrives during a maintenance task, or one that lands after a turn's abort signal is set but before the driver converges. That latch was a boolean paired with `inbox.hasPending` at convergence, so any pending input counted as evidence that the wake still owed a turn. A caller could send a followup, remove it, and the loop would still open a turn for the passive input that remained; a passive reinsert of the same message identity counted as well. During disposal the same rule started a turn over a session being torn down.

Initialization had a related gap. The Factory fails an initialization by cancelling with `disposed` while keeping the queue, but the abort signal keeps its first cause: when the user's ordinary stop arrived first, the maintenance signal's cause stayed `user` and the latched proactive wake dispatched a turn during rollback, consuming the queued input the failure contract promises to keep.

## Decision

A latched wake is the exact pending occurrence the waking insertion produced. `ReactLoopInbox.insert()` commits through the same durable splice and returns this splice's own projection message — the message in `event.data.inserted` — or `undefined` when a synchronous observer removed it before the append returned. `Session.append` detaches its payload, so a callback that removes and re-inserts the same caller object creates a different occurrence; identity is reference comparison against the live projection. The running and maintenance phases hold a `Set` of occurrences, and convergence redeems a wake only while `holdsOccurrence()` still finds one pending. A wake sent from true idle still starts the driver unconditionally: its turn boundary is the record of the waking delivery even when a synchronous observer withdrew the message during insertion.

`Agent.cancel()` captures the activity and one snapshot of both pending lanes before it runs any callback, drops the wakes that cancellation owns, aborts only that captured activity, and then removes only the captured occurrences by identity. Input delivered by an abort listener or a discard notification therefore stays pending and wakes the next activity. When the agent was idle, a wake delivered from a clear callback is deferred until both lanes' captured occurrences are gone, and replayed only if its own occurrence is still pending.

A disposal request is recorded on the activity independently of the abort reason. `runMaintenance()` redeems its latched wakes only while the activity is not disposed, so the Factory's failure path (`agent.cancel({ kind: 'disposed' }, { keepInbox: true })`) keeps the queue and starts no turn, claim, or request; rollback then releases the write handle with the pending splice intact. A successful publication leaves the queue and redeems the latch, and an ordinary `runMaintenance()` job still redeems a later real wake after it rejects.

The request is also remembered for the enclosing cancellation window. An idle user cancellation that disposes the agent from its own discard notification keeps the wake it held parked instead of replaying it at depth zero, and a request that lands from a synchronous `turn/end` observer leaves the driver idle: the natural next turn neither replaces the aborted controller nor claims the input `keepInbox` preserved.

## Alternatives considered

**Keep the boolean and compare message ids.** The message id is the caller's identity, and the pending-input contract permits reinserting the same identity after removal. A removed wake followed by a passive reinsert under the same id would still pass an id check.

**Add a durable wake record.** A wake is process-local delivery bookkeeping. The durable inbox projection already holds every pending occurrence, and a new event would add a second representation with no cold-recovery consumer.

**Let the last abort cause win.** `turn/end` records the first cause, and transports rely on the caller's object remaining the signal reason. Changing which cause wins would rewrite committed turn endings.

**Suppress every maintenance latch redemption on job failure.** Ordinary `runMaintenance()` jobs legitimately latch a wake after their cancellation and must redeem it; only disposal suppresses replay.

**Require a live registry entry.** Initialization enters the AgentRegistry before awaiting `agent/created`, so a failing lifecycle is still registered when its maintenance settles; registry presence cannot distinguish a failed initialization.

## Testing

`packages/core/agent-loop/tests/wakeup-identity.spec.ts` drives the native loop through abort-listener deliveries: a removed wake with only passive next-step input left, a same-identity passive reinsert, a steering wake latched behind maintenance and removed, several removed wakes, a later real wake, an occurrence withdrawn during its own insertion, and disposal. `packages/core/agent-loop/tests/initialization-wake.spec.ts` gates `agent/created` on real JSONL persistence, sends a real followup, stops with `keepInbox`, and rejects the listener: no turn, claim, or request is recorded, the stored pending splice is readable after the handle is released, and a cold resume reads the queue without dispatching until a later followup runs it in order. Its companion case shows that a listener which returns publishes and then runs the latched wake. `packages/core/agent-loop/tests/cancel.spec.ts` covers cancellation capture: abort-listener input survives, captured occurrences are removed by identity and in place, an idle clear-callback wake waits for both lanes and is withdrawn when its occurrence is, a failed removal starts nothing, and a disposal starts nothing; a disposal nested in an idle user cancellation parks the late waking followup, and a synchronous `turn/end` observer requesting disposal with `keepInbox` leaves the driver idle with its input pending.

## Consequences

The latch costs one `Set` of projection references and one snapshot per clearing cancellation. Nothing new is persisted: the `agent/inbox/spliced` event, the durable inbox projection, and the TypeScript and Python SDK projections are unchanged, and `Inbox` keeps its public `clear()` and splice return values. The occurrence-returning insert and the capture helpers stay on the package-internal `ReactLoopInbox`. Cancellation now aborts the captured activity before it removes that activity's input, so an abort listener's input is classified as waking the next activity instead of joining the cancelled one, and one snapshot removes captured occurrences in place, preserving the surrounding queue order. A wake whose insertion is withdrawn opens no turn; a caller that needs a turn boundary must send it while idle. A wake latched in a cancellation window that requested disposal stays pending, and a disposal request that arrives after the turn's last signal check ends the driver instead of opening its natural next turn. A failed initialization keeps the queue and stops there, so the retained input stays passive until a later real wake or a cold resume.
