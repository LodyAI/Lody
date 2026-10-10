# 原生 worktree Git 执行与失败保留

Status: implemented
Translation: current

PR: [#1389](https://github.com/LodyAI/Lody/pull/1389)

[English](2026-10-10-effect-worktree-git-execution.md)

## 摘要

Worktree Git 已调用共享进程后端，但 Promise 边界丢失退出状态，管理器的宽泛捕获还会把
启动、超时和未解决的释放失败变成成功回退；credential-helper 探测也没有期限。
WorktreeGit 把命令执行、环境读取、状态检查和 helper 协议放进原生 Effect，通过 Layer
提供依赖，每条命令拥有自己的进程 Scope。唯一 Legacy 门面保留恢复租约，并区分
基础设施失败和 Git 退出。它是原生管理器的前置单元；worktree/setup/GC 与 HTTP 诊断
仍是 Promise 编排，本单元没有完成它们。

## 所有权与依赖

WorktreeGitLive 获取官方 FileSystem、ChildProcessSpawner 和 WorktreeGitHost。
Host 提供逐命令读取环境的 Effect，显式单次调用覆盖值优先，Git 保持非交互。
worktreeGitLayer 只组合固定版本的官方 Node 文件系统适配器、Host 与现有 CLI
进程/日志 Layer。默认组合在 Layer 输出中保留 logger 引用，确保命令诊断进入提供的 daemon sink。
服务没有缓存、后台 fiber 或长生命周期 acquisition。命令直接组合
runCommand，保留 Lody 有界进程后端与正常完成时有意保留 helper 的策略。取消、期限
或输出失败会等待进程树清理；未解决的释放仍可观察且有拥有者。这没有新增 spawn、
输出或终止实现，也没有引入 daemon runtime。

管理器通过唯一弃用的 worktreeGitLegacy 对象消费同一内核。仅此边界执行 Effect、
传递 AbortSignal，并通过 squashProcessFailure 投影完整失败。管理器自身改为组合
WorktreeGit 后删除门面。原 mapGitSpawnError 的生产调用方迁移后，移除这项同步映射；
稳定的 Git 不可用错误/分类器保留。原生 ENOENT 判断用注入的官方文件系统检查 cwd：
cwd 消失不代表 Git 不存在，权限失败不代表路径不存在。

本单元堆叠在[原生 local-project Git](2026-10-10-effect-local-project-git.zh.md)
及其[进程释放前置修正](../bug-fix/2026-10-10-effect-process-release-failure.zh.md)之上。
内核不依赖 FileLocks。原生管理器必须整合它、LocalProjects 和
[FileLocks](https://github.com/LodyAI/Lody/pull/1377)，setup/GC 或 Session 才能声称具有
结构化取消。现有[路线图](../../proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.zh.md)
拥有这些独立依赖单元。

## 失败契约与固定版本证据

WorktreeGitCommandFailed 保留已完成命令的 code、signal、stdout 和 stderr。
WorktreeGitExecutionFailed 区分启动、文件系统分类、超时、输出或流失败。管理器捕获
重新抛出基础设施及未释放资源失败，不再把它们视为缺失 ref、默认 identity、尽力 fetch
成功或强制删除目录的依据。普通 helper 诊断失败可以记录，但原始 Git 操作仍失败；
诊断中的未释放进程不能吞掉。Git 退出的具体回退策略留给管理器迁移进一步分类。
Git 的 10 分钟期限和 64 MiB 输出上限保持不变。Helper 探测新增 5 秒期限，保留共享
1 MiB 输出上限。[Worktree 生命周期 Spec](../../../../specs/session-worktree-lifecycle.zh.md)
保持 draft，记录这项失败保证。

已安装 Effect 4.0.2 源码表明 mapError 通过 catch 实现，会选取一个 Fail reason。
完整命令同时包含超时与释放 defect 时，这个操作会丢失 ProcessReleaseFailed 拥有者。
资源状态测试复现了该丢失。服务用 catchCause 与 Cause.map 保留全部 reason；仅在
单一类型化失败时执行异步 ENOENT 分类。Git 和 helper 恢复测试验证投影后的
ProcessCleanupFailed 租约在失败后仍可用。已核对官方
[Service/Layer 文档](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/Layer.ts)与
[FileSystem 文档](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/FileSystem.ts)及已安装 v4 源码，
没有直接照搬 v3 示例。

## 验证与限制

原生测试用 Deferred 与 TestClock 验证期限、中断和恢复。既有真实 Git 创建、查询、
删除、GC 行为覆盖保留；管理器回归观察操作拒绝与未提交文件保留。拥有者套件通过 32 个用例，
相关 7 个消费套件通过 99 个。十一项消融均被捕获：删除 Git/helper 期限、丢失
Git/helper 释放拥有者、冻结 Host 环境、丢弃调用覆盖、接受失败退出、cwd 缺失误判为
Git 缺失、吞掉 cwd 权限错误、吞掉管理器基础设施失败、丢失 logger 上下文。基线和
恢复源码通过。初次实验布局缺少公开 ACP 相对路径，导致套件加载失败；只修正实验
布局后基线通过。实验留在产品代码之外，不引入源码字符串或 mock 次数测试。
最终 CLI 类型及格式/文档检查通过。完整 pnpm check 的类型和 lint（零错误）通过，
随后停在此前已在干净 main 复现的 Roost signed-prefix 30 秒超时：CLI 3707 通过、
1 失败、1 跳过。独立 FileLocks/LocalProjects 合并基础的完整检查全绿，但那只验证
这些依赖，不能代表本修订全绿。补充 shared 测试通过 113 文件 / 1386 用例，Electron 通过 214 用例，进程、平台、
公共、import、i18n 守卫通过。独立完整 CLI 重跑仍只有同一超时（3707 通过、1 失败、1 跳过）。Git 污染仅在验证子进程
隔离，不修改全局 Git 配置或原工作区 dirty 子模块 gitlink。

本地 Linux 测试不能证明真实 Windows 根退出后的后代归属、委派 cgroup、打包安装或
生产行为。它不提供 Git 回滚、崩溃事务或 Session 端到端取消。管理器的可变配置/缓存、
同步文件操作、Promise 并行、HTTP 诊断计时器与 setup/GC 后台拥有者仍待迁移。
清理失败通过 Cause/Legacy 失败转交恢复拥有者，不引入仓库隔离或根拥有者注册表。
Daemon 根 runtime 留待真实长生命周期服务接入。
