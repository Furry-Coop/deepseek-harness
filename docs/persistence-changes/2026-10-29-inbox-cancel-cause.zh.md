---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-29-inbox-cancel-cause

[English](2026-10-29-inbox-cancel-cause.md) | 中文

## 概述

为 Agent 待处理 inbox 的持久取消 splice 增加可选 `cause` 与 `entrySeq`。

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
    after: "c06936bd82f49bc422c5f84ef3d5cabd9cb91c964d2cc0e8d95444f857503beb"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录仍然有效：两个成员都是可选的，不认识它们的读取方会忽略。只有 `Agent.cancel()` 记录生命周期取消时才写入；事件的普通使用方字段不变。`cause` 使冷读取能区分正常 Agent 销毁与用户取消，不依赖实时状态。`entrySeq` 是取消进入时、任何 abort 监听器或 clear 通知运行前捕获的会话日志长度；在该 cut 处或之后插入的待处理项属于取消未针对的后续输入，即使取消自身的 splice 记录更晚。读取方以 `entrySeq` 而不是 splice 自身序号作为 cut，因此较早的取消不能认领较晚 turn 的 claim 或首次构建。缺少成员表示该变更不是生命周期取消；带 `keepInbox` 的取消不写 splice。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/core/session packages/core/agent packages/core/agent-loop：51 个文件通过，1128 个测试通过、1 个跳过。pnpm run build:artifacts：7 个 gate 通过。pnpm run build:check：2 个聚合 gate 通过。契约测试覆盖按身份删除捕获消息、延迟意图前记录 entry cut，以及捕获失败时仍取消活动；未执行旧源码 A/B 对照。

<a id="dev-note"></a>
## 开发备注

无。
