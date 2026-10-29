---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-29-inbox-cancel-cause

English | [中文](2026-10-29-inbox-cancel-cause.zh.md)

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
id: 2026-10-29-inbox-cancel-cause
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-user-rpc-principal"
    after: "c06936bd82f49bc422c5f84ef3d5cabd9cb91c964d2cc0e8d95444f857503beb"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid because both members are optional and readers that do not know them ignore them. Producers write them only when `Agent.cancel()` records a lifecycle cancellation; ordinary users of the event keep the same fields. `cause` distinguishes ordinary agent teardown from a user cancellation without live state. `entrySeq` is the session log length captured at cancellation entry, before any abort listener or clear notification runs; a pending occurrence inserted at or after that cut is later input the cancellation did not target, even when the cancellation's own splice is logged later. Readers take `entrySeq`, not the splice's own sequence number, as the cut, so an older cancellation cannot claim a later turn's claim or first build. Absent members mean the mutation was not a lifecycle cancellation; a cancellation with `keepInbox` writes no splice.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/core/session packages/core/agent packages/core/agent-loop: 51 files passed, 1128 tests passed with 1 skipped. pnpm run build:artifacts: 7 gates passed. pnpm run build:check: 2 aggregate gates passed. Contract tests cover captured-message identity removal, the entry cut recorded before deferred input, and the abort guarantee when capture fails; an old-source A/B run was not executed.

<a id="dev-note"></a>
## Dev Note

None.
