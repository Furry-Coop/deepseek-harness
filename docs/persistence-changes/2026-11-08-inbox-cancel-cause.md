---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-08-inbox-cancel-cause

English | [中文](2026-11-08-inbox-cancel-cause.zh.md)

## Summary

Adds optional `cause` and `entrySeq` members to the durable cancellation splice of an agent's pending inbox.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-08-inbox-cancel-cause
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "52a43832678a8f67acd18e84481ee23a29744f9040f73275fb4f2d8c5fa1f283"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid because both members are optional and every reader that does not know them preserves them as opaque event data and ignores them. Producers write them only when `Agent.cancel()` records a lifecycle cancellation; ordinary removals, replacements, insertions, and claims keep the released fields exactly. `cause` distinguishes ordinary agent teardown (`disposed`) from every non-disposal cancellation (`user`), without live state; `user` means a non-disposal cancellation rather than a verified human click. `entrySeq` is the session log length captured at cancellation entry, before any abort listener or clear notification runs; a pending occurrence inserted at or after that cut is later input the cancellation did not target, even when the cancellation's own splice is logged later. Readers take `entrySeq`, not the splice's own sequence number, as the cut. A mutation that is not a lifecycle cancellation omits both members, and records written before this change omit them too: absence is the unknown historical representation, not evidence of a non-cancellation, and without `entrySeq` the exact entry cut cannot be rebuilt. A cancellation with `keepInbox` writes no splice. An empty-queue user cancellation writes one intent splice that removes nothing, so the fold and derived history are unchanged.

<a id="verification"></a>
## Verification

Real writers and readers, no key: the deferred intent is committed after its trigger and before the aborted turn/end and detach, `user` is recorded for user, parent, and hook clears and `disposed` for teardown, `keepInbox` and ordinary removals keep the released fields, input inserted after the entry cut stays pending, a failed intent write is followed by a later record, a deferred plus same-stack cancellation records both entry cuts, a cancellation raised from the record's own observers is bounded to one, and a throwing observer of that record is contained while its settle and detach still run, each read back from JSONL. Cold reads of real earlier-writer artifacts cover the three historical field shapes (both absent, cause only, cause plus `entrySeq` = 13) and an ordinary V4 control; the current reader rebuilds the `later C` queue with no model request, and the original rc.1 session reader (restored from the rc.1 release commit) accepts every shape, retains each member as opaque data without synthesizing a value, and appends after them without rewriting the original prefix. pnpm run build (10 gates) passed; pnpm exec vitest run packages/core/session packages/core/agent packages/core/agent-loop packages/goal plus the two gate specs (65 files, 1542 passed, 6 skipped), the persistence and format packages (66 files, 1768 passed, 10 skipped), and the session consumers (124 files, 2576 passed, 2 skipped) passed. verify-persistence-changes, verify-persistence-catalog, verify-persistence-formats, verify-session-format-catalog, verify-control-write-callers, and the documentation gates passed.

<a id="dev-note"></a>
## Dev Note

None.
