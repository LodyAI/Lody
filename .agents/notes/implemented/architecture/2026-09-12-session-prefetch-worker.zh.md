# 会话预同步移入串行 Worker

Status: implemented
Translation: current
PR: [#2854](https://github.com/LodyAI/Lody/pull/2854), [#2853](https://github.com/LodyAI/Lody/pull/2853)

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
本身的开销。另一个可选方向是直接缓存传输二进制，但传输适配器依赖文档
版本向量，因此保留原始 Doc。云预取使用已发布的 Streams `catchup()`，
不加入写入房间，也不把恢复的缓存操作推断为待上传本地写入。
不与 renderer Repo 共用数据库，避免两个独立实例写同一持久化状态。

Worker 入口先安装消息处理器，再导入 WASM 任务模块，避免初始化期间丢失立即发来的启动消息。Worker 每次任务结束即退出；并发和批大小均为 1。桌面／Web 批间冷却为
1.5 秒，移动端为 3 秒。独立缓存上限为 128 MiB / 64 条。快照、快照版本向量、活动进度和可选的
版本 1 云游标在同一 IndexedDB 行内原子提交；云游标此前只存于任务内存。
恢复时必须匹配完整 stream URL，且快照向量和恢复文档都覆盖游标下界。
旧行无需升级数据库 schema：缺失或无效游标走 bootstrap，LRU 淘汰同时
删除数据和进度。Worker 不打开前台数据库。失败或中断保留上一对完整缓存，
不完整导入不能确认活动同步成功。一次性 catch-up 会返回缺依赖失败；父线程
还会在二十秒任务期限后终止卡住的 Worker。协调器在产生候选前加载最多 1000
条的轻量 high-water 时间戳索引，使被 64 条快照 LRU 淘汰的旧会话也不会在
每次启动重新排队；该索引不读取 Doc 或 history。父线程在创建 Worker 和
Loro WASM 前再读取快照 checkpoint，命中即完成；Worker 导入缓存前也会再读一次。
同一 workspace 的所有窗口共用 `[workspaceId, roomId]` 缓存
作用域，较慢的同平面写入不能降低 checkpoint。接收端没有创建业务字段；
本地适配器仍遵守现有版本协商协议。云端 Worker 使用与已挂载前台
transport 相同的显式 Streams endpoint。

跨窗口先用不等待的 Web Lock 领取 workspace、room、缓存作用域、账户、传输平面
及云目标，再检查缓存并启动 Worker。锁覆盖快照事务完成和 Worker 终止；锁已被
占用或不可用时跳过可选预取。窗口销毁会释放锁及子 Worker。入口先注册消息
处理器，再动态加载任务模块，不保留第二套 ready 握手。

缓存拒绝返回 `cache_rejected`，不返回 `synced`，也不写同步 high-water。
独立 IndexedDB 索引最多保留 1000 条退避记录，跨窗口和重启保留。缓存拒绝从
三十分钟开始指数翻倍，上限二十四小时。网络失败、缺依赖及任务超时从一分钟
开始；已有 Worker checkpoint 时上限三十分钟，否则为二十四小时，限制不完整
房间反复全量 bootstrap。真实新活动与元数据播种都不重置期限或次数。协调器
使用客户端观察到的实际期限，不在每次返回退避结果时延长它。成功缓存覆盖会
清空退避；到期后只在后续调度事件尝试一次，不增加轮询。元数据持久化失败时
保留有界内存兜底，但不能跨重启或窗口保留。前台打开始终独立。缓存清理包含
这个调度索引；128 MiB／64 条快照上限不变。

保留[回退决策](../simplification/2026-10-19-repo-upgrade-without-consumer-migration.zh.md)
中的已发布 Promise Repo／transport 消费边界。另建消费内核会扩大这次下载准入
修复；跨窗口互斥由浏览器锁负责，进程内信号量不能代替它。

缓存读取一直无响应时，取消会放弃只读结果，不再创建 Worker，也不占住 renderer
槽位。拒绝元数据的数据库打开会随取消退役；迟到的数据库句柄直接关闭，不开始
事务。重试元数据的写入和清除最多等待一秒。取消会尝试中止实际 IndexedDB
事务，但终止事件一直不返回时，也要释放锁和 renderer 队列。任务超时后，
回执使用独立预算，因为已经过期的任务 signal 无法保存该回执。迟到的元数据
结果只影响可重建的重试提示；内存冷却仍然有效。文档快照仍须提交后才能让
Worker 报告完成，这个收尾路径不会推进任何文档进度。

任务取消由父线程终止 Worker，并发送本地 peer detach；这不依赖正在执行
同步 WASM 的 Worker 处理取消消息。打开目标会话先取消对应后台任务，已有
UI store 不参与预同步。导入缓存使用 CRDT merge，保留前台未上传编辑。
冷文档只有在合并持久化完成后，或磁盘已覆盖该快照时，才能在 Repo 接管前
采用云进度。明文模式、工作区作用域、房间及已挂载传输的 stream URL 必须
一致。只在前台游标为空时条件写入，不能用不透明 offset 或时间戳排列游标。
Web Locks 在共享同一数据库的调用者之间互斥条件写入与普通保存；缺少该
能力则跳过采用。已有 live 文档不采用缓存进度，任一步失败继续正常 bootstrap。
游标只保存远端重放进度，不含 producer ack；下界之外的本地操作仍会上传。
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

[Worker 测试](../../../../packages/components/tests/eager-sync-worker.test.ts)以真实
Loro 与受控 HTTP 验证跨次增量、pending imports、失败或中断写入、410 恢复、
不完整房间跨客户端退避，以及保留前台未上传编辑。
[冷加载测试](../../../../packages/components/tests/local-window-bootstrap.test.ts)覆盖
先落盘后游标、独立窗口数据库、已有游标、pending imports 和未上传编辑到达
远端。[游标存储测试](../../../../packages/components/tests/resilient-remote-cursor-store.test.ts)
以真实 IndexedDB 验证普通写入竞争中的条件插入。

[协调器测试](../../../../packages/components/tests/background-sync-coordinator.test.ts)
固定候选上限、环境门控、不伪报 high-water 和按事件重试。
[浏览器验收](../../../../packages/components/tests/eager-sync-browser.integration.mjs)使用
真实 Chromium 窗口、Worker、下载和 IndexedDB，检查重复下载互斥、完整缓存
复用、取消、持锁窗口关闭、授权／平面隔离、未返回读取、失败和超时回执持久化
及成功后重置。在受控时间内，持续新活动的拒绝房间首个二十四小时只下载六次。
拒绝在合成字节下载后注入，不分配 128 MiB 历史，也不测量线上流量收益。

共享受浏览器存储分区限制，不覆盖独立 profile、origin 或 Electron partition。
已安装桌面／移动端验收、真实长对话内存和性能仍需单独验证。没有真实用户对话
fixture。线程隔离不代表无限内存或消除资源竞争。
