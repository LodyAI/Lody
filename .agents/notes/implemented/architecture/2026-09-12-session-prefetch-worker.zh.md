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
Loro WASM 前再读取快照 checkpoint，命中即完成；Worker 再读一次以关闭
跨窗口竞态。同一 workspace 的所有窗口共用 `[workspaceId, roomId]` 缓存
作用域，较慢的同平面写入不能降低 checkpoint。接收端没有创建业务字段；
本地适配器仍遵守现有版本协商协议。云端 Worker 使用与已挂载前台
transport 相同的显式 Streams endpoint。

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

新增确定性测试覆盖 checkpoint 命中时不创建 Worker、活动更新后创建 Worker、
串行任务、取消时 detach、异步路由取消后的槽位释放、Worker 错误／销毁，
以及真实 Loro 更新缓存后与未上传前台编辑的合并。
分块用例显式延迟最后一块，确认不会提前保存快照。原调度器测试保留；
删除独立的策略常量测试文件，因为同一断言已在调度器
套件中存在。使用临时隔离依赖验证，不在嵌套 checkout 执行完整安装。

隔离验证共通过 36 项测试，其中 3 项是临时 IndexedDB 持久化／容量／跨窗口
checkpoint 单调性探针。Worker 模块类型检查及 Vite 6.4.1 的浏览器 Worker
构建也通过。整个仓库的文档
检查和 public-boundary 检查受到未初始化 ACP 子模块阻塞；未运行完整
应用构建或完整类型检查。新增 shared 子路径只导出已有快照编解码器，不
引入依赖版本变化。

没有真实用户对话 fixture，没有真实长对话性能测试。Worker 与 UI 仍共享
设备内存和 CPU，不能把线程隔离解释为无限内存或完全无资源竞争。
