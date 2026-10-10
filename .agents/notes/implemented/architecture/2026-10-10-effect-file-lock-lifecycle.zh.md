# 原生 Effect 文件锁与公平所有权交接

Status: implemented
Translation: current
PR: [#1377](https://github.com/LodyAI/Lody/pull/1377)

[English](2026-10-10-effect-file-lock-lifecycle.md)

## 摘要

共享文件锁原先以 Promise 尾链、定时退避和异步上下文单例管理生命周期，并吞掉释放失败。此改动让 FileLocks Layer 实例拥有本地登记表，由每个操作通过 Effect acquire-use-release 拥有真实锁文件。Ref 和 Deferred 保留严格 FIFO 并移除取消票据；通过独占 hard link 发布完整元数据。一个兼容 runtime 同时服务旧 Promise 调用方和原生 catalog 写入。保留竞争期限与失效锁年龄策略，但 I/O 和释放失败变为可观察；真实 Windows 与不支持 hard link 的文件系统仍未验证。

## 决定与证据

依赖和交付计划仍由[迁移路线图](../../proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.zh.md)拥有。这是进程基础 #1065、#1069、#1348 全部合并后的首个单元，直接复用原生 `probePid`，不执行同步兼容入口。

采用官方 `FileSystem` 服务与 `NodeFileSystem.layer`。`FileLockHost` 在组合时冻结 profile 目录与 pid；测试注入服务。核对已安装 Effect 和 platform-node-shared 4.0.2 的 `FileSystem.ts`、`NodeFileSystem.ts`、`Semaphore.ts`、`Deferred.ts` 和 `internal/effect.ts`。

两种看似直接的方案没有满足要求：

1. **单独 Semaphore 不保证严格登记顺序。** 保留的行为测试让两个调用方排队，再让持有者释放后立即申请相同锁。4.0.2 实测顺序为 holder → newcomer → second → third。Ref 原子登记票据，Deferred 在新请求能够登记前预留下一位的权限；取消只移除自己的票据，不等待前一位。测试现在要求 holder → second → third → newcomer。
2. **异步 `wx` 再写元数据会暴露空文件。** 旧同步写入不会在此窗口 yield；异步版本可能让另一进程把空文件视为损坏并接管。私有 scratch 目录拥有已写完的候选文件，由 `FileSystem.link` 独占发布到不变的 `.lock` 路径；准备失败或中断也清理 scratch。候选拥有者管理的元数据准备保持可中断；仅独占发布屏蔽取消，直到能够等待其结果及已登记的释放。行为测试分别在两个边界取消。不新增 spawn、输出收集或进程终止后端。

发布成功后，先登记释放，再执行 body。释放核对 pid 和 token，失败返回 `LockReleaseFailed` 并由服务保留未解决的 token。后续调用先重试释放；scratch 删除失败同样保留。Layer 结束时重试未解决的释放，
仍失败则报告聚合失败。每次发布尝试刷新时间戳，跨进程等待不缩短原有失效年龄窗口。文件确实消失才算已释放；读取失败不能当作失效锁。可读取的损坏元数据和原有 30 分钟接管策略保持不变。回收前再次检查观察内容，但这仍是协作式文件协议，不是内核 compare-and-unlink，也不保证过期拥有者接管期间的 advisory lock 语义。

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

## 验证

所属套件覆盖释放后立即重取时的严格 FIFO、本地和跨进程等待者取消、body 失败或中断、失效和 foreign pid 回收、名称别名及 child fiber 重入、元数据写入失败、释放失败保留和重试、token 替换保护。真实 Node 子进程通过就绪 IPC 验证双向互斥，仍由现有进程服务启动和清理。CLI 保留 profile 路径和命名覆盖，将重复的失效/存活锁测试集中到原生套件；catalog、worktree 和 cloudflared 消费保留行为覆盖。

13 项消融均被保留的行为测试捕获：同时放行全部票据、保留已取消票据、跳过释放、吞掉释放失败、移除 generation 校验、允许重入、覆盖发布、冻结发布时间、丢弃失败 scratch 拥有权、拒绝已确认的 scratch 不存在、使发布可中断、屏蔽元数据准备、跳过 Layer 清理。恢复内核后 20 项测试全部通过。实验只在临时副本运行，不提交脚本或源码字符串测试。全仓类型检查和 type-aware lint 无错误；20 项所属测试、35 项消费测试、25 项隔离环境的原生夹具、format/format:check、docs check 及平台/进程/公开/import/i18n 守卫通过。此前完整 pnpm check 在无关 Roost 历史覆盖及受环境影响的夹具中失败；只隔离验证子进程的 Git/PATH 与临时 package scope 后，后者通过，signed-prefix Roost 超时也在干净 main 643222f2 复现。完整隔离重跑仅剩该 Roost 超时：CLI 为 3687 通过、1 失败、1 跳过，因此 pnpm check 未通过；后续守卫独立执行。验证 clone 基于 0561e9da，此次执行未验证更新的 main 改动；未删除覆盖或修改全局 Git 配置。本地 Linux 结果不能证明真实 Windows、其它文件系统 hard link、委派 cgroup、打包安装或 ACP/Session/Turn 端到端取消。进程后端的 Windows 根进程先退出边界保持不变。
