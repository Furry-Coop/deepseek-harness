---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-08-inbox-cancel-cause

[English](2026-11-08-inbox-cancel-cause.md) | 中文

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
id: 2026-11-08-inbox-cancel-cause
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "52a43832678a8f67acd18e84481ee23a29744f9040f73275fb4f2d8c5fa1f283"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录仍然有效：两个成员都是可选的，不认识它们的读取方会把它们作为不透明事件数据保留并忽略。生产者只在 `Agent.cancel()` 记录生命周期取消时写入；普通删除、替换、插入与领取保持原有字段不变。`cause` 使冷读取能区分正常 Agent 销毁（`disposed`）与所有非 dispose 的取消（`user`），不依赖实时状态；`user` 表示非 dispose 的取消，不代表真人点击。`entrySeq` 是取消进入时、任何 abort 监听器或 clear 通知运行前捕获的会话日志长度；在该截点处或之后插入的待处理项属于取消未针对的后续输入，即使取消自身的 splice 记录更晚。读取方以 `entrySeq` 而不是 splice 自身序号作为截点。不是生命周期取消的变更会省略这两个成员，本变更之前写入的记录同样省略：缺失是未知的历史表示，不能作为未取消的证据；没有 `entrySeq` 时无法重建精确的入口截点。带 `keepInbox` 的取消不写 splice。空队列的用户取消写一条不删除任何内容的意图 splice，因此 fold 与派生历史不变。

<a id="verification"></a>
## 验证

无密钥的真实 writer/reader 证据：延迟意图在触发事件之后、aborted turn/end 与 detach 之前提交；user、parent、hook 清空写 `user`，销毁写 `disposed`；`keepInbox` 与普通删除保持原有字段；入口截点之后插入的输入继续待处理；意图写入失败后仍记录下一次取消；延迟取消与同栈取消各自记录入口截点，记录自身观察者触发的取消被限制为一条，该记录观察者抛错时被容纳且 settle 与 detach 照常运行，并从 JSONL 读回。对真实早期 writer 产物的冷读取覆盖三种历史字段形态（都缺失、仅 cause、cause 加 `entrySeq`=13）与普通 V4 对照；当前 reader 重建 `later C` 队列且无模型请求；原版 rc.1 session reader（从 rc.1 发布提交还原）接受全部形态，把每个成员作为不透明数据保留且不合成值，并能在其后追加且不重写原前缀。pnpm run build（10 gates）通过；pnpm exec vitest run packages/core/session packages/core/agent packages/core/agent-loop packages/goal 加两项门禁用例（65 文件、1542 通过、6 跳过）、持久与格式包（66 文件、1768 通过、10 跳过）、会话消费方（124 文件、2576 通过、2 跳过）通过。verify-persistence-changes、verify-persistence-catalog、verify-persistence-formats、verify-session-format-catalog、verify-control-write-callers 与文档门禁通过。

<a id="dev-note"></a>
## 开发备注

无。
