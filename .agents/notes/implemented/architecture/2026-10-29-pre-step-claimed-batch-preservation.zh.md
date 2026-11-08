# Agent Note: 在阻断性拒绝后保留 pre-step 已领取批次

Status: implemented

[English](2026-10-29-pre-step-claimed-batch-preservation.md) | 中文

## 问题

`agent/pre-step` 收到的是循环已经从 inbox 领取的批次。拒绝的监听器此前只能消费该批次：这些消息既不进入步骤，也不回到 inbox，轮次以 `blocked` 关闭。插件在自己的准入检查失败后需要推迟轮次时——例如首次上下文组装还无法形成请求——必须把用户的问题留给之后的尝试。用 `inject` 或 `splice` 逐条重新注入会把它们追加到 next-step 通道末尾，排在失败的 pre-step 期间到达的 steer 或上下文输入之后，也无法把原本拥有该轮次的提示词表达为一个批次。若插件还希望取消优先，就必须与循环自己的取消处理竞速，而后者可能在清空后让输入复活。

循环拥有领取，因为它通过持久 inbox 投影移除消息，并拥有轮次、步骤与取消生命周期（[agent-loop README](../../../../packages/core/agent-loop/README.zh.md)）。插件无法只凭公开 inbox 重建这份所有权，除非复制 FIFO 并与取消路径竞速。

## 决定

拒绝决定可以设置 `preserveClaimed: true`。循环在领取时快照确切的已领取批次，独立于 waterfall payload；拒绝决定返回时恢复该快照。恢复是对 `next-step` 位置 0 的一次 `agent/inbox/spliced` 插入，因此批次保持原有顺序，并排在 pre-step 期间插入的输入之前。轮次仍以 `blocked` 结束：驱动器不重跑，拒绝时也不记录请求、步骤或用户消息。只有之后的新唤醒打开轮次并再次领取 pending-step 通道时，被暂存的批次才被消费。

取消决定结果。若轮次信号已 abort，或同步观察者在恢复期间取消，批次不会被保留，已恢复的出现项会像其他取消输入一样被清除。普通拒绝保持原有消费语义，监听器抛错时也会在报告驱动器错误前消费其领取内容。被保留的批次就是普通待处理输入：持久 `inbox` 投影从同一条 splice 事件折叠它，下一次领取会再次为相同消息发出 `agent/inbox/claimed`。

## 考虑过的替代方案

**由插件重新注入。** pre-step 监听器可以逐条调用 `inject`。这会把消息追加到领取之后到达的输入之后，把唤醒消息从 next-turn 提示词变成 next-step 上下文，并把取消与重复身份处理留给插件。循环的领取是仍然知道确切批次及其顺序的唯一位置。

**把领取保存在插件自有队列。** 插件中的第二个队列会复制 inbox FIFO，且对循环的取消截点没有权威。循环仍然消费了原始出现项，因此后续清空无法把副本与新输入区分开。

**新增会话事件。** 现有 `agent/inbox/spliced` fold 已经重建待处理输入并校验重复 id 与坐标。恢复就是普通插入，新增事件只会为同一状态增加第二份表示，而且当前没有消费方。

**返回 enter 决定并依赖下一步。** 进入步骤会提交用户消息并可能发送模型请求。blocked 轮次不得产生请求，而正是下一个轮次边界让被恢复的提示词成为唤醒输入。

## 测试

`packages/core/agent-loop/tests/interception.spec.ts` 通过真实循环与 waterfall 覆盖该约定：监听器在拒绝前反转并追加 payload；多消息领取排在暂存输入之前返回；被拒绝的轮次不记录用户消息、步骤、assistant 事件或模型请求；持久 inbox 投影折叠出相同顺序；已经由 gate 放回队列的领取不会被重复恢复；恢复期间的同步观察者取消不会留下复活输入；用户取消、所有者释放与 `keepInbox` 下的 enter 各自消费领取内容而不恢复它。`packages/core/agent-loop/tests/resume.spec.ts` 通过 JSONL 后端写入恢复操作，把已存储事件折叠回相同顺序，并证明只有下一次唤醒才记录该批次并按顺序请求它。没有新增或改动 keyless 快照：当前没有随包 profile 选择 `preserveClaimed`，记录型 transcript 与 TypeScript、Python SDK 投影保持现有期望输出。

## 后果

循环在 pre-step 期间保留一个待处理领取槽位。决定被接纳、拒绝或抛错时该槽位都会清空，因此不会泄漏到后续步骤。`PreStepDecision` 增加一个可选字段；enter 与普通拒绝路径保持不变。插件拥有是否保留的业务决定，循环拥有顺序、身份、原子恢复、取消优先以及不主动唤醒。持久 `inbox` 投影仍是待处理输入的唯一来源，对于不选择启用的插件，模型可见文本与请求均不改变。
