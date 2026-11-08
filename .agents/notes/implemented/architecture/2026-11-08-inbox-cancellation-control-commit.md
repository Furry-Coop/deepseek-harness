# Agent Note: Commit the durable cancellation record through a host-internal control write

Status: implemented

English | [中文](2026-11-08-inbox-cancellation-control-commit.zh.md)

## Problem

A cancellation that removes no pending input must still leave one durable fact, so recovery can tell a user cancellation from a crash that merely lost the queue. The fact belongs to the cancellation that the loop observed, not to a plugin: the inbox owns pending input, the turn signal, and the clearance order. The record is written from a `session/event` observer when the cancellation is raised while another append is publishing — for example a hook that cancels on a step event — and the log rejects a reentrant append to keep its publication atomic.

A public callback queue would let any consumer schedule arbitrary work after any publication, with no bound, and would force the caller to discover reentrancy by matching the append error text. The queue would have exactly one production consumer — the loop's cancellation record — and it would invite plugins to schedule writes that belong to the operation that owns them.

## Decision

`Session` exposes no callback queue. The session package exports `appendAfterPublication(session, type, data, settled?)`, the host-internal control-write capability. It accepts one typed append, never a caller-supplied callback: the store mints the write from its arguments and holds at most one per publication, refusing a second request loudly.

Without an open publication the record is appended immediately and a failure reaches the caller. During a publication the record waits in the entry's single slot and `commit()` drains it after the publication returns and before a deferred detach, so the record lands synchronously after the publication that observed the cancellation and before the store attachment ends. A deferred append that fails is logged and detach still happens, because the publication it repairs already committed. A nested publish from the control write cannot detach under the open drain; a write it queues joins that drain's tail.

Ownership follows the store entry. An independent Session appends directly. A store-owned Session that is detached, unentered, still announcing, or whose announcement failed gets no deferred write: the immediate append refuses with the store's own error, so a record cannot be queued for an entry that will never publish it. The optional `settled` completion runs exactly once and synchronously after the record commits or fails, or before a refusal throws; a consumer therefore releases ownership in the same tick rather than deferring it to a microtask.

The inbox records `cause` (`user` for every non-disposal cause, `disposed` for teardown) and `entrySeq`, the log length captured at cancellation entry, so a reader can distinguish input the cancellation targeted from input appended afterwards; a cancellation with `keepInbox` writes nothing. An empty-queue user cancellation appends one intent splice that removes nothing, so the fold and derived history are unchanged. The `verify-control-write-callers` gate admits the owner module, the agent-loop inbox, tests, and itself, and rejects every other production caller.

## Alternatives considered

**Keep a public callback queue.** It is the shape the capability started with. It runs arbitrary work after any publication, has no bound, and makes reentrancy a string match ([packages rules](../../../../packages/AGENTS.md): a public service method with one internal caller should be a private capability instead).

**Defer with a microtask.** The cancellation record must be durable before the store detaches the session; a microtask runs after the synchronous publication and detach path, so a teardown that follows the publication would lose it.

**Let the plugin re-append the fact after the publication.** The record is evidence about the loop's own cancellation cut, which no later caller can reconstruct; and a plugin may dispose the session in the same stack, before it could append.

**Add a new session event for the fact.** `agent/inbox/spliced` already represents pending input and its cancellations, and the empty intent is a no-op for the fold; a second representation would need its own reader compatibility without adding meaning.

**Accept a record before an announcement completes.** The record would have to be dropped on rollback or published after a failed announcement, which turns a durable fact into an unowned write. Refusing keeps the store's announced-membership rule in one place.

## Testing

`packages/core/session/tests/session.spec.ts` covers the immediate append, the deferred append that lands after the publication and before detach, refusal of a second record with both requests settled, a throwing settlement, a failing deferred append that is contained while detach still happens, and refusal for an unentered, unannounced, failed, or detached store entry. `packages/core/agent-loop/tests/cancel-persistence.spec.ts` uses the real AgentLoop and JSONL backend: the deferred intent is sequenced after its trigger and before the aborted turn/end and detach, is read back from disk, and is recorded for user, parent, and hook clears with `cause: 'user'` and for teardown with `cause: 'disposed'`; `keepInbox` and ordinary removals keep the released fields; input inserted after the entry cut stays pending; a failed intent write is followed by a later record; a deferred plus same-stack cancellation records both entry cuts; and a cancellation raised from the record's own observers is bounded to one record. `packages/core/agent-loop/tests/cancel.spec.ts` covers the abort guarantee when the pending snapshot rejects with a non-Error value, including `undefined`, and the existing cancellation windows. `packages/core/agent-loop/tests/initialization-wake.spec.ts` covers the idle empty cancellation recording one intent while arming no turn. `scripts/verify-control-write-callers.spec.ts` proves the gate rejects release-package references and admits the inbox.

## Consequences

The session package grows one exported function with a caller gate instead of a public `Session` method, and its publication path holds one optional slot instead of an unbounded queue. The cancellation record keeps its durability, ordering, and failure behavior: committed after the observation that raised the cancellation, before detach, with a contained failure that never blocks the abort. The deferral is bounded to one record per publication; a second requester fails instead of growing a queue, and one guard flag per inbox bounds reentrant cancellation. The `agent/inbox/spliced` format adds two optional members, so older readers retain and ignore them and absence remains unknown history. `cause: 'user'` continues to mean a non-disposal cancellation rather than a verified human click.
