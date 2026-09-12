# 从完整仓库元数据中发现归档目标

Status: implemented
Translation: current

Contract: [Session 关系与操作目标](../../../../specs/session-relations.md)

[English](2026-09-13-session-archive-complete-metadata-query.md)

## 摘要

根 Session 已可交互时，客户端元数据投影可能还没有包含它的直接子 Tab，导致过早归档。
现在每次归档都会读取仓库元数据索引来发现目标；如果查询失败，则不会执行任何写入。
这一方案既避免基于不完整缓存归档，也避免无限等待全局投影就绪，代价是每次归档多执行一次元数据索引扫描。

## 决策

归档操作会在写入任何状态之前取得工作区元数据索引。它从 room id 补全 Session id，只选择直接的
`parentSessionId` 子项，并在写入前重新确认捕获的工作区 runtime 仍然处于活动状态。当索引暂时落后于
已经可见的根 Session 时，仍可回退到已渲染的根元数据；但发现后代时绝不回退到 UI 缓存。

我们没有选择等待 `docMetaCacheReadyAtom`。就绪状态属于异步 UI 投影；实时事件触发的元数据读取可能失败或
长期不返回。让用户操作等待这个全局信号会引入无期限 pending 状态。仓库索引本就是构建该投影的数据源，
并且能为归档操作提供明确的成功或失败边界。

本次改动刻意不改变恢复与归档根永久删除的行为。它也不会把生命周期所有权扩大到
`openedBySessionId` 或 `openedByRootSessionId`；独立 Session 在开启者被归档后继续存活。

## 验证

所属 hook 测试从一个只包含根 Session 的 UI 缓存开始，而仓库索引同时包含其直接子项和独立打开的
Session。测试验证归档会更新根与子项、保留两个独立 Session，并且只关闭两个生命周期归属目标的终端。
另一个失败用例验证元数据索引查询报错时，会在任何归档元数据写入之前拒绝操作。延迟查询用例会在
发现完成前切换工作区，并验证旧 runtime 同样不会收到写入。

本次改动实现 [#574](https://github.com/LodyAI/Lody/issues/574)，并补充
[让被打开的 Session 不受开启者状态级联影响](2026-09-10-session-containment-lifecycle.zh.md)
所记录的包含关系决策。
