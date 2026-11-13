---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-13-title-from-input

English | [中文](2026-11-13-title-from-input.zh.md)

## Summary

Adds two log-only required V4 event types, session/title-from-input and session/title-llm-request-from-input, for titles derived from a claimed human Inbox occurrence whose admitted message replaced the human source kind. They carry exact frozen input references instead of misrepresenting effective seqs as human user/message seqs. The from-input audit record carries exactly one user message holding the provider's input as one text block.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-13-title-from-input
baseline: false
changes:
  - root: "event:session/title-from-input"
    previous: null
    after: "de1c98325f6847c0a642a13b2f4747d01f9a49d9e6277ca7b5f00a1a0eafb02d"
    decision: same-version
  - root: "event:session/title-llm-request-from-input"
    previous: null
    after: "98ea0f4f576cac3a881f3b42f12262edbd8ec95832d4dc8264a9a324f08f0d45"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid and ordinary session/title and session/title-llm-request writers and readers are unchanged. The new types are not marked ignorable: a released reader refuses them as SessionFormatUnsupportedError before reading or writing and leaves the physical file unchanged, which the report .check-logs/repair-supervision-20261113/title-input-compatibility.json records for both read and write access. A new reader folds the new result as the latest title and keeps its refs; the events never enter deriveMessages or the model surface. Before adopting a stored log, the new reader verifies every frozen ref against that log: a direct ref must be a human user/message, and an origin ref must name a non-canceled claim that removed the human occurrence, the first step entered in the same Turn, and the same-id admission carrying the same request correlation. The temporary fold counts every producer occurrence for real lane bounds and index shifts while keeping only human occurrences as inputs, and only a committed splice changes a lane. A mismatch is refused as SessionPersistenceCorruptionError before a handle publishes, the Session executes, or a torn raw tail is rewritten, leaving the file bytes and generations unchanged. A log without either new event keeps its existing read path, and no marker or relationship validation changes the old title records. The from-input audit record is exactly one user message with one text block, matching its writer. No header version bump is needed because the new discriminators are required and old readers refuse them safely.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/core/agent-loop packages/core/agent packages/api/session-controller packages/session/session-title packages/session/session-title-llm packages/session/session-persistence packages/session/session-persistence-jsonl packages/session/session-title-first-prompt-llm packages/experimental/session-title-all-prompts-llm packages/session-query/session-log-export: 2917 passed, 12 skipped (140 files), including 20 cold-validation and 18 storage-contract tests. The focused tests cover an all-rewrite title written as session/title-from-input with the original text kept off the model surface, a real JSONL file with a forged origin ref refused on both read and write opens as SessionPersistenceCorruptionError with unchanged bytes and no successor generation, a real mixed-producer two-lane JSONL log read back with its origin title, a same-id admission with a different correlation refused, a mixed ordinary plus rewritten history in admission order, a preserved claim whose old window is spent before a later reclaim, a canceled occurrence that cannot be admitted, over-removal past the complete lane still refused, checkpoint plus suffix reproducing the full title-input state, a missing checkpoint row refolding from the full log, and the title-llm-request-from-input audit record with exactly one message and one text block. A real AgentLoop pre-step rewrite of the first human input (same id and request correlation) drives the automatic first-prompt and all-prompts providers from the logged main request header to the new title without a manual refresh, and a real fork persisted to disk reopens before admission with no admitted input or title and after admission with the origin title accepted by the cold check. Duplicate, descending, and empty reference selections, provider mutation of prepared system/input/seqs before dispatch, and unknown required types still refused as unsupported before any corruption check are also covered.

<a id="dev-note"></a>
## Dev Note

None.
