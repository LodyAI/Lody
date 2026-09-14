# 将 Session 生命周期操作作为一个持久化事实提交

Status: proposed
Translation: current

契约：[Session 关系](../../../../specs/session-relations.md)

[English](2026-09-13-session-lifecycle-commit.md)

## 摘要

遗留产品拓扑通过恢复先前读取的快照来补偿失败的元数据写入，这可能覆盖合法的并发写入，也可能自身只留下部分目标的变更。本地 OSS 拓扑现在会把每次归档或恢复记录为一个不可变操作，并通过共享的仓库投影推导有效的 Session 生命周期状态。操作是冲突解决、持久化和发布的单位；资源清理跟随所得状态。真实依赖探针确认本地 WASM 的回滚行为，真实 IndexedDB、SQLite 与 LoroRepo 测试覆盖了替代边界。产品混合客户端仍没有准入机制，因此更广泛的发布仍处于提案状态，#574 对该拓扑也尚未完成。

## 决策与范围

保留基于仓库的选定 Session 及其直接 `parentSessionId` 子级发现、明确的工作区所有权和提交后的终端清理。以仓库生命周期命令替代 `writeArchiveStateFailureSafe`、依赖顺序的写入、`attemptedTargets`、旧值补偿和回滚错误聚合。归档和恢复一起迁移，因为二者写入同一个权威来源。

一个操作冻结其目标 id、期望的归档状态、稳定身份和排序信息。其载荷在重试间不可变。共享解析器按完整操作排序，并发布一个有效元数据修订；它绝不为每个目标持久化一个独立的权威标志。独立 Tab 操作仍然有效，并使用相同的操作模型及单元素目标集合。执行状态仍由运行时拥有，绝不从生命周期快照恢复。

每个目标采用覆盖它的最高顺序操作。冻结集合相同的根操作一起选择同一胜者；集合不同时，较新操作未包含的目标保留此前结果。这是确定的操作优先级，不承诺所有子级始终与根同状态。

持久化准入包含崩溃安全的本地顺序分配，并在接受新命令前恢复已接纳但尚未发布的记录。发布和恢复允许重复交付同一个操作或修订；订阅者与资源副作用采用幂等处理，而不是声称通知恰好一次。资源处理还必须避免销毁恢复后产生的新 runtime 代次。

这是生命周期专用协议，不是通用 saga、命令队列或分布式数据库事务框架。兼容客户端仍针对自己的仓库本地写入。公共桌面端不引入 daemon 代理写入者、认证云端要求或托管实现。

冻结的 v1 wire 与准入布局如下：

| 边界 | v1 契约 |
| --- | --- |
| 同步记录 | 每个不可变操作以一条规范 JSON 字符串存储在元数据文档 `_lody/session-lifecycle-operations/v1` 的 `operation:<operationId>` 字段。 |
| 排序 | 规范非负十进制 Lamport counter，随后按 `actorId` 与 `operationId` 的 UTF-8 字节序决胜。 |
| 浏览器准入 | IndexedDB `lody-session-lifecycle-v1:<workspaceId>`，包含 `admissions` 与 `state` object store。 |
| CLI 准入 | 工作区 Loro 存储目录中的专用 `session-lifecycle.sqlite3`，包含操作表与 high-water 表。 |
| 结果 | 持久 receipt 区分 `published` 与 `pending`；无法确认的存储结果携带同一个可查询 operation id。 |
| 迁移 | 已归档旧行生成确定性的 counter-zero `baseline:v1:<sessionId>` 操作；active 行继续使用默认 baseline。 |

准入与本地 high-water 分配位于同一个存储事务。owner 会先安装完整 resolver revision，再通知逐 Session reader；启动时重放未发布准入，拒绝相同 operation id 的冲突 payload，并且不清理 v1 历史。本地启用后会拒绝直接写入遗留 `isArchived`，只有尚无 lifecycle winner 的 Session 可执行初始 `false` 写入。

## 依赖证据

检查使用了 Lody commit `54623883be77bd17f9dab18ef5a60cc2a9b156ef`，以及匹配 `loro-repo@0.20.0` 和 `@loro-dev/flock-wasm@0.4.3` 的已安装产物。使用的合成 Node 探针基于内存副本；没有操作产品 Session 数据。

基线探针针对这些固定版本检查了回滚与仓库发布行为；持久性契约现在由下文列出的 shared、browser 与 CLI owning tests 维护。

