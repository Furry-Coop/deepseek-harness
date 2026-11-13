# Agent Note: Protected surface-head maintenance for plugin-owned first writes

Status: implemented

[English](2026-11-13-protected-surface-head-maintenance.md) | 中文

## Problem

拥有持久 surface 消息的插件（例如工作桌卡片块）可能只会在 `agent/pre-step` 才知道自己要做首次写入。循环自己的受保护 system 头在步骤内部更晚才提交，于是插件的 `user/message` 先落在 surface 上。实时追加接受该顺序；已发布的 V4 读取器随后以 `system/message requires a protected first surface head` 拒绝该日志，因此该会话的每次冷读都会失败，包括侧卡执行的轮次定位。记录到的失败正是 seq 7（插件 `user/message`）、seq 8（`step/start`）、seq 9（`system/message`）这一顺序，产物含 24 个完整帧、47 个事件且没有残尾：原因是生产出的顺序，而不是损坏、分帧或文件权限。

现有 API 无法同时保留插件的 pre-step 物化与首步空批路径。`agent/pre-step` 在 `step/start` 之前运行，监听器在那里无法追加到头之后。`agent/request` 瀑布同样在循环提交头之前运行。把 `step/start` 提到决策之前会为空批或被拒绝的首批开启步骤，而那正是循环必须保留的零步路径。`session/event` 观察只是通知，不是可 await 的追加屏障。`maintainIdleHistory()` 只在真正空闲时可用，并且总会写一条消息。

## Decision

`Agent.maintainSurfaceHead()` 在真正空闲阶段建立或核对受保护 system 头，不写入任何消息。它占用与 `runMaintenance()`、`maintainIdleHistory()` 相同的维护阶段，共用它们的 scoped 装配与渲染、唯一的维护头追加，以及实时与取消复核。头位置来自会话的宿主内部维护准入，该准入同时回答只看头的读取。空 surface 上，该调用提交一条带 `maintenance: true`、没有 turn 或 step 的 `system/message`。本操作最多追加这一个头，绝不重复追加；之后的提示词更新仍遵循现有提示词准入的路由与序列策略，该策略不变。已有头（包括空渲染）绝不替换、重复或移动。持有任何节点却没有受保护 system 头的 surface 会作为 `history-conflict` 被拒绝，因为在那里补头会重排其它写入方的消息。

提交与持久化检查点是两个独立结局，无操作路径也运行同一检查点：头存在本身并不证明它已持久。提交之后的检查点失败、取消或属主被替换，会在 `SurfaceHeadError.head` 中报告已提交位置，而不是声称什么都没写；后续调用核对持久性，不再追加第二个头。持久化检查点是第二个 await 边界，因此无操作路径与首次追加路径都会在它之后再次执行同一活身份与取消校验：否则在检查点监听器里取消会让过期的初始化结算为已确认成功。该操作不开启请求、轮次或步骤，也不写正式历史消息。

调用方必须自己拥有可 await 的空闲点，例如它的会话登记准备，并在该点非空闲时失败关闭。在首个 `agent/pre-step` 里等待空闲等于等待自身，因此该操作报告 `not-idle`，而不是推迟到之后的窗口。

## Producer of the maintenance alternative

为空闲历史维护引入的 `system/message` 变体新增第二个生产者：`maintainSurfaceHead()`。两个生产者都只在真正空闲时运行，且只作为空 surface 的第 0 号节点；普通轮次循环仍写轮次提交形态。持久负载、其判别字段（`maintenance: true` 且没有 `turn` 或 `step`）与已发布读取器都不变，因此这是同版本的生成者变更，而不是新的表示，该变体对应的既有确认继续描述该类型。只建头的生产者不写 user 消息，因此不会出现新的记录种类或判别字段。

## Alternatives considered

**把 `step/start` 提到 `agent/pre-step` 之前，或从 pre-step 瀑布提交头。** 已否决：轮次提交的 `system/message` 要求步骤已开启，而在决策前开启会为空批或被拒绝的首批准入步骤，破坏零步路径。

**把插件的物理写入推迟到 `agent/request` 瀑布。** 已否决：该瀑布同样在循环提交头之前运行，追加仍会早于头；把请求门禁移到步骤准入之后会消费掉被拒绝的批次，并失去“拒绝但保留输入”的约定。

**让普通循环在轮次开始或会话创建时提交维护头。** 已否决：该变体只在真正空闲时作为第 0 号节点产生，让每个会话的首轮都写它会改变已发布的生成者约定与每个日志的形态，而没有任何插件受益。

**接受该顺序并放松读取器。** 已否决：头规则防止替换与压缩遮蔽提示词，放松已发布代际会让本就不可读的日志看起来有效。

**吞掉拒绝后继续，或从分离的空闲钩子重试。** 已否决：继续正好写出不可读日志，分离重试也无法保证首轮安全。

**用合成消息复用 `maintainIdleHistory()`。** 已否决：那会伪造调用方从未写过的正式历史。

## Verification

`packages/core/agent-loop/tests/surface-head.spec.ts` 驱动真实 AgentLoop、真实 scoped 装配与 JSONL 后端。它固定了空 surface 头（维护标记、没有 turn 或 step、一次 flush、没有轮次／步骤／请求／inbox 领取）、插件 pre-step 追加落在头之后并冷重开已提交代际、仍会 flush 的已有头无操作、无操作路径与首次追加路径上的检查点失败及其已提交位置与幂等重试、由头发布引发的取消保留已提交头、两条路径上在持久化检查点内部发生的取消都会报告已核对或已提交的头而不是结算成功、非空无头 surface 与装配期间的并发写入方被拒绝、轮次中与另一维护任务中的 `not-idle`、装配期间取消，以及 dispose 之后陈旧 agent 的拒绝。公开 teardown 会排空在途维护，因此被替换的属主无法与检查点交错；检查点之后的门控与追加前门控是同一个活身份校验。`packages/core/agent-loop/tests/idle-history.spec.ts` 的既有用例保持不变，说明共用辅助未改变空闲历史。已发布读取器对原始顺序的拒绝由 `packages/session/session-persistence-jsonl/tests/native-developer-admission.spec.ts` 固定。仓库规则要求带用户可见输出的循环变更同时有免密钥录制会话快照与两个 SDK 的期望输出；本能力的这些期望归本注记之外的快照／SDK 范围维护，上面的 Host 单测与 JSONL 冷读证据不能替代它们。

## Consequences

代价是一个可选公共方法、同一持久负载的第二个生产者，以及调用方必须拥有可 await 的空闲点。换来的是：插件的首次 surface 写入无需模拟轮次就有合法位置，持久化检查点失败可恢复且不会被重复，而循环的步骤顺序、已发布读取器与持久代际都保持不变。
