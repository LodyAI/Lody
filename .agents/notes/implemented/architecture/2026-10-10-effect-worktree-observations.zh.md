# 原生 worktree 观察操作

Status: implemented
Translation: current

[English](2026-10-10-effect-worktree-observations.md)

## 摘要

worktree 查询此前在回调锁下执行 Promise 序列，损坏的仓库可能被表示成 HEAD 缺失的脏工作区。
原生 WorktreeObservations 服务现在组合官方文件系统、WorktreeGit 和拥有者提供的 FileLocks。
检查和列举持有 repo 租约直到命令清理完成，取消会永久移除排队查询。
现有管理器通过明确命名的 Legacy 边界执行同一内核；变更、setup、GC 和 daemon 所有权仍需另行迁移。

## 职责与决定

服务通过 Layer.effect 捕获 FileSystem、WorktreeGit 和 FileLocks，不持有后台任务或缓存。
`inspect`、`list` 获取现有 repo 锁，保留跨进程等待的 120 秒期限；同进程入队仍按
[文件锁契约](../../../../specs/file-lock-lifecycle.zh.md)不计入期限。
`info` 不再获取一把 repo 锁，创建和重命名调用方已经持有它；`currentBranch` 保留原有无锁读取边界。
进程有界释放失败时，错误保留恢复租约；文件租约释放不表示外部进程已消失，也不提供 repo 隔离。
每条 Git 命令通过 [WorktreeGit](2026-10-10-effect-worktree-git-execution.zh.md)拥有进程 Scope。

已安装的 4.0.2 官方 stat 会跟随符号链接。列举先 readLink 再 stat，保留旧 Dirent 过滤规则，
只有原始 EINVAL 才表示普通非链接。NotFound 可表示根或条目消失，权限及其它失败继续报错。
这只是观察策略，不能提供文件系统竞态保护或多条 Git 命令之间的事务。

已完成的 Git 非零退出可以形成明确的 failed 检查结果，不能被折成脏记录、null HEAD 或不完整的成功列表。
只有命名分支缺少精确 ref 才算未诞生；已存在但无效的 ref 仍失败。
映射和恢复保留混合 Cause，资源释放缺陷不能与 Git 退出一起消失。
这是对现有 draft [worktree 契约](../../../../specs/session-worktree-lifecycle.zh.md)失败可见性的加强。

Promise 管理器在每次调用冻结来源字段，通过 `runObservationLegacy` 在现有 `fileLocksLegacy`
运行时执行内核，不另建锁协调器、队列或 ManagedRuntime。该边界将未知缺陷报告为基础设施失败，
进程恢复租约仍由共享完整 Cause 投影保留。变更拥有者得到原生服务后删除这个 helper。
变更和诊断仍依赖 `worktreeGitLegacy`；本单元不删除共享进程 Legacy API。

## 证据与限制

现有查询套件覆盖真实仓库、改名和 detached 分支、脏文件、未诞生和损坏 ref、缺失目录及链接过滤。
注入 Effect 端口和显式 Deferred 信号验证排队取消、等待清理后交锁、失败释放、立即拒绝重入、
文件系统拒绝和混合 Cause 保留。原生集成还组合真正的 WorktreeGit 内核、FileLocks 与受控进程后端，验证后代清理和恢复租约保留。
行为消融只在临时副本执行。

所属查询套件 19 项通过；在包含 main 6de54b66b1a1cf812cd6f5c6fda40a3e0284c94e
的基础上，八个相关 CLI 套件 115 项通过，包括真实本地项目清理和运行实例凭据租约消费。
六项消融均被捕获，消融基线与恢复均为 16 项通过，随后补充了三项进程/清理集成回归。
工作区类型和类型感知 lint 通过，零错误。完整 pnpm check 止于两项 30 秒 Roost 超时：
signed-prefix 复用和 active-goal 缓存重建，CLI 3730 项通过、1 项跳过。
两项一起单跑时均在未改集成基线 864cfa67 复现；相同对照中，当前分支的 active-goal
通过，signed-prefix 仍超时。
Shared 113 文件/1399 项、Electron 215 项及 i18n、导入、进程、平台、public 守卫分别通过。
pnpm format、format:check 和 docs check 通过，保护评审 topics 为空。这不是完整工作区全绿。本地 Linux 验证不能证明 Windows、委派 cgroup、
打包安装或生产运行。管理器同步路径与存在性方法仍阻塞；观察操作不代表变更、setup、GC 编排
或 Session 端到端取消已经完成。

依赖图继续维护在原[路线图](../../proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.zh.md)。
前置评审是 [#1377](https://github.com/LodyAI/Lody/pull/1377)、
[#1379](https://github.com/LodyAI/Lody/pull/1379)、
[#1381](https://github.com/LodyAI/Lody/pull/1381) 和 [#1389](https://github.com/LodyAI/Lody/pull/1389)，
它们是 draft PR，尚未合并。
