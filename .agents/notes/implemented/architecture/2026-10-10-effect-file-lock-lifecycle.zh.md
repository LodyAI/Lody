# 原生 Effect 文件锁与公平所有权交接

Status: implemented
Translation: current
PR: [#1377](https://github.com/LodyAI/Lody/pull/1377)

[English](2026-10-10-effect-file-lock-lifecycle.md)

## 摘要

共享文件锁原先以 Promise 尾链、定时退避和异步上下文单例管理生命周期，并吞掉释放失败。此改动让 FileLocks Layer 实例拥有本地登记表，由每个操作通过 Effect acquire-use-release 拥有真实锁文件。Ref 和 Deferred 保留严格 FIFO 并移除取消票据；通过独占 hard link 发布完整元数据。一个兼容 runtime 同时服务旧 Promise 调用方和原生 catalog 写入。保留竞争期限与失效锁年龄策略，但 I/O 和释放失败变为可观察；真实 Windows 与不支持 hard link 的文件系统仍未验证。

## 决定与证据

依赖和交付计划仍由[迁移路线图](../../proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.zh.md)拥有。这是进程基础 #1065、#1069、#1348 全部合并后的首个单元，直接复用原生 `probePid`，不执行同步兼容入口。

采用官方 `FileSystem` 服务与 `NodeFileSystem.layer`。`FileLockHost` 固定 pid，并提供每次操作调用的目录解析器；核心测试可以注入固定目录。修正：最初在组合时缓存目录改变了旧实现逐次读取环境变量的语义，现已移除该快照。核对已安装 Effect 和 platform-node-shared 4.0.2 的 `FileSystem.ts`、`NodeFileSystem.ts`、`Semaphore.ts`、`Deferred.ts` 和 `internal/effect.ts`。

两种看似直接的方案没有满足要求：

1. **单独 Semaphore 不保证严格登记顺序。** 保留的行为测试让两个调用方排队，再让持有者释放后立即申请相同锁。4.0.2 实测顺序为 holder → newcomer → second → third。Ref 原子登记票据，Deferred 在新请求能够登记前预留下一位的权限；取消只移除自己的票据，不等待前一位。测试现在要求 holder → second → third → newcomer。
2. **异步 `wx` 再写元数据会暴露空文件。** 旧同步写入不会在此窗口 yield；异步版本可能让另一进程把空文件视为损坏并接管。私有 scratch 目录拥有已写完的候选文件，由 `FileSystem.link` 独占发布到不变的 `.lock` 路径；准备失败或中断也清理 scratch。候选拥有者管理的元数据准备保持可中断；仅独占发布屏蔽取消，直到能够等待其结果及已登记的释放。行为测试分别在两个边界取消。不新增 spawn、输出收集或进程终止后端。

发布成功后，先登记释放，再执行 body。释放核对 pid 和 token，失败返回 `LockReleaseFailed` 并由服务保留未解决的 token。后续调用先重试释放；scratch 删除失败同样保留。Layer 结束时重试未解决的释放，
仍失败则报告聚合失败。每次发布尝试刷新时间戳，跨进程等待不缩短原有失效年龄窗口。文件确实消失才算已释放；读取失败不能当作失效锁。可读取的损坏元数据和原有 30 分钟接管策略保持不变。回收前再次检查观察内容。修正：内容已变化且文件仍存在时，回到 Schedule 退避与竞争期限检查；只有确认文件不存在或成功删除才立即重试。这仍是协作式文件协议，不是内核 compare-and-unlink，也不保证过期拥有者接管期间的 advisory lock 语义。

## 保留的锁策略

每次操作按显式 `locksDir`、当前 `LODY_LOCKS_DIR`、当前安装 profile 的 `locks`
目录解析（包括当前 `LODY_DATA_DIR`）；进程生命周期的兼容 runtime 不缓存该结果。名称中除字母、数字、下划线和连字符外的字符替换为下划线，再追加 `.lock`。
同一上下文重复获取同一解析路径，包括名称清洗后的别名和 child fiber，立即失败；
不同名称可以嵌套获取。

默认 30 秒 `timeout` 从本地 FIFO 获准后开始，仅限制与其它文件拥有者的竞争，
不限制本地排队、body 执行或文件系统 I/O。重试从 100 ms 开始，以 1.5 倍增长，
上限两秒；配置的首次延迟即使超过上限也原样使用，后续延迟才截断。
负数或非有限延迟在登记前以 `LockIoError` 失败。失败尝试后才检查耗时，
因此下一次重试可能超过期限一个延迟；这不是严格的 I/O 期限。

属于当前用户的新鲜 pid 保留锁；不存在或属于其它用户的 pid、可读取但损坏的
元数据、超过 30 分钟的年龄允许失效回收。没有 heartbeat，过期的存活拥有者仍
受原有接管策略约束。失效清理扫描 `.lock` 文件和 `.lody-lock-*` scratch 目录，
不打开文档或启动工作。修正：普通 finalizer 与内存里的释放失败登记无法清理崩溃遗留。
完整 scratch 元数据沿用锁的 pid/年龄策略，保留新鲜活拥有者已发布和等待发布的候选。
缺失或不完整元数据要求目录/owner 最新可用 mtime 已超过 30 分钟；mtime 不可用则保留。
递归删除前复查 owner 内容。此宽限期保护正在准备的候选，也能清理遗留的空目录或半写元数据。
文件系统失败保持可观察。锁目录必须支持 hard link，不支持则显式失败。
这仍是协作式文件协议，不是内核 advisory lock 或崩溃事务。

## 消费边界与删除条件

```text
FileLocks Layer 实例（Ref 登记表 + Deferred 票据）
  └─ 获准操作 → 拥有候选文件 → 独占发布
       └─ 原生 body → 核对释放 → FIFO 交接
fileLocksLegacy（一个进程生命周期 ManagedRuntime）
  ├─ withLock：worktree / cloudflared / Baguette Promise body
  └─ runPromise：现有应用入口的 catalog 修改
```

Catalog 修改直接组合 `withFileLock`，依赖环境暴露 FileLocks；删除 Promise 写队列及嵌套 Effect 执行。短的文件读改写 body 保持不可中断，直到原始文件系统 Promise 结束，避免写入仍在进行时释放租约；这不提供崩溃恢复或跨 peer 事务。Catalog 的读取缓存仍有旧 Promise 刷新逻辑，不能宣称整个模块已迁移。

旧 Promise `withFileLock` 导出替换为同名原生 Effect API。`cleanupStaleLocks` 也为原生；没有产品调用方需要同步兼容清理入口。唯一的 `fileLocksLegacy` 对象标记 deprecated，导入和调用均保留 Legacy 可见。Worktree、安装入口仍为 Promise 工作流，回调直接收到调用方取消信号，在 body 中等待真正结束后才释放；忽略信号的回调可能延迟取消。Finalizer 不等待无界 Promise body。这些入口迁到 daemon runtime 后，删除兼容对象及异步上下文桥；统一根中提供一个 FileLocks 实例，避免独立服务实例把本地竞争计入跨进程等待。

原生程序穿过 fileLocksLegacy.runPromise 时复用 #1379 的 squashProcessFailure，保留同时发生的 body 失败和全部进程恢复租约。直接 Cause.squash 的消融会丢失租约，资源状态测试能捕获；不新增锁内核或执行门面。锁保护程序的执行期，不把转交的失败进程资源宣称为已释放。

## 验证

所属套件覆盖释放后立即重取时的严格 FIFO、本地和跨进程等待者取消、body 失败或中断、失效和 foreign pid 回收、名称别名及 child fiber 重入、元数据写入失败、释放失败保留和重试、token 替换保护。真实 Node 子进程通过就绪 IPC 验证双向互斥，仍由现有进程服务启动和清理。CLI 保留 profile 路径和命名覆盖，将重复的失效/存活锁测试集中到原生套件；catalog、worktree 和 cloudflared 消费保留行为覆盖。

初次迁移验证：14 项消融均被行为测试捕获：同时放行全部票据、保留已取消票据、跳过释放、吞掉释放失败、移除 generation 校验、允许重入、覆盖发布、冻结发布时间、丢弃失败 scratch 拥有权、拒绝已确认的 scratch 不存在、使发布可中断、屏蔽元数据准备、丢失进程恢复租约，以及跳过 Layer 清理。基线与恢复源码的 21 项测试通过；实验只在临时副本运行，不提交脚本或源码字符串测试。接到 #1379 后，所属文件锁 21 项、进程 40 项和相关 CLI 38 项测试通过。集成的全仓 pnpm check 通过：CLI 3692 项、shared 113 个文件和 1389 项、Electron 214 项以及全部守卫通过。type-aware lint 零错误；此前复现的 Roost signed-prefix 超时在此次完整运行中通过。Git/PATH、临时 package scope 和锁目录污染只在验证子进程中隔离，不修改全局 Git 配置或删除覆盖。当前 stack 以 #1379 为 base；固定 Effect 4.0.2。进程、平台、公共、导入及 i18n 守卫，format、format:check 和 docs check 通过。本地 Linux 结果不能证明真实 Windows、其它文件系统 hard link、委派 cgroup、打包安装或 ACP/Session/Turn 端到端取消。Windows 根进程先退出后的后代归属仍未解决。

三项评审修正扩展同一个行为套件：同一兼容 runtime 内改变环境默认目录（同时验证显式覆盖与 profile fallback），持续替换失效 generation 仍会超时且保留替换文件，确认消失后不经过 sleep 立即重试，以及回收崩溃遗留时保留活拥有者已发布/等待发布的候选与新鲜的无完整元数据目录。修复前其中三项回归失败；修复后完整 25 项文件锁测试通过，包括真实跨进程互斥。四项临时消融均被捕获：冻结环境默认目录、内容已变仍立即重试、确认消失后仍退避，以及跳过崩溃 scratch 清理。恢复源码后完整套件通过，实验脚本不提交；相关 CLI 消费路径 9 个套件和 129 项测试通过。测试使用真实文件和注入的 Clock/FileSystem 边界，不检查源码字符串或 mock 调用次数。

修正验证：`pnpm check` 完成全仓类型检查与零错误的 type-aware lint，随后因此前已复现的 Roost signed-prefix 30 秒超时（`roost-session-backend-contract.test.ts`）中止；CLI 3659 项通过、1 项跳过。后续 workspace 和 Electron 全套测试未完成。所属文件锁套件与相关消费路径已单独通过。format、format:check、shared 源码格式检查、五项边界守卫和 docs check 通过；没有删覆盖或修改全局 Git 配置，注入的 Git、PATH 和临时目录污染只在验证子进程中隔离。这是 Linux 验证，不代表真实 Windows 或其它文件系统验证。
