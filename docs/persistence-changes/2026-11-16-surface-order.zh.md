---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-16-surface-order

[English](2026-11-16-surface-order.md) | 中文

## 概述

新增必需的 surface/order 事件，用于记录当前模型可见 surface 节点的一次完整置换。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

既有日志仍可读：该事件是新增的，从不重排的会话不会有该记录。比本次变更更旧的构建会拒绝打开含 surface/order 的日志，而不是静默按 seq 顺序派生，因为跳过该事件会装配出与写入方不同的请求；这种拒绝是预期的安全解释，使写入方版本保持 V4。在当前构建内，runtime surface 折叠、V4 格式关系校验、计价用 token surface 以及后续每次替换都按已记录顺序解析位置。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/core/session packages/core/agent-loop packages/llm/token-meter packages/session/session-format-v3-to-v4 packages/session/session-persistence-jsonl：通过。移除关系层重放后，V4 关系套件与真实 JSONL 冷重开用例都会以 'replacement sourceEventSeqs omit a shadowed surface node' 失败，恢复后通过；不完整的覆盖清单仍被拒绝。

<a id="dev-note"></a>
## 开发备注

无。
