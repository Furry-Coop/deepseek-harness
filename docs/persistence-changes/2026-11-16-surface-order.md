---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-16-surface-order

English | [中文](2026-11-16-surface-order.zh.md)

## Summary

Adds the required surface/order event that records a full permutation of the current model-visible surface nodes.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-16-surface-order
baseline: false
changes:
  - root: "event:surface/order"
    previous: null
    after: "8f57b214e35cb85cfac08f5270ebe1d69dca94847a9b6c6e222038e06f81d196"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing logs stay readable: the event is additive, and a session that never reorders has no such record. A build older than this change refuses to open a log that contains surface/order instead of silently deriving sequence order, because skipping the event would assemble a different request than the writer sent; that refusal is the intended safe interpretation and keeps the writer version at V4. Within the current build, the runtime surface fold, the V4 format relationships, the priced token surface, and every later replacement resolve positions in the recorded order.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/core/session packages/core/agent-loop packages/llm/token-meter packages/session/session-format-v3-to-v4 packages/session/session-persistence-jsonl: passing. The V4 relationship suite and the real JSONL cold-reopen spec both fail with 'replacement sourceEventSeqs omit a shadowed surface node' when the relationships replay is removed, and pass with it; an incomplete coverage list is still refused.

<a id="dev-note"></a>
## Dev Note

None.
