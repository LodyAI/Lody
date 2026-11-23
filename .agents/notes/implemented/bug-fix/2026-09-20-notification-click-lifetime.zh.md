# 保持通知点击处理器存活至交互结束

Status: implemented
Translation: current

[English](2026-09-20-notification-click-lifetime.md)

## 摘要

桌面会话完成通知可能只唤起 Lody，而没有打开对应对话。主进程仅在等待投递期间保留通知对象，
投递成功后对象可能被垃圾回收，导致点击处理器失效。通知服务现在持有对象，直到点击、关闭或失败，
使现有的会话导航链路保持可用。确定性测试和独立 Electron 39.5.1 探针已验证对象保留与点击 IPC 投递；
尚未验证真实横幅点击到完整 chat 页面的端到端流程。

## 原因与职责

[Electron 39.2.6 的通知析构函数](https://github.com/electron/electron/blob/v39.2.6/shell/browser/api/electron_api_notification.cc#L68-L71)
会清除原生 delegate。Lody 现有点击处理器已经负责聚焦主窗口并发送 `app.sessionCompletionClick`，
渲染进程也已根据传入的工作区和会话导航。因此 delegate 丢失可以解释系统唤起应用后却没有导航的现象。
下述隔离探针复现了旧代码中的对象回收，但没有重放用户最初的那次点击。

[NotificationService](../../../../apps/electron/src/main/services/notification-service.ts)
持有强引用集合。[投递辅助函数](../../../../apps/electron/src/main/services/notification-delivery.ts)
在显示前加入对象，在点击、关闭、失败或同步显示异常时释放。成功的 `show` 事件仍立即完成 IPC，
但不释放对象。清理只移除自身监听器，不影响其他尚可交互的通知。不使用超时猜测通知何时失去交互能力；
若原生终结事件始终未到达，对象将保留到进程退出。

此修复补充了[投递结果决策](2026-09-13-electron-api-preparation.md)，不改变原有成功、失败语义或导航目标。
本次不处理应用重启后恢复通知回调。

## 验证

通过 Node 类型剥离运行 `notification-delivery.test.mjs`，五项测试全部通过。
测试用显式事件验证待投递及已投递对象的保留、独立点击、关闭、原生失败和同步异常，不依赖 GC 时机或等待。
macOS 隔离进程使用缓存中与锁文件一致的 Electron **39.5.1**、临时用户数据目录及合成会话和工作区 ID。
探针分别将 `git show HEAD:<path>` 和工作树中的实际通知服务、投递辅助函数转译为 CommonJS 模块。
仅替换窗口状态和错误格式化导入；通知、窗口、IPC 使用真实 Electron API。
构造器代理仅通过 `WeakRef` 记录通知对象，不持有强引用。

原生 `show` 完成后，跨过明确的事件循环边界，并等待显式 major GC
（`gc({ type: 'major', execution: 'async' })`）完成，结果如下：

| 观察项                                      | 修复前               | 修复后           |
| ------------------------------------------- | -------------------- | ---------------- |
| 原生通知发出 `show`                         | 是                   | 是               |
| 对象在显式 major GC 后存活                  | 否                   | 是               |
| 注入 `click` 后渲染进程收到正确会话和工作区 | 对象已回收，无法注入 | 是               |
| 点击后服务仍持有对象                        | 原先未保留           | 否，集合大小为 0 |

对存活对象调用 `emit('click')`，实际服务处理器将 `app.sessionCompletionClick` 发送到合成渲染页，
页面显示了收到的会话 ID。这验证了对象生命周期和主进程至渲染进程 IPC，**没有**验证系统横幅鼠标点击，
也没有验证 TanStack 导航至完整 chat 页面。两个探针进程均已退出，未使用生产配置、真实对话或正在运行的
Lody 进程。GC 探针仅为隔离诊断，提交的回归测试仍使用显式合成事件，不依赖垃圾回收调度。

`pnpm check` 因嵌套工作副本缺少依赖（`tsgo` 不可用）而停止；仓库要求在此跳过依赖安装。
`pnpm run docs check` 报告指向缺失 ACP 子模块的既有断链，均不涉及本次修改文件。
`git diff --check` 通过。
