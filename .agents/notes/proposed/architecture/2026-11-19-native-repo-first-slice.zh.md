# Native Repo 第一刀

Status: proposed
Translation: current

[English](2026-11-19-native-repo-first-slice.md)

## 摘要

已关闭的 #2892 证明了 SDK 可用，但重复实现了各领域的生命周期和迁移 owner。
重写先接一份显式启用的本地 Preview comments 新数据，只有一个 SDK 宿主和一套观察生命周期。
旧房间保持原样，读取按目标 key/prefix，写入使用读取集合条件。
代价是实验数据暂时独立；通用迁移执行器必须先能保留原始因果、容器、删除记录和时钟证据。

## 决定及替代方案

Preview comments 已有有限的领域命令；Schedule definitions 还关联 registry 发布和执行，
会扩大第一刀范围。因此 daemon 使用 SDK 的 `ensureEngineHost`，main 用 `connectEngine`，
不再自建宿主 supervisor。窗口只释放自己的连接和观察；daemon 退出会使实验视图失效。
新进程可以重开持久化宿主，SDK 重连后重新发送快照。

[早先的回退决定](../../implemented/simplification/2026-10-19-repo-upgrade-without-consumer-migration.zh.md)
继续约束原有消费者；[工作区数据提案](2026-10-14-workspace-data-services.zh.md) 也仍是提案。
本次独立数据集不替代它们。拒绝每个领域自行迁移，也不增加 renderer 写者；下一刀提供统一执行器。

## 生命周期和故障范围

获取观察时即拥有句柄，不必等初值。`observeRoom` 在释放时立即停止回调，只接收当前快照
代际的增量；重连和释放回执交给 SDK/IPC。两端共用这段回调隔离逻辑，Effect fiber 不能
代替外部通知句柄的身份。

在线释放失败保留在 main 的窗口 registry，按 id 重试，每窗口最多 128 个观察。
窗口销毁或主 frame 导航会关闭各自的 client，即使此前释放失败。SDK 的 disconnected
表示旧连接已失效，不能写成在线 ACK 成功。其它窗口、房间和默认旧路径继续工作。
停止 JS 等待不等于取消 native 操作，不以启动第二个 writer 绕过未确认的关闭。

daemon 的 SDK 获取/释放使用一个 Effect Scope，只适配真正的外部 SDK I/O，
并未把原有 Promise Repo 包一层当作迁移。其它 Repo、缓存和应用 owner 保持原边界。
SDK 同步 native stop 和打包后的退出耗时仍需平台验收，JS timeout 不能证明线程已结束。

断线或条件冲突不自动重放写入。稳定的评论 id 支持按 key 核对，ACK 丢失不证明未写入。
commit/visibility 只代表本地。视图失效时保留上次投影，新快照到来前拒绝修改；
terminal gap 必须重新打开。

## 证据及边界

[设计](../../../docs/native-repo-first-slice.md) 记录分刀和预算。Shared 测试使用真实 addon、
磁盘、独立 OS 进程、断线重启和条件冲突；Electron IPC 测试使用真实装饰器、可信窗口准入、
真实引擎连接和合成身份；打包探针加载本机目标 addon。这些不证明签名安装包、真实窗口 UI、
全部平台打包、云同步或迁移已验收。
