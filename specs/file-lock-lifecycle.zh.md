# 文件锁生命周期

Status: draft
Translation: current

[English](file-lock-lifecycle.md)

Worktree 操作或 runtime 安装必须持有命名锁，直到工作和清理结束。独立 daemon 通过真实文件协调；共享 FileLocks 服务的调用方按登记顺序排队。

## 所有权与取消

通过 Layer 为每个应用拥有者提供一个 `FileLocks` 实例。操作拥有锁文件，通过独占 hard link 发布已写完的元数据；锁目录所在文件系统必须支持 hard link，不支持时明确失败。候选拥有者管理的元数据准备保持可中断；仅独占发布屏蔽取消，直到返回结果并登记释放，调用方等待清理完成。acquire-use-release 在执行 body 前登记释放。取消会立即移除本地排队票据；跨进程重试取消后不会再取得锁。原生 body 失败或中断后，先释放，再完成调用或允许下一位进入。

即使 body 成功，释放失败也返回 `LockReleaseFailed`。服务保留未解决的代次，后续操作先重试释放，再执行自己的 body。释放同时核对 pid 和获取 token，旧拥有者不能删除替代者。读取或权限错误返回 `LockIoError`，不能当作失效锁；文件确实不存在才算已释放；scratch 清理失败也保留并重试，Layer 结束仍有未解决的清理时必须失败，不能宣称 dispose 成功。

唯一的 `fileLocksLegacy` 门面拥有进程生命周期的兼容 runtime。`withLock` 接收 Promise 回调并传递调用方 AbortSignal；原始 Promise 真正结束前保留租约。忽略取消的回调可能延迟返回，因此尚未迁移的工作流并不具备原生结构化取消。`runPromise` 为现有 Promise 应用入口执行的原生程序提供同一个服务。Worktree、安装和 catalog 入口迁到应用 runtime 后删除此门面。

## 保留的策略

- 目录优先级：显式 `locksDir`、`LODY_LOCKS_DIR`、安装 profile 下的 `locks`。
- 名称中非字母、数字、下划线和连字符替换为下划线，再追加 `.lock`。
- 同上下文重复获取同一解析路径立即失败，包括规范化后的别名及 child fiber；不同锁可以嵌套，不允许隐式可重入。
- 当前用户的存活 pid 保留新鲜锁；不存在或属于其它用户的 pid、损坏元数据、超过 30 分钟的年龄判为失效。没有心跳；操作必须遵守原有年龄上限，过期的存活拥有者仍可能被接管。
- `timeout` 默认 30 秒，从本地排队获准后开始，只限制其它文件拥有者造成的竞争，不包括本地 FIFO 等待、body 或文件系统 I/O。重试从 100 ms 起按 1.5 倍增长，上限 2 秒。配置的第一次延迟保持原值，即使超过上限，也只从后续延迟开始封顶。负数或非有限延迟在排队前以 LockIoError 失败。与旧实现一致，在尝试失败后检查经过时间，下一次重试可能按延迟越过期限；这不是覆盖 I/O 的严格墙钟 deadline。
- 失效清理只检查 `.lock` 文件，不打开文档或启动工作；文件系统失败现在可观察，不再伪装为成功。

## 证据与边界

实现为 `packages/shared/src/node/file-lock.ts`。原生套件使用真实本地文件、Deferred 就绪信号和 TestClock；真实子进程验证双向互斥。CLI 套件覆盖路径适配、catalog 写入和安装消费。没有验证真实 Windows、网络文件系统、委派 cgroup 或打包安装。按年龄回收是协作式失效锁策略，不是内核 advisory lock 或崩溃事务。
