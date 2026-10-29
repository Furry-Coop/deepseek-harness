---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-29-inbox-cancel-cause

English | [中文](2026-10-29-inbox-cancel-cause.zh.md)

## Summary

Adds an optional cause to the durable cancellation splice of an agent's pending inbox.

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
    after: "b7997aec19a8df60f02a8bfdc652c6cfafeaec2d149250e514cb95d644f84bc7"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid because the member is optional and readers that do not know it ignore it. Producers write it only when Agent.cancel clears pending input; ordinary users of the event keep the same fields. The member carries the stable caller intent for the cancellation, so a cold reader can distinguish ordinary agent teardown from a user cancellation without live state. An absent cause means the mutation was not a lifecycle cancellation.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/core/agent-loop/tests/cancel.spec.ts packages/core/agent-loop/tests/interception.spec.ts: 74 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
