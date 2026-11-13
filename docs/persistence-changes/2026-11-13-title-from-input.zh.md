---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-13-title-from-input

[English](2026-11-13-title-from-input.md) | 中文

## 概述

新增两个仅日志的 V4 required 事件：session/title-from-input 与 session/title-llm-request-from-input；当标题来自被 claim 的 human Inbox occurrence 且准入消息替换了 human source kind 时使用。事件携带服务冻结的精确输入引用，不用有效消息 seq 冒充 human user/message seq。from-input 审计记录恰好携带一条 user 消息，以单个 text 块保存提供方输入。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

既有记录继续有效，普通 session/title 与 session/title-llm-request 的写入与读取保持不变。新类型不带 ignorable 标记：已发布旧 reader 在读取或写入前以 SessionFormatUnsupportedError 安全拒绝，物理文件保持不变；读写两种访问都由 .check-logs/repair-supervision-20261113/title-input-compatibility.json 记录。新 reader 将新结果折叠为最新标题并保留引用；这些事件不进入 deriveMessages 或模型输入。新 reader 在 adopt 存储日志前，会用同一份日志核对每个冻结引用：direct 引用必须是真人 user/message；origin 引用必须指向一次非取消 claim（确实移除该真人 occurrence）、同一 Turn 内首次进入的 step，以及携带相同请求 correlation 的同 id 准入。临时 fold 用完整 lane 长度（含 producer occurrence）校验 splice 边界和索引位移，但只把真人 occurrence 保留为输入；只有已提交的 splice 才改变 lane。不一致会在 handle 发布、Session 执行或残尾 raw 改写之前以 SessionPersistenceCorruptionError 拒绝，文件字节与 generation 保持不变。不含这两类新事件的日志继续走既有读取路径；没有新增 marker，也不修改旧标题关系校验。from-input 审计记录恰好是一条 user 消息和一个 text 块，与写入方一致。无需提升 header 版本，因为新 discriminator 为 required，旧 reader 会安全拒绝。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/core/agent-loop packages/core/agent packages/api/session-controller packages/session/session-title packages/session/session-title-llm packages/session/session-persistence packages/session/session-persistence-jsonl packages/session/session-title-first-prompt-llm packages/experimental/session-title-all-prompts-llm packages/session-query/session-log-export：2917 个测试通过、12 个跳过（140 个文件），其中含 20 个冷读校验和 18 个 storage-contract 测试。聚焦测试覆盖：全 rewrite 历史写成 session/title-from-input 且原文不进入模型输入；真实 JSONL 文件中的伪造 origin 引用在 read 与 write open 时均以 SessionPersistenceCorruptionError 拒绝，文件字节不变且不产生后继 generation；含 producer 前缀与中间 lane 位移的真实 mixed-producer 双 lane JSONL 日志读回后保留 origin 标题；同 id 但 rpc 关联不同的准入被拒绝；普通与 rewrite 混合历史按准入顺序；preserve 后旧 claim 窗口失效、后续重新 claim 才可准入；已取消 occurrence 无法准入；越过完整 lane 长度仍被拒绝；checkpoint 加 suffix 还原完整 title-input 状态；缺失 checkpoint 行从完整日志重建；以及只含一条消息、一个 text 块的 title-llm-request-from-input 审计记录。真实 AgentLoop 在 pre-step 改写首个真人输入（同 id 与请求 correlation）后，由已记录的 main request header 自动驱动 first-prompt 与 all-prompts 两个官方提供方写出新标题，无需手动 refresh；真实 fork 落盘重开时，admission 前切分没有已准入输入或标题，admission 后切分携带的 origin 标题通过冷读校验。另覆盖重复、逆序与空引用选择，provider 在 dispatch 前篡改 prepared system/input/seqs，以及未知 required 类型仍先以 unsupported 拒绝、不进入 corruption 校验。

<a id="dev-note"></a>
## 开发备注

无。