| 边界               | 观察到的行为                                                                  | 后果                                                |
| ------------------ | ----------------------------------------------------------------------------- | --------------------------------------------------- |
| 元数据存储         | LoroRepo 导入 WASM Flock，并在一个 meta Flock 中按 `m/docId/field` 存储字段。 | Session 文档不是独立的元数据事务存储。              |
| WASM 回调抛错      | 暂存值消失；没有事件或导出的变更留下。对端已导入的更新仍保留。                | 本地回滚可以避免写入过时的补偿。                    |
| 其他 Flock 实现    | `@loro-dev/flock@4.4.4` 在相同的抛错回调后仍保留数据。                        | 应测试并固定实际 adapter，而不是依赖 `txn` 方法名。 |
| 直接原始元数据事务 | 原始值发生变化，但预热的 LoroRepo 缓存仍旧且没有 repo patch 发出。            | 应用钩子不得绕过仓库缓存/事件所有者。               |
| 远程仓库导入       | 一个原始批次变成逐文档回调；回调可以读到 child archived 和 root active。      | 原子发布必须同时覆盖仓库和消费者投影。              |
| 并发原始事务       | 独立的逐键时钟可以收敛到混合的 root/child 元组。                              | 本地多键事务不是完整操作的冲突解决。                |
| 持久化             | `upsertDocMeta` 不等待持久化；`persistMetaNow` 是分开的。                     | 接受、本地持久化和远程确认需要分开的结果。          |

WASM 包随附的注释警告数据不会回滚，这与测试过的二进制相矛盾。应将观察结果视为特定版本的证据，并保留依赖特征门槛。导入活动中的 WASM 事务可能自动提交它；事务回调不得包含导入或异步工作。

前端明确在 [`create-workspace-runtime.ts`](../../../../packages/components/src/providers/create-workspace-runtime.ts) 中禁用元数据自动防抖。这使原始 `txn` 可以在那里调用，但不会修复缓存/事件绕过。仓库现有的[依赖补丁](../../../../patches/loro-repo.patch)只修改 live-monitor 启动，不修改事务语义。

## 替代方案与限制

重新排序补偿无法确定当前值的所有权。在尚未到达的远程编辑存在时，本地操作 id 比较后盲写无法将其纳入考量；按目标条件回滚仍允许部分完成。两种替代方案都无法提供所需的操作边界。

仓库拥有的多键批处理是有用的基础设施，但单独使用无法在逐键 CRDT 冲突解决中保留事务。必要时使用原生原子暂存；如果写入一个完整的生命周期记录已经提供更小的边界，就不要让通用批处理 API 成为前置条件。

后台协调器可以从持久化操作重建派生状态。它无法仅从标志判断 `root active / child archived` 是有意的 Tab 操作还是失败的补偿。现有 worktree GC 协调的是磁盘资源，而不是生命周期元数据，并且仍只负责根拥有的 worktree。

本地 OSS renderer 与 daemon 属于同一个协调发布物，只在 runtime 为纯本地拓扑时启用新权威。cloud 与 dual runtime 保留遗留路径，因为 daemon capability 无法隔离独立写入旧 renderer 的行为。公共仓库不包含所有产品客户端或工作区级的写入者准入机制；产品启用需要外部证据，也不得用较弱的双写模式替代。

## 与早期决策的关系

本提案保留[将通过 opener 打开的 Session 排除在状态级联之外](../../implemented/bug-fix/2026-09-10-session-containment-lifecycle.md)中的包含关系决策。它提议替换[使冷启动归档发现和提交具备失败安全性](../../implemented/bug-fix/2026-09-13-session-archive-complete-metadata-query.md)中的补偿决策，同时保留该变更的仓库发现。较早的已实现 note 记录其历史实现；它不构成对本替代方案的批准。

## 验证与发布

本地实现已有确定性的 parser/resolver 测试、真实浏览器 IndexedDB reload、真实 SQLite 关闭重开与多连接分配，以及双 LoroRepo 测试，证明首次投影读取会同时看到所有目标。renderer 和 CLI producer suite 断言只提交一个 lifecycle 操作；UI cache 在一次写入中安装 revision。资源测试让旧 runtime 的终止跨越一次较新的 restore，并证明替代代次不会被归档或写成 idle。`LODY-SESSION-004` 桌面 journey 会在浏览器完成持久准入后注入发布失败，随后 reload，并验证同一个操作对根与直接 child 完成重放，同时独立 opened Session 保持 active。

这些检查只允许纯本地切换，不允许产品启用。cloud 与 dual runtime 会继续使用遗留实现，直到共享兼容性边界能够准入或拒绝每个独立发布的 writer。Worktree 清理与终端处置跟随有效提交状态，不能让生命周期提交变得可逆。

[#658](https://github.com/LodyAI/Lody/pull/658) 是受影响的实现。在产品兼容性门槛获得证据前，[#574](https://github.com/LodyAI/Lody/issues/574) 仍保持开放。本地文档检查可能报告指向未初始化 ACP 子模块的链接；这些发现与实现验证无关。
