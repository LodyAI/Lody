# 原生 Effect 文件锁与公平所有权交接

Status: implemented
Translation: current
PR: [#1377](https://github.com/LodyAI/Lody/pull/1377)

[English](2026-10-10-effect-file-lock-lifecycle.md)

## 摘要

Promise 锁队列与计时重试曾模糊取消和释放责任，并吞掉清理失败。FileLocks Layer
现在拥有公平排队与未释放代际；操作通过独占 hard link 发布完整元数据，未迁移调用方
使用唯一兼容 runtime。Clock/Schedule 保留竞争期限和失效策略。清理等待独立有界，
原始操作系统删除仍由租约拥有；仅获取阶段重试，保留业务与释放同时失败的完整原因。
Linux 行为测试验证已实现保证，不代表真实 Windows 或其它文件系统已验证。

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

原生程序穿过 fileLocksLegacy.runPromise 时使用 squashFileLockFailure，叠加 #1379 的进程感知投影，保留 body 失败及全部文件/进程恢复租约。直接 Cause.squash 的消融会丢失租约，资源状态测试能捕获；不新增锁内核或执行门面。锁保护程序的执行期，不把转交的失败进程资源宣称为已释放。

## 验证

现有套件保留真实文件的 FIFO/不可重入、取消、失效代际、崩溃 scratch 与跨进程覆盖。
此前迁移/评审实验分别捕获十四项拥有权机制和四项目录/回收机制。当前清理测试保留
这些行为，并补充独立有界释放、原操作恢复、后继代际保护及完整混合失败。

最终组合源码基于 main 45753fe61e0427043f5cb14c91b33e996ca376b0 验证：全仓类型检查与
type-aware lint 通过、零错误。完整 pnpm check 进入 CLI 测试后有 3753 项通过、1 项跳过，
剩下此前已复现的 Roost signed-prefix 30 秒超时，不宣称完整检查全绿。补验 Shared
112 文件 / 1415 项、Electron 216 项通过；8 个相关 CLI 套件 124 项、共享锁/shell/进程
套件 89 项通过。六项临时消融均被捕获：移除清理上限、重发已成功的旧 unlink、丢失文件
清理 Cause、随等待者取消共享生产者、丢失首次失败恢复拥有者，以及把 shell 释放失败
宣称成功。原始与恢复源码的锁/shell 套件分别通过 28/18 项；脚本不进产品代码。
格式、五项边界守卫和 docs check 通过。Git/PATH/临时目录/锁目录隔离只在验证子进程中
进行，不修改全局 Git、原工作区 HEAD 或 dirty 子模块 gitlink。验证期间主分支合入其它
改动，本轮保留明确验证的快照，不宣称已集成之后的分支尖。

## 有界清理与完整失败

修正评审发现的两处缺口：每份清理租约保留一个原始文件系统操作，独立且可中断的
等待任务使用捕获的 Clock，将每次等待限制为 5 秒。原始 unlink 仍不可被本地取消打断，
由租约和服务登记表共同拥有；等待超时不表示操作系统删除已经停止。只有已结束且
失败的操作才允许重新尝试；尚未结束或已成功的操作只等待原结果，不会再次删除被
后继者复用的路径。未完成的锁代际阻止后续本地持锁者进入。实际成功后才移除登记；
Scope 释放失败通过 FileLockCleanupFailed 转交全部清理租约，关闭之后仍可恢复。
服务释放并行等待保留的租约。该上限针对每次清理等待，不代表所有文件系统获取或
跨进程失效锁回收都已有相同上限。

重试与退避现在仅包围元数据准备和独占发布。业务操作恰好执行一次，业务与释放
失败的全部 Cause 原因均保留。squashFileLockFailure 保留原始失败的进程感知投影、
完整原生 Cause 和每个文件清理租约。Worktree 兼容投影与回退守卫同样保留这些拥有者，
不会把释放失败转成不存在。拒绝简单的“可中断 unlink 加 timeout”，因为本地等待结束
后迟到的操作系统删除可能移除后继者的锁。

现有真实文件套件补充了阻塞 unlink 后取消、阻塞 Layer 释放、Scope 关闭后恢复、
后继代际保护，以及业务和文件释放同时失败的行为覆盖。用 Deferred 就绪信号和
TestClock 推进期限，不使用真实睡眠。临时消融脚本不进入仓库。应用与会话的整体
所有权、非协作跨进程替换路径仍是独立边界。
