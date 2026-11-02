# 磁盘满导致写失败后阻断桌面端

Status: proposed
Type: feature
Translation: current
PR: [#1829](https://github.com/LodyAI/Lody/pull/1829)

[English](2026-10-22-desktop-disk-full-guard.md)

发布更新（2026-10-23）：[正式 SDK 接入](../bug-fix/2026-10-23-storage-recovery-release-adoption.zh.md) 使用 streams-crdt 0.19.2 和 Repo 0.25.0，取代下文未发布依赖和临时补丁的限制。

## 摘要

磁盘写满会让 Lody 无法持久化数据，但界面可能仍可使用且未解释故障。桌面端现在观察渲染端和本机 CLI 的仓库写失败，确认空间不足后显示无法关闭的弹窗。用户可以清理空间后重启，或退出；后台 agent 在这些操作之前继续运行。已发布依赖尚无观察接口，因此通过固定版本补丁回补上游实现，不升级存储或同步包。真实存储故障测试覆盖了信号路径，但尚未在真正写满的文件系统上试用。

## 决定与触发

负责人选择了**写失败后再确认空间不足**，并且**只阻断界面**。空间不足本身不会阻断，磁盘空间充足时的存储故障也不会阻断。这与 [Lody #1820](https://github.com/LodyAI/Lody/pull/1820) 讨论的重试、流量修复独立；本改动不包含那些上游同步修复。

主进程检查 Electron profile 和 Lody 数据目录，它们可能位于不同卷。要求可用空间为总容量的 2%，限定在 5–20 GiB；选择相对于要求最紧张的卷。并发查询合并，最多每十秒检查一次。初次检测跳过不可读目录；没有可读卷时不阻断。

阻断状态持续到进程结束。重启前必须成功读取所有数据卷，且每个卷比要求多出至少 1 GiB 空间。检查失败时保留弹窗，允许重试或退出。重启和退出沿用现有应用退出屏障，保留未保存编辑的否决与 CLI 关闭所有权。不自动重启、不清缓存、不暂停后台 agent。

## 信号与所有权

```text
渲染端 IndexedDB 写失败 → storageGuard.reportWriteFailure IPC ┐
本机 CLI SQLite 写失败 → 运行状态 issue → 桌面观察器           ├→ 主进程检查空间
                                                            └→ 产品窗口阻断弹窗
```

- `providers/workspace-repo-storage.ts` 为原生 IndexedDB 适配器传入 `onWriteFailure`。Electron 通过现有 IPC 桥接上报，合并并发上报并处理 IPC 拒绝；浏览器使用者不调用 Electron。适配器保留批量写、写租约、迁移、索引与检查点能力。
- CLI 的 `createCliSqliteRepoStore` 接收由 Fleet 经 Lody、文档管理器传入的回调。`CliRuntimeStateReporter` 使用现有可扩展 issue 协议保存一条有界的 `storage_write_failed` 问题。上报不含原始错误、路径或文档内容，不经云端传输。
- 主进程 `storage-guard-cli.ts` 观察更新的本机运行状态 issue；应用处理检查拒绝。`storage-guard.ts` 持有进程生命周期状态及合并后的磁盘查询。渲染端卸载时取消监听，较晚返回的初始快照不能覆盖新推送。
- `StorageFullGuard` 挂在运行时错误边界之外。受控弹窗没有关闭路径，并说明重启或退出会停止后台 agent。

观察器不持有 Repo 或接管其关闭。写入保留原有错误和重试语义，守卫不添加存储隔离门槛。保留现有 Promise IPC 与退出边界，不为通知回调扩展尚未完成的应用/CLI Effect 依赖链。

## 依赖补丁

`patches/loro-repo@0.24.0.patch` 回补 [loro-repo #164，提交 11b3dfb](https://github.com/loro-dev/loro-repo/pull/164/commits/11b3dfbcb5e479fd33eee0eef0b15a49e842d460) 的存储观察接口。将上游观察接口改动合并到发布包 0.24.0 source map 内的原始源码，保留 main 在 #1826 中采纳的待补依赖更新持久化修复。生成补丁前，已按 main lockfile 校验发布包完整性；将变更的类成员及报告器转译到发布包的 ESM、CommonJS 入口，并在两种声明格式中增加选项。相对于 main 的包版本和无关依赖解析保持不变，pnpm 在 lockfile 中记录补丁哈希。

钩子观察公开写操作失败，包括批量写、迁移状态、游标索引、检查点和 SQLite 持久游标写入。嵌套写操作对同一个错误对象最多报告一次。读失败及只记日志的读取时合并失败不上报；监听器抛错被隔离；busy 错误沿用现有重试预算，耗尽后才上报，不增加重试循环。

未使用适配器 Proxy 或不完整包装器，因为它们可能隐藏原生可选能力。等待发版会让用户要求的行为继续不生效；固定版本补丁使功能立即可用。升级到经审核、提供同等观察契约的正式 Repo 版本后删除补丁，保留集成测试。当前锁定的 0.24.0 已包含待补依赖更新持久化修复，但尚无这个观察接口。

## 验证与局限

- 主进程测试覆盖阈值、多卷、连续失败合并、持续阻断、不可读磁盘与重启拒绝；IPC 策略测试保证新服务已注册并放行。
- 渲染端测试通过真实守卫驱动弹窗，覆盖 Escape、重启/退出、初始状态时序和检查错误。真实 fake-indexeddb 适配器注入配额异常后能触发弹窗，且写入仍然拒绝；底层请求成功后事务再 abort 也能触发，读失败不触发。
- CLI 测试通过 `max_page_count` 限制真实 SQLite 连接，验证 `SQLITE_FULL` 经运行状态报告器、桌面观察器触发阻断，解除限制后存储仍可用。ESM、CommonJS 入口均覆盖嵌套写能力及错误对象一致性。[采纳决定记录](../../implemented/bug-fix/2026-10-22-loro-pending-persistence.zh.md)中的 SQLite 待补依赖更新重启回归测试在补丁包上也通过。
- 不覆盖远程 CLI 磁盘、仓库以外的存储，以及未经空间不足确认的故障。未做真正写满磁盘或各平台打包 Electron 验证；空间阈值是策略估计，不能证明后端故障原因。
