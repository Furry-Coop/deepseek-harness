---
kind: upgrade-guide
description: "被改写 Inbox 输入的会话标题快照改用 inputRefs，不再把来源表示为人类 messageSeqs；旧 reader 会拒绝含新 required 标题事件的会话。"
---
# 会话标题归因改用输入引用

[English](guide.md) | 中文

## 变更

`SessionTitleSnapshot` 不再总以人类 `messageSeqs` 表示标题来源。当标题来自被 claim 的真人 Inbox occurrence，且其准入消息替换了 human source kind 时，`ctx.sessionTitle.get(session)` 与提供方的 `currentTitle` 现在返回 `messageSeqs: []`，并携带可能混合 direct 与 origin 项的 `inputRefs`：`{ kind: 'message', messageSeq }` 或 `{ kind: 'origin', originalInboxSeq, messageId, claimSeq, admittedSeq }`。只有全部选中项都是 direct `message` 引用时，标题才沿用旧的 human `messageSeqs`；只要任一选中项是 `origin`，就使用新的 required 事件并按准入顺序保留全部选中引用。`source.kind` 独立判断：`user` 仍表示手动 pin，`fallback` 与 `provider` 表示自动标题。

会话日志新增两个 required 事件类型：`session/title-from-input` 与 `session/title-llm-request-from-input`。它们不是 ignorable：早于这两个事件的 reader 会在读取、写入或修复日志之前，以 `SessionFormatUnsupportedError` 拒绝包含它们的会话。因此 TypeScript 与 Python SDK 的 `session.event` 投影都携带这两个 required 类型。

[2026-11-13 title-from-input 记录](../../../persistence-changes/2026-11-13-title-from-input.zh.md)负责 schema 决策与 reader 兼容性；[session-title 子系统](../../../subsystems/session-title.zh.md)定义这些引用。

## 迁移

1. 把所有消费 `SessionTitleSnapshot` 或提供方 `currentTitle` 的 reader 升级到认识 `inputRefs` 与两个 required 事件的版本。
2. `inputRefs` 存在时按准入顺序使用这些引用归因；列表可能混合 direct `message` 与 `origin` 项。只有全部选中项都是 `message` 时才使用旧的 `messageSeqs`；只要任一选中项是 `origin`，就使用 `inputRefs` 并保留全部选中引用。不存在时继续使用 `messageSeqs`。不要把空的 `messageSeqs` 当作标题缺失。
3. 对每个 `inputRefs` 项按 `kind` 分支：`message` 引用以 `messageSeq` 标识直接真人 `user/message`；`origin` 引用以 `originalInboxSeq`、`messageId`、`claimSeq` 与 `admittedSeq` 标识被 claim 的 occurrence 与被准入的改写。另行检查 `source.kind`：`user` 是手动 pin；`fallback` 与 `provider` 是自动标题。
4. 不要把包含任一 required 事件的会话降级给旧 harness；旧 reader 会拒绝该会话。无需删除或转换数据，也无需提升 header 版本。
5. 用升级后的 harness 打开会话，读取 `get()` 或 `currentTitle.inputRefs`（或持久事件的 `inputRefs`）确认迁移生效。
