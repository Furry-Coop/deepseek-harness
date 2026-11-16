---
kind: upgrade-guide
description: 记录了 surface 重排的会话需要此版本或更新版本才能重开。
---

# 会话 surface 排序是必需的读取前提

[English](guide.md) | 中文

## 变更

会话现在可以把当前 surface 节点的一次完整置换记录为 `surface/order` 事件，`agent/history-assembling` 则是插件在请求冻结前提交此类变更的最终快照点。该事件在读取时是必需的，而非 ignorable：跳过它的读者会装配出与写入方不同的转录。

## 迁移

普通会话、模型与操作者无需处理；从不记录重排的会话不受影响。比本次变更更旧的构建会拒绝打开日志中含 `surface/order` 的会话，并报告未知的必需事件；请改用此版本或更新版本打开，而不是编辑或迁移该日志。负责排列模型可见材料的插件应在 `agent/history-assembling` 监听器里提交 `surface/order`，使用 `session.surface.nodes` 的置换并保持首节点在首位；把材料移出后续请求仍用 `replace`，绝不复制消息，并预期随后的请求会开始新的消息 series。
