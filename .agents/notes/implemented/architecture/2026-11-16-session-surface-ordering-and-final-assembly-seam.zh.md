# Agent Note: session surface ordering and the final assembly seam

Status: implemented

[English](2026-11-16-session-surface-ordering-and-final-assembly-seam.md) | 中文

## Problem

拥有模型可见材料的插件需要把它们排成固定顺序——例如系统提示词、已选节点、项目指令、技能目录、可选任务块以及其余临时材料。此前缺两项能力。

第一，没有任何扩展点在「本步自身消息准入之后、请求冻结之前」运行。`agent/pre-step` 在 `step/start` 之前触发，此时系统提示词、本步用户批次和刷新后的运行时上下文快照都还没提交；`agent/request` 触发更早，在 `prepareConfig` 内部，且不能修改消息。`session/event` 观察者完全不能追加：日志拒绝重入追加，以保证发布原子性。循环自身的准入顺序不是插件「写对时机」就能影响的。

第二，surface 没有持久方式改变已存在节点的顺序。`{ op: 'replace', startSeq, endSeq }` 把新节点放到被遮蔽区间原来的位置，因此「移动节点」只能录一份副本——丢失身份与字节——而重排一轮工具交换还可能拆散配对。派生历史按构造就是 seq 单调的；此前只有压缩的删除是位置性的。

## Decision

宿主提供两个受约束接点，不持有任何业务状态。

**`surface/order` 是一次完整置换的持久记录。** `Session` 通过 `session.append('surface/order', { nodes })` 追加 `{ nodes: SessionSeq[] }`。该列表必须恰好置换当前 surface 的全部节点——不得新增、遗漏或重复——必须保持当前首节点仍在首位（surface 节点 0 是受保护头），并且必须真的改变顺序。折叠只重写节点顺序：已记录消息、其身份与日志都不变，后续追加落在置换后的尾部，后续 replace 按当时生效的顺序解析端点。事件同时推进 `replaceGeneration`（按 seq 定位的索引缓存重建）与 `contentGeneration`（派生历史重建，且下一次请求记录新 series）。重放会应用同一重写，因此在线派生与冷重开一致。该事件是必需-on-read：忽略它的读者会装配出不同的请求，所以拒绝该日志才是安全解释。

**`agent/history-assembling` 是单次 attempt 的最终快照点。** 它是 waterfall，每次 attempt 触发一次，位置在本步系统提示词提交、用户批次与刷新后的运行时上下文快照都提交之后，且在循环记录 `request/header`、`request/context`、工具变更记录与冻结数组之前。payload 为 `{ agent, turn, step, signal }`；其延续 `next()` 同步执行内建构建并返回已冻结请求。监听器可以持有自己的串行 writer、await 持久工作，然后仍在持有期间调用 `next()`，因此排队中的更新无法插入它的提交与快照之间。监听器必须恰好调用一次 `next()` 并原样返回该请求；循环拒绝其他返回值而不会派发未冻结的请求，并在延续返回后再次检查取消，使「清理阶段被取消」的回合不会触达 provider。

**格式校验重放该记录。** V4 格式包的 `Relationships` 按同一套规则折叠 `surface/order`，再解释后续任何 replace，因为覆盖范围是按当时生效的顺序定义的。覆盖要求本身不变：每个被遮蔽节点仍必须被引用。

## Alternatives considered

**复用 `agent/pre-step` 或 `agent/request`。** 两者都在「必须被排列的材料存在之前」触发。那里的监听器只能猜测最终准入顺序，而请求要在更晚才冻结。

**用现有 replace 表达排序。** `replace` 不录副本就无法移动节点，会改变身份、复制字节，还可能让工具配对失去归属。需求是重排「已经记录的东西」。

**不记录地重排。** 只在内存里排序能满足当前请求，但违反「模型可见即可从日志重建」，且冷重开会发出与记录不同的请求。

**让插件自己在正确时机追加。** 系统提示词提交、用户批次与刷新后的运行时上下文快照都由循环掌控；插件无法靠「更早写入」把材料放到它们之间。

**返回空值的 serial 监听器。** 先 await serial 监听器再构建请求，会留下一个窗口：监听器自己排队的 writer 工作在它返回之后、快照之前运行。把构建做成延续即可关闭该窗口：快照发生在调用方串行工作内部。

**把 `surface/order` 标为 ignorable。** 旧读者会保留 seq 顺序，装配出写入方从未发送的转录。拒绝才是正确的失败方式，所以该事件必需-on-read。

## Consequences

比本次变更更旧的读者会拒绝含 `surface/order` 的日志，而不是静默不排序；既有判别信息已能防止不安全解释，因此 Session 格式版本仍为 V4。位置性消费者必须跟随已记录顺序：token meter 调整其计价镜像，compaction 的 seq→位置缓存因 `replaceGeneration` 前移而重建。重排会改变请求前缀，因此会开启新的消息 series——这是移动较早材料的诚实代价。

接点保持通用：不携带分区、任务、版本或环境概念，也不改写或删除消息。移出仍由插件自己的 `replace` 负责，排序保持纯位置记录，因此宿主永远不需要知道各分区的语义。

## Testing

`packages/core/session/tests/surface-order.spec.ts` 覆盖置换、重放、后续追加与 replace，以及全部拒绝路径。`packages/core/agent-loop/tests/history-assembly.spec.ts` 覆盖延续、按 attempt 重试、工具续步、拒绝非冻结或未变更的返回值，以及两个取消窗口。`history-assembly-persistence.spec.ts` 与 `packages/session/session-persistence-jsonl/tests/surface-order-restore.spec.ts` 通过真实 JSONL 后端写入并冷重开。`packages/session/session-format-v3-to-v4/tests/relationships.spec.ts` 固定校验器规则，包括「省略被遮蔽节点的 replace 仍被拒绝」。`snapshots/session/history-assembly-order/` 通过 shipped profile 与受控 scenario 插件录制该排序，并 keyless 回放。
