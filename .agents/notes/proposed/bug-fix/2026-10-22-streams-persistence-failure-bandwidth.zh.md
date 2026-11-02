# 本地持久化失败时 Streams 每秒重新下载房间

Status: proposed
Type: bug-fix
Translation: current

[English](2026-10-22-streams-persistence-failure-bandwidth.md)

发布更新（2026-10-23）：[正式 SDK 接入](2026-10-23-storage-recovery-release-adoption.zh.md) 使用 streams-crdt 0.19.2 和 Repo 0.25.0，取代下文未发布依赖和临时补丁的限制。

## 摘要

一位桌面端用户在数据盘 99% 满的情况下，一晚上下载了约 76 GB（约每小时 10 GB）。本地保存同步状态持续失败后，每个持久化房间大约每秒重启一次实时读取，并重新下载上次保存游标之后的全部内容；对很大的 Session 转录来说，就是整个文档。循环由两个上游缺陷造成，第三个缺陷让被替换的副本一直留在循环里；它们正在 loro-streams 和 loro-repo 修复，Lody 通过升级 catalog 版本采用。本次改动修复 Lody 侧的伴随问题：父进程管道关闭的 CLI 在五分钟内写了 2.46 GB 每日日志且一直不退出。上游修复尚未发布，所以 Lody 中的流量循环仍未修复。

相关：[本地持久化失败后实时读取循环空转](2026-10-19-streams-read-loop-spin.zh.md)，同一触发条件下更早的那个不发请求的循环。

## 报告中的证据

用户 `~/.lody/logs`（0.107.0-nightly.7）中的顺序：

1. 16:00 起渲染端 Repo 存储失败：`IndexedDB transaction aborted: Failed to write blobs (IOError)` 和 `database connection is closing`。磁盘只剩 3.6 GiB。
2. 23:59 起 `[streams-crdt]` 每秒多次重复 `sse flush chain error`、`live read failed (flush chain)` 和 `local append failed`，同时出现 loro-repo 的 `Cannot persist document "session-…": the repository has replaced this replica`。
3. 02:09–02:14 一个 CLI 进程记录了 2.46 GB 的 `uncaughtException: write EPIPE`；desktop 进程重启三次，每次重启都重新进入循环。
4. 10:14 重启应用打断循环。安装的仍是同一版本，所以打断循环的是重启，不是新版本。

用户代理的按主机流量统计在重启后不保留，所以把 76 GB 归到这些房间是根据日志推断的，不是实测。

## 机制（来自已发布的 streams-crdt 0.19.1 和 loro-repo 0.23.3）

- **连接时重置退避。** `setReadSubStatus("ok")` 会重置 `readErrorRetryAttempt`，而 SSE 打开回调在任何数据到达前就报告 `ok`。失败发生在之后：保存远端游标前运行的持久化屏障（`beforeRemoteCursorSave` → `repo.persistDocNow`）。因此终态类重启总是只等 1 秒下限。可重试分支在 SSE 保持打开 5 秒后也会清零 `retryAttempt`，而每次大的追赶下载都会超过 5 秒。
- **丢弃已应用的数据。** 游标只有在屏障成功后才前进，所以下一次读取从旧 offset 开始，重新下载已经导入内存文档的更新。存储持续失败时，每次下载都是浪费。
- **被替换的副本从不拆除。** `LoroRepo.unloadDoc` 驱逐副本，并让 Streams 适配器释放绑定它的会话；但会话还有 `refCount` 或进行中的一次性 sync 时，`releaseDocReplica` 直接返回。该会话继续向已驱逐的 `LoroDoc` 读入，屏障永远抛出 `StaleReplicaError`。是渲染端哪个持有者让会话保持存活，目前未知。
- **Lody 的修复循环。** 云端重连循环以 1–30 秒退避对出错的云端绑定调用 rejoin，而 `rejoin()` 会重置 SDK 的重试计数。即使修好 SDK 的退避，除非 rejoin 保留已应用的进度，这个 rejoin 节奏仍会重新开始下载。

## 决定

上游（[loro-streams#435](https://github.com/loro-dev/loro-streams/pull/435)，streams-crdt 0.19.2；[loro-repo#162](https://github.com/loro-dev/loro-repo/pull/162) 和 [loro-repo#163](https://github.com/loro-dev/loro-repo/pull/163)，loro-repo 0.23.4；均未合并）：

- 只在有持久化进展后重置读取退避，不在连接打开时重置。
- 只有持久化游标存盘失败时，继续读取和上传。每条更新只在内存中应用一次；只有持久化游标停住，它的存盘按 1–30 秒退避重试，直到存储恢复。期间房间报告 `error`，`rejoin()` 只重试存盘、不重连。持久化游标仍然永远不越过未持久化的状态。#435 的早期版本在每次读取前先重试存盘，存储失败期间所有实时更新都会停止；review 否决了这个做法。
- 首次 join 时游标存盘失败，join 仍会完成并继续读取，但只有实时读取到达远端尾部后，才报告首次同步完成（`waitUntilSynced`、`catchup`，进而 loro-repo 的 `firstSyncedWithRemote`）。存盘可能在追赶的两页之间失败，此时就确认会让 CLI 的 catalog 接受不完整的基线。连接关闭、终态持久化错误或读取重试耗尽时，等待方以错误结束。
- 允许消费方把屏障错误标记为终态，并把 `StaleReplicaError` 标为终态；拆除或重绑绑定在已替换副本上的会话。
- 浏览器关闭 IndexedDB 连接后重新打开（#163）。否则渲染进程的存储失败一次后，在重载前都无法再持久化。

Lody（本次改动）：CLI 的 `uncaughtException` 处理器只运行一次致命路径。当 stdout/stderr 是读端已死的管道时，每次控制台写入都会在下一个 tick 触发新的 EPIPE `uncaughtException`；逐个处理又会再记日志、再写入，这条链饿死了 5 秒的清理定时器，进程因此到不了 `process.exit`。现在只记录第一个异常，之后的只计数（退出前写一行汇总），并且 EPIPE 不再回显到已断开的控制台。`tests/telemetry-process-handlers.test.ts` 写入 1,000 个 EPIPE 异常，期望两行致命日志；没有此改动时得到 1,000 行。

未改动：渲染端可以在 IndexedDB 存储失败期间暂停云端 rejoin，但 loro-repo 不暴露按房间的错误，无法区分存储失败和网络失败；包装存储适配器来探测，又会对 Repo 隐藏其可选能力。有了上游的 rejoin 语义后这一步不再必要；若上游无法保留已应用进度再重新考虑。

## 剩余工作与局限

- 上游发布后，在 `pnpm-workspace.yaml` catalog 中升级 `@loro-dev/streams-crdt` 和 `loro-repo`，并加上经审核的 `minimumReleaseAgeExclude` 条目。
- 磁盘满仍会让本地持久化停止；这里只限制它造成的流量和日志量。告知用户存储失败是另一项改动。
- 未在报告者的机器上复现。
