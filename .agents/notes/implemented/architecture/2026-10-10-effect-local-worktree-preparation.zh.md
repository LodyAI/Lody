# 原生本地 worktree 源准备

Status: implemented
Translation: current
PR: [#1394](https://github.com/LodyAI/Lody/pull/1394)

[English](2026-10-10-effect-local-worktree-preparation.md)

## 摘要

本地 worktree 准备此前混合同步文件系统、Promise Git 验证和直接元数据写入。
LocalWorktreePreparation 现在在调用方既有仓库租约下，通过官方 FileSystem、
WorktreeGit 和 Clock 拥有这一序列。写入前登记临时目录，独占发布完整文件，
有界清理失败保留恢复拥有者。实际 ensureRepo/create 路径通过既有 Legacy runtime
消费该内核；bare clone/fetch、变更、setup、GC 和 daemon 所有权仍是独立依赖。

## 职责和决定

有限服务通过 Layer.effect 捕获 FileSystem 和 WorktreeGit。prepareLocked 要求变更
调用方已持有仓库租约，不重复获取、不另建队列或 ManagedRuntime。管理器在每次调用
冻结路径和源字段，通过 getLodyDataDir 提供安装根目录；交给 Git 前创建根，保留
LodyDataDirUnavailableError 和[路径根决定](../bug-fix/2026-09-14-lody-data-dir-path-root.zh.md)。
源目录、Git 验证 argv、sourceGitDir 和元数据形状兼容。已有元数据逐字节保留，
用户文件及持久数据目录不属于补偿资源。

获取官方临时目录后立即登记释放，再写文件。安装的 4.0.2 中，makeTempFileScoped
在获取阶段完成初始写入；该写入失败可能早于目录释放登记。复用基础目录操作消除
此窗口，不另造文件系统后端。元数据写入已登记的临时目录，在同一文件系统通过
hard link 独占发布到 meta.json。只有发布阶段不可中断；源验证、Git 与准备写入
仍可中断。AlreadyExists 保留并发安装的元数据，其他失败仍可观察。这防止本地
失败或取消导致半写发布，不保证断电持久性、Git 事务或恶意文件系统竞态。

临时目录清理显式可中断，并使用 Clock 五秒期限，包括通常不可中断的 finalizer。
LocalWorktreeScratchReleaseFailed 保留唯一目录、完整失败 Cause 和有界 retryCleanup
Effect。期限结束代表清理失败且拥有者保留，不代表已删除。已交给内核的 Node 文件系统
I/O 可能在本地等待结束后才完成，重试只针对该唯一临时路径。即使元数据发布成功，
随后清理失败也拒绝操作。[draft worktree 契约](../../../../specs/session-worktree-lifecycle.zh.md)
记录这一增强的发布与失败保证。

管理器唯一 runWorktreeLegacy 执行 helper 通过既有 fileLocksLegacy runtime 获取
Exit；进程失败保留共享投影，临时目录释放 defect 与主错误、完整 Cause 一起保留在
基础设施 AggregateError 内，写入错误不会隐藏未释放目录。runObservationLegacy
现在只组合查询并委派同一执行器。原生变更拥有者获得服务后删除这些 helper；
worktreeGitLegacy 仍支撑未迁移的 Git 序列。本单元没有删除公共进程 Legacy 导出。

## 验证和限制

九项原生拥有权行为覆盖注入 Clock、部分写入失败、发布前中断、发布竞争、释放失败、
有界清理超时与重试、Git/释放混合 Cause、实际管理器 Legacy 投影和安装根不可用。
既有真实 ensureRepo/create 套件也验证元数据保留及源不可用后的恢复。八个所属及消费
套件 126 项通过。七项隔离消融均被行为测试捕获：无拥有者的 scratch、吞掉释放失败、
发布半成品、覆盖并发元数据拥有者、墙上时钟、丢弃 Git/释放混合 Cause，以及实际
Legacy manager 边界丢弃 scratch 拥有者。恢复后的原生套件九项通过；实验脚本不进仓库。

根 pnpm check 的全工作区类型与 lint 通过（零错误）。CLI 3742 项通过、一项跳过，
唯一失败是 signed-prefix Roost 超时；集成基线已复现同一用例，没有为绿灯删减覆盖。
test:ci 在此退出，因此另外执行 Shared（113 文件、1399 项）、Electron（215 项）
以及剩余五项 i18n/import/platform/process/public 检查，全部通过。pnpm format、
pnpm format:check、docs check 通过，没有修改 SHA 保护主题。Git 配置污染仅在验证
子进程隔离，不修改用户全局 Git 配置。

本地 Linux 验证不证明真实 Windows、委派 cgroup、打包安装或生产运行。文件系统发布
要求 hard link，与现有锁协议一致。有限服务没有后台任务，不代表完整 worktree 变更、
长期 GC 或会话取消已迁移。它衔接 [Git 执行](2026-10-10-effect-worktree-git-execution.zh.md)
和[观察单元](2026-10-10-effect-worktree-observations.zh.md)，两边原生内核独立支撑后续变更拥有者。
