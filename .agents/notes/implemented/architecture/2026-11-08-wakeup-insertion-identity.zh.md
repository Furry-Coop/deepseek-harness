# Agent Note: 按本次插入的 occurrence 兑现锁存唤醒

Status: implemented

[English](2026-11-08-wakeup-insertion-identity.md) | 中文

## 问题

循环会锁存无法立即投递的唤醒：维护任务期间到达的唤醒发送，或在轮次 abort 信号已置位、驱动器尚未收敛时落地的唤醒。该锁存此前的形式是一个布尔值，收敛时与 `inbox.hasPending` 配对判断，于是任何待处理输入都被当作唤醒仍欠一轮的证据。调用方可以发送 followup 再将其移除，循环仍会为留下的被动输入开启一轮；以同一消息标识被动重插也会通过判断。释放期间同一条规则会在正在拆除的会话上启动轮次。

初始化还存在相关缺口。Factory 以 `disposed` 取消、同时保留队列来终止失败的初始化，但 abort 信号保留首个原因：当用户普通停止先到达时，维护信号的原因仍是 `user`，锁存的主动唤醒于是在回滚期间派发了一轮，消费掉失败契约承诺保留的排队输入。

## 决策

锁存的唤醒是唤醒插入本次产生的那条确切待处理 occurrence。`ReactLoopInbox.insert()` 通过同一次持久 splice 提交，并返回本次 splice 自己的投影消息——即 `event.data.inserted` 中的那条消息——若同步观察者在 append 返回前将其移除则返回 `undefined`。`Session.append` 会分离 payload，因此移除再重插同一调用方对象的回调产生的是另一条 occurrence；身份判断是对实际投影的引用比较。running 与 maintenance 阶段各自持有一个 occurrence 的 `Set`，收敛时只有 `holdsOccurrence()` 仍能找到待处理项才兑现唤醒。真 idle 的唤醒仍无条件启动驱动器：即使同步观察者在插入期间撤下消息，其轮次边界仍是这次唤醒投递的记录。

`Agent.cancel()` 在运行任何回调之前捕获当前活动与两份待处理通道的一份快照，丢弃本次取消拥有的唤醒，只中止捕获到的活动，再按身份只删除捕获到的 occurrence。因此由 abort 监听器或 discarded 通知投递的输入继续待处理，并唤醒下一次活动。agent 处于 idle 时，清除回调投递的唤醒会延迟到两条通道的捕获项都被移除之后，并且仅在其自身 occurrence 仍待处理时重放。

释放请求独立于 abort 原因记录在该活动上。`runMaintenance()` 只在活动未被释放时兑现其锁存唤醒，因此 Factory 失败路径（`agent.cancel({ kind: 'disposed' }, { keepInbox: true })`）保留队列，不启动轮次、领取或请求；回滚随后在待处理 splice 完整的情况下释放写句柄。发布成功则保留队列并兑现锁存；普通 `runMaintenance()` 任务在拒绝后仍会兑现之后真实到达的唤醒。

## 考虑过的替代方案

**保留布尔值并比较消息 id。** 消息 id 是调用方的标识，而待处理输入契约允许移除后重插同一标识。被移除的唤醒之后再以同一 id 被动重插，仍会通过 id 检查。

**新增持久唤醒记录。** 唤醒是进程内的投递记账。持久 inbox 投影已经持有每条待处理 occurrence，新增事件只会多出一份没有冷恢复消费方的表示。

**让最后一个 abort 原因胜出。** `turn/end` 记录首个原因，传输层也依赖调用方的对象继续作为信号原因。改变哪个原因胜出会改写已提交的轮次结束记录。

**在任务失败时一律抑制维护唤醒兑现。** 普通 `runMaintenance()` 任务在取消之后锁存唤醒是合法的，且必须兑现；只有释放才抑制重放。

**要求存在存活的注册项。** 初始化在等待 `agent/created` 之前就进入 AgentRegistry，因此失败的生命周期在其维护任务结算时仍在注册表中；注册表存在性无法区分初始化失败。

## 测试

`packages/core/agent-loop/tests/wakeup-identity.spec.ts` 通过 abort 监听器投递驱动原生循环：被移除的唤醒只剩被动 next-step 输入、同一标识的被动重插、维护任务后锁存又被移除的 steer 唤醒、多个被移除的唤醒、之后真实到达的唤醒、在自身插入期间被撤下的 occurrence，以及释放。`packages/core/agent-loop/tests/initialization-wake.spec.ts` 在真实 JSONL 持久化上挂起 `agent/created`，发送真实 followup，以 `keepInbox` 停止，再让监听器拒绝：不记录轮次、领取或请求，写句柄释放后仍可读到已存储的待处理 splice，下次冷恢复读到该队列且不派发，直到之后的 followup 按顺序运行它。其配套用例表明监听器正常返回时会发布并随后兑现锁存唤醒。`packages/core/agent-loop/tests/cancel.spec.ts` 覆盖取消捕获：abort 监听器的输入得以保留，捕获项按身份原地删除，idle 清除回调的唤醒等待两条通道清空、并在其 occurrence 被移除时撤回，删除失败不启动任何轮次，释放同样不启动。

## 影响

锁存的开销是一条投影引用的 `Set` 与每次清除式取消的一份快照。没有任何新增持久内容：`agent/inbox/spliced` 事件、持久 inbox 投影以及 TypeScript 与 Python SDK 投影都不变，`Inbox` 保留公开的 `clear()` 与 splice 返回值。返回 occurrence 的 insert 与捕获辅助方法留在包内部的 `ReactLoopInbox` 上。取消现在先中止捕获到的活动，再移除该活动的输入，因此 abort 监听器的输入被归类为唤醒下一次活动，而不会加入被取消的活动；一份快照原地删除捕获项，保持了周围队列顺序。插入被撤下的唤醒不会再开轮次；需要轮次边界的调用方必须在 idle 时发送。初始化失败到此为止并保留队列，留存输入保持被动，直到之后的真实唤醒或冷恢复。
