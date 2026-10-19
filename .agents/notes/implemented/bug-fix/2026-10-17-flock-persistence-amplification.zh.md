# 阻止原生 Flock 持久化让渲染进程队列膨胀

Status: implemented
Translation: current

[English](2026-10-17-flock-persistence-amplification.md)

## 摘要

[#1607](https://github.com/LodyAI/Lody/pull/1607) 让渲染进程改用原生 Effect Repo（`loro-repo` 0.23.0）之后，渲染进程会一次卡死 5–22 秒。Streams 每一次没带来变化的投递（渲染进程自己上传内容的回声、重复的 bootstrap、被重读的日志条目），都会连同一份整本 Flock 快照写进日志。整理从不统计这些行，于是 IndexedDB 的 Meta 队列涨到几百 MB，每次打开或整理都要在主线程上同步重放。`loro-repo` 0.23.1 恢复了 0.22 的记录规则：收到的字节只在改变状态时存一份；所有写入的字节都计入整理额度；整理也不能再让已落盘的保存失败。Lody 只需升级依赖。升级后第一次打开仍会把已有积压重放一次；约两秒一次的重复投递来源尚未查明。

## 证据

一位用户的渲染进程卡顿 watchdog 记录到两次卡顿，分别为 5.8 秒和 11.3 秒，期间一个核心满载，栈停在 `hydrateMetaSnapshots` 下的 `Flock::import_file`。该用户 IndexedDB 的 Meta 队列有 1278 行、174 MB：其中 395 个约 440 KB 的 Flock 文件，243 个互不相同，同一文件最多 38 份完全相同的副本；另有 883 行 JSON。队列大约每 1.5–2 秒增加一个文件。用安装包里的 binding 重放较早读取的 884 行，耗时 22.8 秒。

`loro-repo` 0.23.0 的 `src/effect/repo.ts` 里：

- `importFlockUpdates` 即使导入没有任何改动，也会推进修订号并保留收到的字节。
- `payload()` 在没有本地 key 改动时会导出整本文件。
- IndexedDB 适配器把这份文件追加进队列，而不是替换底稿。
- 整理只统计重新导出的本地增量。

0.22 的 Promise 日志（`FlockPersistenceJournal.receive`）明确跳过这类导入：没有远端事件、且 inclusive version 不变，就说明没有需要记录的内容。

## 决定

在负责这部分的 `loro-repo` 里修复（[loro-dev/loro-repo#154](https://github.com/loro-dev/loro-repo/pull/154)），不在 Lody 里打补丁：

- 收到的字节只原样存一份，且只在它改变了某个 key 或推进了 inclusive version 时才存（LWW 中输掉的条目也算）。远端事件不会变成本地 key。只有改动的 key 读不回来时才写整本文件。
- 所有写入的字节都计入 100 KiB 的整理阈值，并在 Repo 的 background scope 里加一个 60 秒兜底定时器。
- 整理只在保存已落盘、durable 修订号已推进之后运行。整理失败会报告到 `persistenceFailures`，由定时器重试。在这之前，统计收到的字节会让只有远端流量的副本也进入内联整理；整理一旦失败（例如重写底稿时遇到配额压力），已经落盘的保存也会失败，游标被挡住，release 和 close 每次重试都失败。
- IndexedDB 打开时，如果 Meta 积压达到 64 行或 100 KiB，就复用已水合的副本把它并入底稿。
- 原生 Streams 的 Flock 上传重新只带本地 peer 自己的条目。此前每次 join 之后的第一次本地写入，会把所有 peer 的条目重新上传一遍。
- 版本推断每次调用都用一个新的 Flock，不再用一个累积了每次 bootstrap 的影子副本。

「数据落盘后才保存游标」的规则不变。

考虑过的替代方案：

- 在 Lody 里用 `pnpm patch`：不采用。缺陷和它的测试都属于 Repo，应由 Repo 发补丁版本。
- 把渲染进程退回 Promise Repo：不采用。为一个范围明确的持久化缺陷撤销整个 #1607 不值得。

## 后续：0.23.2

对 0.23.1 的对抗式审查发现，新增的兜底定时器整理可能与一次保存触发的阈值整理同时运行。在没有「比较后写入」的适配器（`FileSystemStorageAdaptor`）上，较旧的那次捕获最后完成时，会覆盖较新的底稿，并删掉已落盘的行。Lody 使用的 IndexedDB 和 SQLite 适配器本来就会拒绝这种过时写入。[loro-dev/loro-repo#156](https://github.com/loro-dev/loro-repo/pull/156)（0.23.2）让每个副本同一时间最多只有一个整理，并且 release 开始后不再启动新的整理。它还修复了三处会影响 Lody 渲染进程的连带问题：

- 低于阈值的保存不再等待正在运行的整理；
- 定时器加入的整理失败后，仍会安排重试；
- 长时间整理期间写入的行，仍受 60 秒上限约束。

一个早已存在的文件系统 detached 读取竞态记录在 [loro-dev/loro-repo#157](https://github.com/loro-dev/loro-repo/issues/157)。

## 验证

- 在 0.23.0 上，原有 19 个日志用例中 18 个失败，4 个整理失败用例全部失败；在 0.23.1 上全部通过。每个用例都使用真实 IndexedDB 适配器和真实 Flock，覆盖 Meta 和命名 Flock 两条路径。
- 重放现场场景（2 万条记录的 Meta，150 轮重复 bootstrap 和重读，外加回声）：0.23.0 写入 510 行、41 MB，重开耗时 78 秒；0.23.1 写入 32 行、0.1 MB，重开耗时 11 毫秒。
- 升级路径：0.23.0 留下的 198 行、24 MB 积压会在第一次打开时并入底稿（约 14 秒）；之后的打开耗时 18 毫秒，数据没有丢失。

## 限制

- 升级后第一次打开，会把已有积压同步重放一次。
- 重复投递虽然不再写盘，每次仍要导入一遍（大 Meta 约几十毫秒）。只读调查没有在 Lody 中找到周期为两秒的调用方。当某个 Streams API 分片返回落后的 next offset、而 SDK 不做单调性检查就采用时，可以复现这个节奏；但这一点没有在真实服务上验证。
- 对于存储永久拒绝的原样字节，原生 Repo 没有整本文件兜底：payload 会一直留在队列里，游标一直被挡住，但不会丢数据。

Lody 升级：[#1672](https://github.com/LodyAI/Lody/pull/1672)（0.23.1），0.23.2 见后续升级。相关：[原生工作区 Repo](../../proposed/architecture/2026-10-16-native-workspace-repo.zh.md)。

当前边界（2026-10-19）：已撤回原生消费者及其后续应用补丁，仍选择 Repo 0.23.2；恢复的 Promise transport 自带远端 Stream 创建行为。见[撤回决策](../simplification/2026-10-19-repo-upgrade-without-consumer-migration.zh.md)。
