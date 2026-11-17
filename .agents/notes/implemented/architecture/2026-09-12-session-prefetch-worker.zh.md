# 会话预同步移入串行 Worker

Status: implemented
Translation: current

[English](2026-09-12-session-prefetch-worker.md)

## 摘要

此前后台预同步复用 Session store，会在用户未打开长对话时加载完整 LoroDoc
并创建包含 history 的 Mirror，阻塞 renderer 的 UI 主线程。此次把预同步
改为独立 Worker 中的原始文档同步，结果写入独立的二进制快照缓存，主线程
只接收完成状态。每个 renderer 共用一个串行任务槽，取消直接终止 Worker，
前台打开目标会话时按需合并已完成缓存。主动打开长对话的导入成本和 CLI
发送端加载成本仍在；本次没有宣称已通过真实长对话性能验收。

## 决策

```text
元数据候选 → 单任务队列 → Worker：LoroDoc 同步 → 独立快照缓存
用户打开会话 → 取消目标任务 → 合并缓存到前台 Doc → UI Mirror
```

仅把调度放入 Worker 不能隔离 Doc import；仅去掉 Mirror 也不能隔离 Loro
本身的开销。另一个可选方向是直接缓存传输二进制，但当前适配器依赖文档
版本向量和双向同步，因此本次保留原始 Doc，在 Worker 中使用现有传输。
不与 renderer Repo 共用数据库，避免两个独立实例写同一持久化状态。

Worker 每次任务结束即退出；并发和批大小均为 1。桌面／Web 批间冷却为
1.5 秒，移动端为 3 秒。独立缓存上限为 128 MiB / 64 条，保存快照和活动
进度的同一条记录，不复用前台远端游标。协调器在产生候选前加载最多 1000
条的轻量 high-water 时间戳索引，使被 64 条快照 LRU 淘汰的旧会话也不会在
每次启动重新排队；该索引不读取 Doc 或 history。父线程在创建 Worker 和
Loro WASM 前再读取快照 checkpoint，命中即完成；Worker 导入缓存前也会再读一次。
同一 workspace 的所有窗口共用 `[workspaceId, roomId]` 缓存
作用域，较慢的同平面写入不能降低 checkpoint。接收端没有创建业务字段；
本地适配器仍遵守现有版本协商协议。云端 Worker 使用与已挂载前台
transport 相同的显式 Streams endpoint。

跨窗口先用不等待的 Web Lock 领取 workspace、room、缓存作用域、账户、传输平面
及云目标，再检查缓存并启动 Worker。锁覆盖快照事务完成和 Worker 终止；锁已被
占用或不可用时跳过可选预取。窗口销毁会释放锁及其子 Worker。显式 `ready`
消息先于 `start`：模块 Worker 的顶层 WASM 初始化尚未完成时就可能分派消息，
立即发送的 `start` 会早于处理器注册而丢失。

缓存拒绝返回 `cache_rejected`，不返回 `synced`，也不写同步 high-water。
独立的有界 IndexedDB 索引按同一领取键及活动版本冷却三十分钟，跨窗口和重启
保留；协调器在运行期也抑制重复播种。真实新活动可立即重试。到期后只在后续
调度事件重试，不增加轮询定时器。最多保留 1000 条拒绝记录；元数据写失败时，
运行期用有界内存兜底，但这不能跨窗口或重启保留拒绝。前台打开仍取消预取，
沿已有合并和同步路径继续。128 MiB／64 条快照上限不变，缓存清理包含拒绝索引。

保留[回退决策](../simplification/2026-10-19-repo-upgrade-without-consumer-migration.zh.md)
中的已发布 Promise Repo／transport 消费边界。另建消费内核会扩大这次下载准入
修复；跨窗口互斥由浏览器锁负责，进程内信号量不能代替它。

缓存读取一直无响应时，取消会放弃只读结果，不再创建 Worker，也不占住 renderer
槽位。拒绝元数据的数据库打开会随取消退役；迟到的数据库句柄直接关闭，不开始
事务。已开始的拒绝写入会中止实际 IndexedDB 事务；锁要等真实的 `abort` 或
`complete` 终止事件，不以调用方超时当成写入已经结束。

任务取消由父线程终止 Worker，并发送本地 peer detach；这不依赖正在执行
同步 WASM 的 Worker 处理取消消息。打开目标会话先取消对应后台任务，已有
UI store 不参与预同步。导入缓存使用 CRDT merge，保留前台未上传编辑。
缓存清理包含快照和 high-water 数据库。已失效的 warm/evict 端口与
`maxWarmDocs` 策略字段已删除；Worker 任务结束即释放 Doc，磁盘快照只由
容量上限管理。

大文档本地同步会先发 `joined`，再发送更新分块；适配器的初次同步信号
不能单独作为缓存完成依据。Worker 等待自身版本达到 `joined.serverVersion`
后才导出快照，避免提前取消后续分块并错误保存活动进度。

这补充了[单一 history writer](2026-09-07-single-history-writer.md)的读取边界：
后台预同步完全绕过 Mirror，但用户业务写入仍由原来的 HistoryWriter 负责。
当前保证写入[草案 Spec](../../../../specs/session-background-prefetch.zh.md)。

## 验证与限制

[Worker 测试](../../../../packages/components/tests/eager-sync-worker.test.ts)使用真实
CRDT 更新，延迟最后一个本地分块，检查缓存拒绝及写入失败，并确认合并远端
历史不会丢失前台未上传编辑。
[协调器测试](../../../../packages/components/tests/background-sync-coordinator.test.ts)
覆盖候选上限、环境门控、拒绝不写 high-water、新活动及按事件触发的到期重试。
[浏览器验收](../../../../packages/components/tests/eager-sync-browser.integration.mjs)使用
真实 Chromium 窗口、Worker、HTTP 下载和 IndexedDB，检查领取互斥、已提交缓存
复用、取消、持锁窗口关闭及持久化拒绝。
拒绝是在合成字节下载后注入，不分配 128 MiB 历史；没有真实对话 fixture 或线上
流量测量。共享受浏览器存储分区限制，不覆盖独立 profile、origin 或 Electron
partition。已安装桌面／移动端验收、真实长对话内存和性能仍需单独验证。
