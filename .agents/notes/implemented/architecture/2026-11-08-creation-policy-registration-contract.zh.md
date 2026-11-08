# Agent Note: 将创建策略协调保留在 Host 内部

Status: implemented

[English](2026-11-08-creation-policy-registration-contract.md) | 中文

## 问题

拥有会话模式的插件（例如 Nodes）需要原生 Session Controller 保持唯一创建者，同时由插件提供该模式的持久申请和按次准备步骤。最初实现新增了 `SessionCreationPolicyRegistry`，公开 `register`、`get`、`claim`、`isLive`、`inspect`、`resolveSource` 与 `coordinate`，并从包索引导出全部协调类型。

包外只有 `register` 有生产调用方（Nodes）；诊断探针读取 `get`；`claim`、`isLive`、`inspect`、`resolveSource` 与 `coordinate` 只由 `src/commands.ts` 调用。因此公开方法集描述的是 Controller 自身的创建事务，而不是面向插件的契约；外部调用方可以捕获激活或串行化无关的创建，却不拥有这两项事实。

## 决定

`SessionCreationPolicyRegistry` 是面向插件的账本，公开 `register` 与 `get`。它按提供方命名空间内的 id，为调用方的 effect 寿命保留一个策略，并返回只移除该次注册的 disposer。`get` 保持公开，是因为 Nodes 诊断探针需要读取活动策略对象来重放已知申请。

`commands.ts` 读取由 `creationPolicyRuntime(registry)` 构建的模块内部 `SessionCreationPolicyRuntime`。包索引不导出该 runtime，也不导出它的 `SessionCreationPolicyClaim`、`SessionCreationInspection` 与 `PolicySourceResolution`。runtime 负责认领捕获、激活存活、归属聚合，以及一次创建或复用尝试周围的短串行范围；Controller 仍是唯一创建者。

归属聚合让确定的认领优先于其他策略的不可读回答。只有在没有任何策略认领时 `unknown` 才参与判定：普通意图此时新建 Session，指明策略时也不复用其候选。两个确定认领构成冲突。原生入口应用同一规则：普通候选只有在所有策略都给出确定的非认领回答时才可复用；指明策略只复用它独自确定认领的候选；来源接续解析到登记该来源的策略。

## 备选方案

**保留整个公开账本。** 这是最初实现交付的形态，目前也没有外部调用方误用。但它仍把 Controller 的事务呈现为插件能力，而包规则拒绝只有一个内部调用方的公开方法。

**让 `unknown` 压过确定认领。** 这会在任何无关策略的存储不可读时拒绝所有复用与接续，包括登记插件中尚未取得标识的待定申请。契约区分“该标识不得按普通处理”与“确定认领属于 unknown”：被认领的标识不是普通标识，用无关回答阻断它会把诊断变成 Host 范围的不可用。当前行为改由真实 Controller 用例锁定。

**为协调新增第二个公开服务。** 没有消费者需要它，而且它会制造本次收窄本要移除的 API。

## 测试

`packages/api/session-controller/tests/creation-policy.host.spec.ts` 驱动真实 `SessionCommandController` 与真实账本。用例覆盖：策略随贡献 fiber 一起移除；一个策略认领普通候选而另一个策略不可读；同一分裂下指明策略复用其自己的候选；来源接续解析到认领策略；激活撤回与同 id 重登记；在途去重；有界已结算结果；带已知 id 的准备失败；普通意图丢弃被认领、冲突或不可读的候选。真实组合用例在真实 Workspace registry、持久存储与 JSONL Session 持久化之上启动 Session Controller Remote：贡献 fiber 撤回后以同 id 重挂，仍不会把排队操作交给新激活；在同一持久根上的冷重开同时验证两个方向的复用门禁（普通意图不复用被认领的空白会话，指明策略只复用自己认领的候选）；准备失败报告已存储的实际标识且不会重建会话。

## 结论

包索引只公开注册与参与契约：`SessionCreationPolicy`、`SessionCreationOwnership`、`SessionCreationOperation`、`SessionCreationParticipant`、`SessionCreationPreparation`、`SessionCreationOutcome`、`SessionCreationStage`、`SessionCreationKnowledge`，以及 `register`/`get` 账本。Controller 保留自己的事务。Nodes 继续通过同样两个方法登记与诊断；声明投影保留这些声明。聚合规则未变，现已写入包 README，并由真实 Controller 用例覆盖。持久格式、会话日志与模型可见文本均未改变。
