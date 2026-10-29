---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-29-inbox-cancel-cause

[English](2026-10-29-inbox-cancel-cause.md) | 中文

## 概述

为 Agent 待处理 inbox 的持久取消 splice 增加可选 cause。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

已有记录仍然有效：该成员是可选的，不认识它的读取方会忽略。只有 Agent.cancel 清空待处理输入时才写入；事件的普通使用方字段不变。该成员携带取消的稳定调用方意图，使冷读取能区分正常 Agent 销毁与用户取消，不依赖实时状态。缺少 cause 表示该变更不是生命周期取消。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/core/agent-loop/tests/cancel.spec.ts packages/core/agent-loop/tests/interception.spec.ts：74 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
