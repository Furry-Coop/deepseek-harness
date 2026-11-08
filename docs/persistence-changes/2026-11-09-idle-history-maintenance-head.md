---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-09-idle-history-maintenance-head

English | [中文](2026-11-09-idle-history-maintenance-head.zh.md)

## Summary

Adds an idle-history maintenance alternative to the durable `system/message` payload: a protected system head committed outside any turn, carrying `maintenance: true` and no `turn` or `step`. The turn-committed alternative is unchanged.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-09-idle-history-maintenance-head
baseline: false
changes:
  - root: "event:system/message"
    previous: "2026-09-16-session-format-v4"
    after: "d7512d48304c76194949f420847322fae40a8f520bfc897ec597686dc8ea7d08"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The two alternatives are exclusive, and the marker is a required discriminator rather than an optional feature: a row either names positive `turn` and `step` or names `maintenance: true` and neither coordinate. The new alternative is produced only by `Agent.maintainIdleHistory()` while the agent is truly idle and only as surface node 0 of an empty surface; the ordinary turn loop keeps writing the released shape. Absence of the marker therefore retains the complete old behavior, and no accepted record contains it. A reader that does not know this alternative does not interpret it as a turn prompt and does not drop it as a recoverable tail: the released V4 codec rejects the row at physical admission, before framing, source-range decoding, or tail recovery, and the released restorer rejects the same event before relationships, adoption, or derivation (measured against the rc.1 reader, which refuses both a complete and a truncated maintenance-head generation with no request and unchanged source bytes). Readers that know the alternative preserve the historical turn-committed meaning exactly: the head still projects to one system message, a later turn reconciles it through the ordinary per-node head replacement, and derived history, resume, fork, and query views read the same surface. The record cannot be read as `system/message` without the marker, so the alternative cannot be mistaken for the released form.

<a id="verification"></a>
## Verification

Real writers and readers, no key: a real AgentLoop plus JSONL persistence records the head and message from the idle phase, then a later turn and a cold reopen assemble the recorded history in request order with one system node; the same run covers a non-empty surface whose first node is not a protected head, idempotent same-identity retry, different-content and non-lossless-JSON conflicts, head-publication cancellation with the committed head as recovery state, an injected write and fsync window failure (the checkpoint failure keeps the committed position, the retry appends nothing, the stored generation is byte-identical after rollback, and the cold reopen recovers exactly one copy), an empty rendered prompt, and a torn trailing frame. Physical and restore gates reject a maintenance head inside an open step, after another surface node, with a replacement operation, inside an open compaction, with a `turn` or `step` coordinate, and with a false or non-boolean marker, and accept the head only as the empty append head, including a seeded fork header without `parentSession`. pnpm run typecheck passed; pnpm run build and the persistence, session-format, documentation, and targeted agent-loop/session gates passed.

<a id="dev-note"></a>
## Dev Note

None.
