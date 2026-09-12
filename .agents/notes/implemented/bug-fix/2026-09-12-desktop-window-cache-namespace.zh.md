# 桌面窗口同步缓存命名空间一致性

Status: implemented
Translation: pending
PR: https://github.com/LodyAI/Lody/pull/641

## 摘要

辅助窗口的 Repo 数据库按窗口隔离，但远端同步游标和后台预取进度仍按工作区共享。第二个窗口切换到已在其他窗口打开的工作区时，可能用空 Repo 加载另一个副本已推进的游标，跳过本地缺失的数据并长期停在连接中。本次让 Repo、游标和后台 high-water 使用同一个工作区与窗口组合命名空间；代价是不同窗口各自保留一份可重建缓存，但这与独立 Repo 的既有设计一致。

## 问题

Loro Streams 的持久化游标表示对应本地副本已可靠写入的远端位置。多窗口实现只为 `lody-loro-repo-db-*` 增加了窗口 id，`lody-loro-stream-cursors-*` 和 eager-sync high-water 仍只使用 workspace id。两个窗口因此拥有不同 Repo，却共享声明本地数据已落盘的检查点，破坏了游标与副本必须一一对应的耐久性约束。

该路径属于[桌面多窗口实现提案](../../proposed/feature/2026-09-10-desktop-windows.zh.md)中明确未实测的托管多工作区场景；[桌面多窗口 Spec](../../../../specs/desktop-windows.zh.md)允许同一工作区存在多个窗口，因此聚焦或复用已有窗口不能作为同步正确性的替代方案。

## 决策

- runtime 创建时只读取一次辅助窗口 id，并生成稳定的 `<workspaceId>:<windowId>` 缓存命名空间；主窗口和非 Electron 客户端继续使用原 workspace id，不迁移现有缓存。
- Repo IndexedDB、Streams remote cursor IndexedDB 和 eager-sync high-water 都使用该命名空间。远端 stream id、鉴权和 workspace 身份仍只使用真实 workspace id。
- high-water IndexedDB 保留已有 `workspaceId` 字段和索引以避免缓存 schema 迁移，但字段值现在承载 cache namespace。该数据库属于可重建缓存，不是领域数据。

## 验证

组件运行时测试断言主窗口与辅助窗口的 Repo 数据库名、remote cursor 数据库名和 high-water namespace 来自同一个 cache identity。high-water 持久化测试使用同一 workspace 的两个窗口 namespace，验证一个窗口写入的同步进度不会被另一个窗口读到；原有测试继续覆盖写入和裁剪行为。`LODY-WINDOW-001` 桌面 E2E 使用真实 Electron 主窗口、辅助 renderer、IPC 和本地 CLI，并在辅助 renderer 启动前观测 IndexedDB 调用，断言它完成 runtime 初始化、Repo 数据库包含自己的窗口 id，且 high-water 查询使用相同 namespace。

- Node 22 下组件全量测试通过：456 个文件、3468 项测试。
- 仓库全量 typecheck、lint、i18n、Code Collab import、platform boundary、public boundary 和文档检查通过。
- `pnpm check` 的测试阶段仅有一个无关的 CLI worktree GC 用例失败：macOS 临时目录分别以 `/private/var/...` 和 `/var/...` 表示时，测试按字符串比较路径。该失败发生在 Electron 测试之前，因此本轮没有取得完整 `pnpm check` 成功结果。
- OSS E2E 不启用 cloud Streams，因此不会打开 remote cursor 数据库；该数据库名仍由组件运行时测试覆盖。托管桌面的双 Workspace 切换仍需在包含本修复的构建中复验。
