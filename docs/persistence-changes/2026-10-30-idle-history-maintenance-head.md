---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-30-idle-history-maintenance-head

English | [中文](2026-10-30-idle-history-maintenance-head.zh.md)

## Summary

Adds a second, explicit `system/message` payload representation for a prompt committed outside any turn: `{ maintenance: true, message }`, with no `turn` or `step`.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-30-idle-history-maintenance-head
baseline: false
changes:
  - root: "event:system/message"
    previous: "2026-09-16-session-format-v4"
    after: "d7512d48304c76194949f420847322fae40a8f520bfc897ec597686dc8ea7d08"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records keep their meaning and stay valid: a turn-committed prompt still carries its positive `turn` and `step` and no marker, and the two representations are mutually exclusive on both the writer and the reader. A reader of this build accepts either, requires a maintenance head to establish surface node 0 between turns and outside an open step and any open compaction, and refuses a payload that mixes the marker with coordinates. A released reader that predates the alternative refuses the row during early field admission of its V4 codec (physical row validation and the artifact restorer), before any write, mutation, or tail repair, so a stored generation containing a maintenance head cannot be reopened by that build. The refusal observed on the current writer's own generation is exactly that codec-level refusal. Persistence-level evidence for the pre-writer candidate rows — SessionPersistenceCorruptionError caused by SessionFormatError, no writer returned, unchanged file hash, across clean and torn-prefix read and write attempts — was measured with the fixed backend; the open path composes this same V4 codec admission, so the same refusal is expected there, but it was not re-run on the current file. Neither is an unsupported-version or ignorable skip: the added representation is a required, loudly refused feature for older readers rather than silent data loss.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/session/session-format-v3-to-v4/tests packages/core/session/tests/system-message-maintenance.spec.ts packages/core/agent-loop/tests/idle-history.spec.ts: 434 tests passed, covering the V4 row-admission and relationship refusals, the append/seed shape rejections, and JSONL v4 close and reopen through the installed catalog. A probe running the released V4 sources from the fixed commit directly against the new writer's real generation refuses it on the write path, on the strict read path, on the recoverable read path after a torn row, and at the artifact relationship entry, while the installed reader accepts the same bytes and the file hash is unchanged.

<a id="dev-note"></a>
## Dev Note

None.
