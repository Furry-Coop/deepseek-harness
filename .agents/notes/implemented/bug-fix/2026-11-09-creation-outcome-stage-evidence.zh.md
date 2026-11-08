# Agent Note: Creation outcomes come from the Controller stage, not the failure code

Status: implemented

[English](2026-11-09-creation-outcome-stage-evidence.md) | 中文

## 问题

`session.create` 按失败码判定一次失败尝试的创建知识：`agent-preset/*` 被当作可证明的前置拒绝，因此同一 operation 标识仍可重试。由 serial `agent/created` 监听器到达的插件可以抛出任意 Remote 失败，也包括这些业务码。用真实 AgentLoop、Session Controller、Workspace registry 与 JSONL 持久化复现：监听器先选择模型，等待 `sessions.flush` 返回 true，再抛出 `agent-preset/not-found`。同一 operationId 投递两次会铸出两个 Session，独立 Host 能打开两个日志并各读到一条 `model/selection`。该清单还把 Controller 在任何 Factory 调用之前抛出的拒绝，与插件在之后可抛出的同类业务码混在一起。

## 决策

Agent Controller 自己记录尝试阶段。`ApiSessionCreationFailed` 包裹 `createSession` 的每次失败，携带 `enteredFactory`——在 `ctx.agents.create` 或 `ctx.agents.resume` 之前立即置位且不再清除——以及该调用返回后的实际标识。`commands.ts` 只从该记录读取创建知识：未进入 Factory 为 `none`，已返回标识为 `known`，其余为 `unknown`。`commands.ts` 自己抛出的失败保持固定读法：前置校验为 `none`，`session/workspace-attach-failed` 与 `session/policy-prepare-failed` 为携带真实标识的 `known`。

操作缓存只在已证明的 `none` 时删除标识；`unknown` 与 `known` 条目保持已结算并重放，不再进入 Factory。可能已写入 Session 的 Factory 永不重试。

Remote wire 只在已证明的前置拒绝时保留业务码。`agent-preset/not-found` 与 `agent-preset/invalid` 此时在 details 中携带 Session Controller 设置的 `creation: 'none'`；preset registry 自己从不设置它，缺失即结果不明。Factory 调用内部抛出的失败以 `gateway/internal` 交付，业务码与消息保留在诊断文本中；Factory 返回之后的失败同样如此，而策略参与方仍收到实际标识。Host 不回滚已写入的事件；unknown 结局只说明 Session 可能存在。已声明但激活失败的 preset 本身并不构成解析拒绝：注册表把它报告为 `broken` 并照常返回标识。因此创建路径在解析组合时读取该诊断，并在那里以同样的 `agent-preset/invalid` 与 `creation: 'none'` 拒绝；Factory 内部的挂载仍然保留，用于处理解析之后才变得不可用的 preset，其结局仍为 unknown。

## 考虑过的替代方案

**保留业务码清单，只把 `agent-preset/*` 限制在前置阶段。** Factory 内部抛出的值由插件控制，同一业务码在那里与 Controller 自己的拒绝无法区分。

**把所有失败都视为 unknown。** 这会放弃真正缺失 preset 的安全重试，以及调用方用于回退的 preset 提示。

**在每次失败上就地携带 `creation: 'none'`。** 从 Factory 抛出的插件可以伪造该字段。只有 Controller 的带外阶段记录可信。

**为 Factory 之后的失败新增专用 wire 码。** 当前没有消费者读取它；通用失败消息中保留业务码已足以承载诊断，且不增加新词汇。

**让每个 `composeAgent` 调用方都拒绝损坏声明。** Fork 与可信冷恢复也挂载同样的声明，但只有创建路径把 preset 拒绝转成创建知识；在那里拒绝会改变它们交付的失败，却没有任何消费者。

## 测试

`packages/api/session-controller/tests/creation-policy.host.spec.ts` 用生产 AgentLoop、真实 Workspace registry 与 JSONL 持久化驱动。一个用例复现刷盘后拒绝、重放操作，并在 Host 结束后读到唯一 Session；另一个用例证明前置 preset 拒绝仍可重试且携带 `creation: 'none'`。一个子行无法激活的已声明 preset 在 Factory 之前被拒绝，`reason` 保留其确切诊断，接着同一 operation 在不创建 Session 的情况下按默认重试；解析之后被撤回的 preset 仍是 unknown 的 Factory 结局。单元用例固定原始错误、非 Error 拒绝、`gateway/internal` 与伪造 `agent-preset/not-found` 这几种 Factory 失败的通用映射，Factory 返回后的已知标识，以及未分类失败的默认读法。两个改动的源文件保持逐文件 100% v8 覆盖。

## 影响

在 Controller 解析之后才变得不可用的 preset 以 `gateway/internal` 到达调用方，业务码保留在消息中，不再是具体业务码；解析时已被标记为损坏的声明属于已证明的前置拒绝，`session.create` 保留 `agent-preset/invalid` 与 `creation: 'none'`，客户端的原生 blank 恢复因此可以回退到默认 preset。这是不声称无法证明的前置拒绝的代价。真正的前置拒绝保留业务码并获得标记，因此只读业务码的客户端仍会重试已证明安全的失败。拒绝前已写入的持久 Session 留在磁盘上且不加入任何 Workspace；Host 报告 unknown 结局，而不承诺回滚。
