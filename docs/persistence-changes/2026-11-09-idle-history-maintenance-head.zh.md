---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-09-idle-history-maintenance-head

[English](2026-11-09-idle-history-maintenance-head.md) | 中文

## 概述

为持久 `system/message` 负载新增空闲历史维护替代：在任何轮次之外提交的受保护 system 头，携带 `maintenance: true` 且没有 `turn` 或 `step`。轮次提交替代保持不变。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-09-idle-history-maintenance-head
baseline: false
changes:
  - root: "event:system/message"
    previous: "2026-09-16-session-format-v4"
    after: "d7512d48304c76194949f420847322fae40a8f520bfc897ec597686dc8ea7d08"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

两种替代互斥，标记是必需的判别字段而不是可选特性：一条记录要么给出正数 `turn` 与 `step`，要么给出 `maintenance: true` 且不含这两个坐标。新的替代只由 `Agent.maintainIdleHistory()` 在 Agent 真正空闲且 surface 为空时作为节点 0 产出；普通轮次循环继续写已发布形态。因此缺少该标记时旧行为完整保留，已接受的历史记录都不含它。不认识该替代的读者既不会把它当成轮次提示，也不会把它当作可恢复残尾丢弃：已发布的 V4 codec 在物理准入阶段、物理框架与来源范围解码及断尾恢复之前就拒绝该行，已发布的 restorer 也在关系校验、采纳与派生之前拒绝同一事件（以 rc.1 reader 实测，完整与断尾的维护头代际都在零请求、原字节不变的情况下被拒绝）。认识该替代的读者精确保留历史轮次提交含义：头仍投影为一条 system 消息，后续轮次通过普通的逐节点头替换协调它，派生历史、恢复、fork 与查询视图读取同一 surface。没有该标记时无法被读成 `system/message`，因此不会被误认成已发布形态。

<a id="verification"></a>
## 验证

真实写入与读取，无密钥：真实 AgentLoop 加 JSONL 持久化在空闲阶段记录头和消息，随后真实轮次与冷恢复按请求顺序装配已记录历史且只有一个 system 节点；同一组用例覆盖首节点不是受保护头的非空 surface、同身份的幂等重试、内容不同与非无损 JSON 的冲突、头发布时取消且已提交头作为恢复状态、注入的写入与 fsync 窗口失败（检查点失败保留已提交位置、重试不追加、回滚后存储代际逐字节相同、冷恢复恰好读到一份）、空渲染提示，以及带残尾的断尾帧。物理与恢复门禁拒绝处于开启步骤内、位于其它 surface 节点之后、使用替换操作、处于开启 compaction 内、带 `turn` 或 `step` 坐标、以及标记为 false 或非布尔的维护头，只接受作为空 surface 追加头的维护头，包括没有 `parentSession` 的 seeded fork 头。pnpm run typecheck 通过；pnpm run build 及持久、会话格式、文档与定向 agent-loop／session 门禁通过。

<a id="dev-note"></a>
## 开发备注

无。
