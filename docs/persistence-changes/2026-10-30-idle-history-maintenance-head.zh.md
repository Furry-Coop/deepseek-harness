---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-30-idle-history-maintenance-head

[English](2026-10-30-idle-history-maintenance-head.md) | 中文

## 概述

为 `system/message` 增加第二种显式载荷表示，用于任意 turn 之外提交的提示词：`{ maintenance: true, message }`，不带 `turn` 与 `step`。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-30-idle-history-maintenance-head
baseline: false
changes:
  - root: "event:system/message"
    previous: "2026-09-16-session-format-v4"
    after: "d7512d48304c76194949f420847322fae40a8f520bfc897ec597686dc8ea7d08"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录语义不变且仍然有效：按 turn 提交的提示词仍携带正的 `turn` 与 `step`、不带标记，两种表示在写入方与读取方都互斥。本构建的读取方接受两者，要求维护头在两个 turn 之间、开放 step 与任何开放压缩之外建立 surface 第 0 号节点，并拒绝把标记与坐标混用的载荷。早于该表示的已发布读取方会在其 V4 编解码的早期字段准入阶段拒绝该行（物理行校验与产物恢复器），发生在任何写入、变更或尾部修复之前，因此含维护头的已存生成无法被该旧构建重新打开。在当前 writer 自己产物上观察到的拒绝正是这种编解码层拒绝。更早的候选行在持久化层的证据——由 SessionFormatError 引起的 SessionPersistenceCorruptionError、拿不到 writer、文件 hash 不变，覆盖 clean 与撕裂前缀的读和写尝试——是用固定后端测得的；open 路径组合的正是同一套 V4 编解码准入，因此预期那里同样拒绝，但未在当前文件上重跑。这两者都不是不支持版本或可忽略跳过：新增表示对旧读取方是明确拒绝的必需特性，而不是静默丢失数据。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/session/session-format-v3-to-v4/tests packages/core/session/tests/system-message-maintenance.spec.ts packages/core/agent-loop/tests/idle-history.spec.ts：434 个测试通过，覆盖 V4 行准入与关系拒绝、append/seed 形状拒绝，以及通过已安装 catalog 的 JSONL v4 关闭重开。另有一个探针把固定提交的 V4 发布源码直接对着新 writer 的真实产物运行：写入路径、严格读取路径、撕裂行之后的恢复读取路径与产物关系入口都拒绝该产物，而已安装读取方接受同一份字节，文件 hash 不变。

<a id="dev-note"></a>
## 开发备注

无。
