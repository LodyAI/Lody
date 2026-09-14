# Session 关系与操作目标

Status: draft
Translation: current

[English](session-relations.md)

根 Session 可以包含子 Tab，也可以打开独立的 Session。这些关系承载不同的保证。例如：

```text
Session A
|- Tab T                 parentSessionId=A
|- Session B             openedBySessionId=A
`- T opens Session C     openedBySessionId=T, openedByRootSessionId=A
```

Tab T 是 A 的组成部分。即使 Session B 和 C 是由 A 或 T 发起创建的，它们仍是一级 Session。状态操作必须根据与操作相匹配的关系选择目标；这些字段不构成一棵生命周期树。

## 关系契约

| 关系                    | 含义                                                  | 操作后果                                                   |
| ----------------------- | ----------------------------------------------------- | ---------------------------------------------------------- |
| `parentSessionId`       | 直接包含关系。子 Tab 与根 Session 共享工作区。        | 根 Session 的归档、恢复和已归档根的删除包含直接子级。      |
| `openedBySessionId`     | 创建该 Session 的精确 Session 或 Tab。                | 为溯源和展示保留；绝不能据此推断归档、恢复或删除的所有权。 |
| `openedByRootSessionId` | 精确发起者是子 Tab 时的根路由。                       | 与精确发起者一起用于导航；绝不能用于选择状态操作目标。     |
| 资源元数据              | Session 所拥有的机器、项目、分支、工作区或 worktree。 | 只有当该 Session 是操作目标时才清理资源。                  |

`openedByRootSessionId` 是对 `openedBySessionId` 的补充而非替代：前者标识可路由的根，后者保留精确的因果来源。

目前只支持直接包含。支持的创建路径会拒绝父级本身已有 `parentSessionId` 的子级；状态操作不得为格式错误或遗留的嵌套子级递归创造行为。

## 操作契约

| 操作                | 目标                                                          | 元数据就绪条件                                   |
| ------------------- | ------------------------------------------------------------- | ------------------------------------------------ |
| 归档 Session        | 选中的 Session，以及 `parentSessionId` 等于其 id 的直接子级。 | 目标发现读取操作所观察到的仓库元数据快照。       |
| 恢复 Session        | 选中的 Session，以及相同的直接子级。                          | 目标发现必须使用完整元数据。                     |
| 永久删除已归档根    | 选中的 Session，以及相同的直接子级。                          | 除非用于发现的元数据集合完整，否则在变更前拒绝。 |
| 删除精确 Session id | 调用者提供的、恰好那些 id。                                   | 不得等待全局元数据加载，也不得发现额外 Session。 |

每个副作用都遵循与状态或文档操作相同的目标集合。终端关闭、机器命令和队列、启动配置移除以及 worktree 清理不得影响被排除在操作目标之外的 Session。

### 归档与恢复提交

每个归档或恢复操作会在提交前冻结选中的 Session 及发现出的直接子级。仓库将该操作的有效生命周期变更作为一个修订发布。观察者可能看到前一个或后一个修订，但绝不会看到因逐步应用该操作而产生的子集。副本可能在不同时间收到一个修订；这不承诺断开连接的客户端同时可见。

接受前失败不会留下该操作的变更。操作一旦被接受，持久化或确认失败必须保留其身份，并区分未确认结果与拒绝。两种情况都不允许把旧的 `isArchived` 或执行 `status` 值写回当前元数据。成功意味着操作已在本地持久化；远程同步和资源清理有各自独立的完成边界。跨重启恢复需要持久化操作，而不是内存中的错误或重试标志。

恢复可能多次交付同一个操作或修订。读取者与资源所有者必须幂等处理；重放既不创建新的逻辑操作，也不提升其优先级。跨崩溃通知不保证恰好一次交付。

冻结目标集相同的并发根生命周期操作，对整个集合选择同一胜者。集合不同时，共有目标使用相同的操作排序；不在较新操作中的目标保留最后一个适用的结果。后续独立的 Tab 操作仍可以只影响该 Tab，而较新的根操作在包含该 Tab 时也可以覆盖其独立操作。因此 `root active / child archived` 可能是有意状态；失败的根操作不得通过只变更部分目标产生这种组合。生命周期写入不拥有执行状态：运行时发布实际状态，恢复绝不会复活捕获的 `running` 或 `requestPermission` 值。

终端关闭在生命周期提交后开始。清理观察当前有效状态，并在异步资源处理期间与 start/resume 协调；旧归档任务不得销毁恢复后产生的新 runtime 代次。清理失败由其资源所有者报告并重试，不会反转生命周期操作。这些资源副作用可以在不同时间完成；生命周期的原子发布不承诺多个进程的原子终止。

操作始终绑定到捕获的工作区。提交前切换工作区会在不产生变更的情况下中止；接受后，发起操作的运行时拥有确认和恢复。渲染出的根只是展示证据，不是成员关系、先前状态或生命周期提交的权威来源。

### 兼容性

在启用新表示之前，每个参与的写入者和生命周期读取者都必须共享该操作与投影契约。Machine capability 描述的是该 daemon；它不能建立其他独立写入的 renderer 的兼容性。遗留行需要明确的迁移基线，之后的遗留写入需要经过测试的准入或兼容策略。这一策略与启用机制必须在替换生产路径前得到证明，不能延后到旧路径移除之后。对独立归档标志进行尽力双写并不能建立该契约。不受支持的客户端和仍处于离线状态的写入者仍是发布前提，而不是可以接受较弱不变量的证据。

### 精确删除

精确删除用于补偿和显式清理，此时调用者已经知道完整集合，包括部分创建的子级、空的子 Tab 或运行时已终止的旁 Session。在这些路径要求完整元数据扫描会阻止加载期间的清理，并可能留下部分状态。

对于开头的场景，归档或恢复 A 会影响 A 和 T，但不会影响 B 或 C。删除已归档的 A 根会删除 A 和 T，而 B、C 存活。精确删除 T 只删除 T。

## 删除后的溯源

删除发起者不得从存活的 Session 中擦除 `openedBySessionId` 或 `openedByRootSessionId`。这些 id 保存了无法事后重建的因果事实。

溯源与导航是分开的。单独一个 id 不是可导航目标。元数据加载完成后，只有精确发起者和其路由根都存在时，反向导航才可操作。如果任一缺失，客户端可以将该关系展示为已删除历史，但不得路由到缺失的 Session。本契约不要求 tombstone 或已删除标题。

已归档和活跃列表可以使用 opened-by 溯源来分组或缩进 Session。展示不得扩大归档、恢复或删除的目标集合。

## 范围与实现缺口

本 Spec 不定义 worker 监管、状态或结果聚合、未读或权限路由、worker 面板、settle 或 handoff 行为。这些产品选择仍属于 [#529](https://github.com/LodyAI/Lody/issues/529) 的范围。

归档与恢复现在都会在提交前读取同一个仓库元数据快照；查询或工作区所有权失败不会留下操作。在协调升级的本地 OSS 拓扑中，两种动作都会持久准入一个不可变操作，并通过仓库接缝投影其完整目标集合。浏览器准入使用工作区级 IndexedDB，CLI 准入使用专用工作区 SQLite 数据库；两者都会重放尚未发布的记录，而不改变其身份或排序。已有 archived flag 会成为确定性的 counter-zero baseline。本地启用后会拒绝直接写入遗留归档值；新建 Session 的初始 active 元数据仍然合法。

本地实现不涵盖发现快照之后创建的子级、递归包含、operation 历史压缩或永久删除的原子性。cloud 与 dual 产品拓扑仍保留遗留的独立写入路径，因为公共仓库无法隔离独立发布或离线的 renderer。在获得上文要求的外部混合客户端兼容证据前，这些拓扑不得启用新表示；Machine capability 不足以作为证据。因此本 Spec 仍为 draft，#574 对产品拓扑仍保持开放。[决策记录](../.agents/notes/proposed/architecture/2026-09-13-session-lifecycle-commit.md)负责维护存储布局、验证证据和剩余发布门槛。

## 证据

报告的行为和支持的场景见 [#531](https://github.com/LodyAI/Lody/issues/531)。客户端目标选择和精确清理位于 [`use-session-actions.ts`](../packages/components/src/hooks/use-session-actions.ts)，反向导航解析位于 [`session-navigation.ts`](../packages/components/src/lib/session-navigation.ts)。CLI 直接子级选择和嵌套子级拒绝位于 [`session.ts`](../apps/cli/src/commands/session.ts)。行为覆盖位于 [`use-session-actions.test.ts`](../packages/components/tests/use-session-actions.test.ts) 和 [`session-navigation.test.ts`](../packages/components/tests/session-navigation.test.ts)。操作模型与仓库投影由 [`session-lifecycle.test.ts`](../packages/shared/tests/session-lifecycle.test.ts) 和 [`session-lifecycle-repository.test.ts`](../packages/shared/tests/session-lifecycle-repository.test.ts) 覆盖。浏览器与 CLI 持久性分别由相邻的 [`session-lifecycle-persistence.spec.ts`](../packages/components/tests/e2e/session-lifecycle-persistence.spec.ts) 和 [`session-lifecycle-persistence.test.ts`](../apps/cli/src/lib/loro/session-lifecycle-persistence.test.ts) 覆盖。

包含关系目标规则由 [#569](https://github.com/LodyAI/Lody/pull/569) 实现。归档接受标准仍由 [#574](https://github.com/LodyAI/Lody/issues/574) 跟踪；本地证据不能建立产品混合客户端兼容性。本 draft 仍待人工批准。
