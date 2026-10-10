# 本地项目 Git 工作流原生 Effect 化

Status: implemented
Translation: current

PR: [#1381](https://github.com/LodyAI/Lody/pull/1381)

[English](2026-10-10-effect-local-project-git.md)

## 摘要

本地项目 helper 使用 Promise 编排命令，并将启动、超时和清理失败变成空退出状态，使仓库观察能够报告成功的非 Git 结果。现在单一内核使用原生 Effect 工作流，通过 Layer 提供文件系统、主机配置和已有有界进程服务。CLI 入口通过一个可见的 Legacy 门面消费该内核，纯 selector 与项目身份计算继续使用普通函数。取消会等待命令进程树清理，并行 tracking 探测失败会取消同级探测。本单元为 worktree setup 提供依赖，不代表 worktree GC、Session 所有权或 daemon 应用 runtime 已完成。

## 服务与兼容

LocalProjectsLive 捕获 LocalProjectPaths、LocalProjectHost 和官方 ChildProcessSpawner。公开工作流依赖 LocalProjects，内部顺序与并行查询直接组合 Effect。LocalProjectPathsLive 使用官方 FileSystem，默认组合由 NodeFileSystem.layer 提供。小型路径端口也让同步兼容方法通过明确的阻塞文件操作执行同一个归一化与身份内核。路径格式化、SHA 身份和分支 selector planner 保持普通计算，没有第二套 Git 或进程实现。

localProjectLayer 只组合依赖。单个 deprecated 的 localProjectsLegacy 门面拥有懒初始化、进程生命周期的 ManagedRuntime，投影错误时保留进程恢复租约，并让 CLI command、control、session、metadata 和 worktree 观察消费原生内核。runPromise 支持显式 AbortSignal。旧 Promise 导出和同步路径、身份导出改为原生名称；剩余兼容导入与调用均保留 Legacy 可见。同步门面仍阻塞，不自动获得中断能力。待这些 CLI 入口从 daemon 或应用 runtime 接收 LocalProjects 后删除门面；此版本的 worktree setup 与 GC 仍使用 Promise 编排。

本单元依赖[进程释放修复](../bug-fix/2026-10-10-effect-process-release-failure.zh.md)：此前 Scope 终止失败只记录警告，原生 Git 的失败与取消测试发现了这个缺口，因此单独交付。Git facts 可独立于 FileLocks 审查，worktree setup 同时需要两者。[迁移路线图](../../proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.zh.md)拥有整体依赖图。runtime/install 与 ACP transport 按各自依赖推进，不按层号全局串行。

## 保留行为与保证变化

[规范路径决定](../bug-fix/2026-09-26-local-project-symlink-worktree-path.zh.md)和[原生 GitHub 认证决定](../feature/2026-09-29-local-project-native-github-auth.zh.md)继续有效。项目 ID、精确 ref selector、本地与远端优先级、unborn 和 detached HEAD、分支冲突处理、dirty tree 拒绝以及 tracking worktree 限制均保留。本单元不改变原生 Git 凭据，也不允许 authenticated product-cloud 组合。

只有预期 Git 状态会产生领域缺失：非仓库或 bare 根目录探测、不存在的已验证 ref、detached symbolic ref 和缺失的可选配置。启动、期限、输出限制、文件系统权限或 I/O、损坏及释放失败直接传播，不再返回 false、空结果或分支不存在。精确 ref 先通过 show-ref --verify --quiet 验证，再用 --verify --hash 读取，兼容缺失 ref 的 hash 探测返回 128 的 Git 版本。两条命令之间 ref 消失会显式失败，每个存在的 ref 增加一次读取命令。并行 tracking 探测各自在其 Effect 内验证退出状态，使失败能取消并等待同级工作后再返回。

默认命令上限保持探测五秒、checkout 三十秒、每个输出流十六 MiB。命令中断沿用两秒优雅终止策略，无法确认释放时保留失败与恢复租约。每条命令通过 Layer 提供的 Effect 读取主机环境，非交互 Git 配置不变；runtime 初始化后的变化仍可见，保留原生 Git 环境配置行为。显式注入允许后续接入登录环境服务，不代表该服务已迁移。

[draft Spec](../../../../specs/local-project-git-lifecycle.zh.md)记录失败保证变化。清理成功不构成跨进程 Git 修改事务。本单元没有新增隐式文件锁串行化，也不回滚取消前已经发生的 Git 操作。

## 验证与边界

所属套件保留真实 Git 行为测试，并新增原生与同步路径身份一致性、损坏元数据、启动失败、超时与进程树清理、中断、失败释放保留，以及并行失败清理。并行用例通过 Deferred 和 TestClock 观察存活进程树及最终失败，不检查 mock 次数。所属套件 46 个用例通过，shared 和 CLI 类型检查通过。七项消融均被捕获：进程失败变成缺失、损坏变成缺失、跳过规范路径、吞掉路径权限错误、将不存在 ref 当作失败、冻结主机环境，以及命令拥有者脱离调用方。基线与恢复源码通过。全仓 pnpm check 的类型检查与 lint（零错误）通过，但 CLI 阶段遇到此前在干净 main 复现的 Roost signed-prefix 30 秒超时：3693 个用例通过，一个失败，一个跳过。补测 shared 的 113 个文件、1386 个用例和 Electron 的 214 个用例通过；进程、平台、公共、导入及 i18n 守卫全部通过。相关 CLI 消费套件 12 个文件、245 个用例通过。隔离重跑完整 CLI 仍只有这一超时（3693 通过、一个失败、一个跳过），不能称全仓检查通过。format、format:check 和 docs check 通过。Git 配置和临时目录 package 污染只在验证子进程中隔离。

本地 Linux 结果不代表真实 Windows、委派 cgroup、打包安装或生产验证。Windows 根进程先退出的后代仍需单独的 Job Object 工作。Session、ACP、Turn、根 ManagedRuntime 和 Loro 生命周期仍未完成。
