# 让冷启动归档的目标发现与提交具备失败安全性

Status: implemented
Translation: current

Contract: [Session 关系与操作目标](../../../../specs/session-relations.md)
实现：[PR #658](https://github.com/LodyAI/Lody/pull/658)

[English](2026-09-13-session-archive-complete-metadata-query.md)

## 摘要

根 Session 已可交互时，客户端元数据投影可能还没有包含它的直接子 Tab，导致过早归档。
现在每次归档都会查询仓库元数据来发现目标，并按先直接子项、后根 Session 的顺序提交。
写入失败会先进入补偿再拒绝操作；只有整组元数据提交成功后，才开始清理终端。

## 决策

归档操作会在写入任何状态之前取得工作区元数据索引。它从 room id 补全 Session id，只选择直接的
`parentSessionId` 子项，并在写入前重新确认捕获的工作区 runtime 仍然处于活动状态。当索引暂时落后于
已经可见的根 Session 时，仍可回退到已渲染的根元数据；但发现后代时绝不回退到 UI 缓存。
这里的“完整”仅指本次查询所观察到的仓库快照，不包括快照之后新建的子项。

我们没有选择等待 `docMetaCacheReadyAtom`。就绪状态属于异步 UI 投影；实时事件触发的元数据读取可能失败或
长期不返回。让用户操作等待这个全局信号会引入无期限 pending 状态。仓库索引本就是构建该投影的数据源，
并且能为归档操作提供明确的成功或失败边界。

LoroRepo 不提供跨文档回滚事务。因此归档先写子项，最后写根 Session，并把根写入作为最终提交点。
发生失败时，会尝试恢复所有已尝试目标原有的 `isArchived` 与 `status`。根 Session 会先补偿；若根补偿
也失败，则保留子项的已归档状态，并在同一错误中同时报告写入与补偿失败，从而保持“根已归档则子项也已归档”。
第一笔写入开始后，操作始终固定在捕获到的 runtime 上，因此切换工作区不会把同一次提交拆到两个
runtime。终端关闭是提交后的尽力清理：元数据失败不会关闭任何终端，而 IPC 失败也不会撤销或掩盖已经
持久化的归档。

本次改动刻意不改变恢复与归档根永久删除的行为。它也不会把生命周期所有权扩大到
`openedBySessionId` 或 `openedByRootSessionId`；独立 Session 在开启者被归档后继续存活。

## 验证

所属 hook 测试通过生产 `getMeta().scan()` 路径执行归档：UI 缓存只包含根 Session，而仓库同时包含
直接子项和独立打开的 Session。测试覆盖目标与终端集合、子项写入失败与最终根写入失败的补偿、
元数据失败时不关闭终端，以及切换工作区的两个边界：首笔写入前中止，首笔写入后继续在捕获的 runtime
完成提交。

本次改动实现 [#574](https://github.com/LodyAI/Lody/issues/574)，并补充
[让被打开的 Session 不受开启者状态级联影响](2026-09-10-session-containment-lifecycle.zh.md)
所记录的包含关系决策。
