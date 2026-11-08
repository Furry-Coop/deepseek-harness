# Agent Note: 用 owner 写入校验让内部 Agent preset 退出用户选择

Status: implemented

[English](2026-10-26-internal-agent-presets.md) | 中文

## 问题

Nodes 运行三个 preset：它们必须能按 id 挂载和恢复，但不能作为用户选择出现——context、extraction 与 indexing 角色会在一种并非通用模式的组合下复制 Session。宿主原先没有这种词汇：preset 只表达公开选择，roster 列出每个声明，`select` 与 `recompose` 接受任何已声明 id，保存的默认值或用户新建／fork 都可以在其上启动 Session，也没有任何地方表示 preset 的内部状态。

第一版实现增加了 `Settings.registerValidator(owner, path, validate)` 这个公开设置接口，让注册表能在写入持久化前拒绝内部 `selectedDefault`，并给 `ConfigEditor.edit` 增加第三个 `validate` 参数。后来一次尝试把校验移到 owner fiber 的 `internal/config` 钩子并删除两者。该钩子作用于该 fiber 的每一次配置解析，包括 Loader 从 profile patch 直接施加的即时更新；因此它会把原本保留取值并回退到部署默认值的重载变成拒绝。没有公开钩子能辨认配置写入事务，所以校验应留在更窄的写入边界。

## 决定

`PresetDefinition.userSelectable`（省略即可选择）是内部状态的唯一声明。注册表在执行器处持有原生门禁：`remoteExportList` 把内部 preset 从用户 roster 中省略；`select` 与 `recompose` 拒绝它；`retain` 在省略身份和用户路径上拒绝它；保存的 `selectedDefault` 指向它时回退到部署 `default`；`register` 拒绝把内部 preset 作为部署默认值。SessionController 在用户新建或复用 Session 以及 fork 时应用同一检查，冷恢复组合时不检查。`resolve`、`readDocument`、`mount`、`acquireScope` 与冷恢复仍可按 id 访问该 preset。

注册表在可选的 `settings` 子级内用 `Settings.registerValidator(ctx, ['selectedDefault'], ...)` 注册校验。`ConfigEditor.edit` 在写锁内通过 `fiber.resolveConfig` 恰好解析一次候选配置（执行 fiber 的配置钩子与 schema），再把解析结果和刚检查过活跃状态的 fiber 一起交给 owner 校验。因此该校验与 `update`、`replace`、`mutate` 处于同一接受路径：`!!js` 表达式与 schema 校验已完成、profile patch 尚未持久化。校验器读取 Volatile 引用背后的值，规范化后的 `selectedDefault` 引用无法藏住内部字符串。注册是 owner fiber 的 effect，重载会重新注册，卸载会移除。Settings 之外的直接即时配置更新不是写入：它保留提交的值，`defaultId` 只警告一次并回退到部署 `default`；写入之后才注册的定义也会在使用时重新检查。

## 考虑过的替代方案

**使用 owner 的 `internal/config` 钩子。** 它复用了配置路径已经在运行的钩子，也能省掉通用设置接口。但该钩子观察的是 fiber 的每一次解析，而不是 `ConfigEditor.edit` 内的 Settings 事务；于是保留原有回退行为的直接即时更新变成了被拒绝的重载。钩子无法指出写入边界，也就无法表达这条规则。

**在 Nodes 中隐藏内部 preset。** roster、新建、切换、默认值与 fork 的执行器都在宿主中；插件侧的列表过滤会被直接 Remote 调用绕过，也无法保护保存的默认值。

**把内部 preset 当成访问边界。** 它不是：可信插件可按 id 挂载，内部角色和冷恢复依赖这一点。该标记只约束用户选择。

## 测试

`packages/settings/settings/tests/configuration.spec.ts` 覆盖 owner 接口本身：被拒绝的字段不改变文件、值与修订号；校验看到的是 Volatile 引用背后已解析的 `!!js` 值；写入回调收到的是实际检查过活跃状态的 fiber。`packages/preset/agent-preset-registry/tests/settings-integration.spec.ts` 通过真实的 Settings 服务、ConfigEditor 与 profile 文件驱动 update、replace、mutate，包括常量 `!!js` 表达式；可选择的表达式写入成功，内部表达式则不改变修订号、值、有效默认值与文件。它还分别覆盖两个入口：直接 Loader 更新保留内部值并回退，同一值经 Settings 则被拒绝；HMR profile 重载后仍保留下一次 Settings 写入的门禁；手工改写的内部保存默认值启动并回退；注册表 fiber 重载后重新注册门禁；写入后可选择的保存默认值在定义变为内部后回退。`packages/preset/agent-preset-registry/tests/registry.spec.ts` 覆盖 roster、select 与 recompose 拒绝、按 id 可信挂载与冷读租约、直接即时更新的回退、部署默认值拒绝，以及保留代际的竞态。`packages/api/session-controller/tests/session-presets.host.spec.ts` 与 `commands-create-fork.host.spec.ts` 覆盖用户新建与 fork 拒绝。`packages/preset/agent-preset/tests/config.spec.ts` 覆盖声明式布尔值。

## 后果

宿主保留一个窄的设置写入接口，只有一个生产消费者，因为没有公开钩子能辨认配置写入事务。直接即时更新与手工 patch 中的内部默认值仍会被接受并回退，Settings 写入则在持久化前拒绝。内部可选性仍是呈现规则，不是授权。
