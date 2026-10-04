# 桌面窗口关闭诊断与打开延迟

Status: proposed
Translation: current

[English](2026-10-04-desktop-window-lifecycle-diagnostics.md)

## 摘要

附属窗口会使用统一的未保存内容提示，却不说明哪项状态阻止了关闭；可选的窗口预热也不保证
目标会话已准备好。调查这两个现象，应先明确关闭原因并测量实际打开路径，再调整窗口所有权。
建议先定位关闭否决、测量预热覆盖率，再评估共享文档所有者与范围受限的视图订阅，以降低未命中成本。
初步调查没有复现报告中的关闭误报；同版本 Electron 隔离探针排除了干净页面无条件阻止关闭。
后续的[共享所有者实现](../../implemented/architecture/2026-10-04-shared-desktop-session-owner.zh.md)
记录了采用的数据所有权改造与评估；最初的关闭弹窗根因仍未确立。

## 已确认行为

| 边界         | 证据                                                                                                                                             | 影响                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| 原生关闭确认 | [renderer-unload.ts](../../../../apps/electron/src/main/renderer-unload.ts) 对所有 `will-prevent-unload` 使用相同文案                            | 附件／编辑器文案不能指认实际阻塞原因。                                                                             |
| 暂存发送     | [SessionPendingSendsHost](../../../../packages/components/src/components/chat/session-pending-sends-host.tsx) 在运行时存在待发送消息时安装保护   | 同一运行时其他会话中失败或排队的发送也会阻止关闭；已写入消息会退出队列。                                           |
| 编辑器写入   | [useCodeCollabSaveText](../../../../packages/components/src/hooks/use-code-collab-save-text.ts) 检查缓冲文本、保存中、冲突和错误状态             | 可见会话空闲时，保护仍可能有合理原因。                                                                             |
| 可选云客户端 | [convex-provider.tsx](../../../../packages/components/src/providers/convex-provider.tsx) 使用默认选项构造 Convex                                 | Convex 1.33.1 也为未完成的 mutation/action 安装保护；必须确认云组合与待处理请求才适用。公开 local 客户端不发请求。 |
| 实验生命周期 | [window-warm-settings.ts](../../../../apps/electron/src/main/window-warm-settings.ts) 使用初始值为 false 的模块变量                              | 应用重启后预热恢复关闭。                                                                                           |
| 目标准备     | [window-warm-service.ts](../../../../apps/electron/src/main/window-warm-service.ts) 要求 macOS、local 模式且实验已开启                           | 开启开关不等于目标已经准备好，尤其是在非 local 模式。                                                              |
| 准备机会     | [window-preparation-intent.ts](../../../../packages/components/src/lib/window-preparation-intent.ts) 对会话行意图等待 150 ms；菜单挂载时开始准备 | 立即 Cmd 点击可能来不及准备；只有一个槽位，显示后才补充。                                                          |

统一确认是已经确认的实现行为，不能据此断言仍有附件上传。不能通过关闭所有退出保护或直接销毁
窗口来隐藏提示。[发送决策](../../implemented/simplification/2026-09-29-remove-session-send-journal.zh.md)
明确暂存发送由 renderer 持有，且没有持久化。

## 打开性能与建议顺序

[已有产品路径基准](../../../../packages/components/benchmarks/window-bootstrap/README.md#macos-production-preparation)
在 M4 Max、3,000 条合成历史下记录：准备命中时显示中位数 32.50 ms、输入确认 82.46 ms；
立即点击时分别为 451.13 ms 和 492.84 ms。点击前准备本身需要 404.42 ms，另有会话行的
150 ms 防抖。这是九月、旧运行时与 CLI 的测量，用于说明机制，不能代表本次报告的实际耗时。

1. **先诊断保护原因。** 复现只查看、不操作的附属窗口，并记录实际否决者。增加本地、数量受限的
   原因诊断，包含暂存发送数量与编辑器保存状态，不记录消息文本或文件内容。如果应用的两类保护
   都不能解释，再检查受影响 renderer 的依赖监听器。保留“留下／离开”和未保存数据保护。
2. **测量真实操作路径。** 区分未启用、冷开、外壳命中、目标准备中、目标已就绪五种情况。分别记录
   输入、IPC 接收、运行时就绪、历史就绪、初始滚动／布局、原生显示与输入框可用。覆盖零提前量、
   菜单打开、连续打开、长历史和 RSS，不能只报告已就绪命中。五秒兜底显示表示就绪未完成，
   不是应该盲目缩短的正常加载预算。
3. **在资源预算内提高准备覆盖率。** 评估开发者开关是否应持久化，以及高置信意图能否更早触发准备。
   持久化隐藏 renderer 的偏好改变产品行为，需要修订 Spec。增大池或移除 local 限制并非已经确认
   安全的修复，应先测量内存并审查推测性副作用。
4. **通过共享数据所有权降低未命中成本。** 延续
   [已准备视图提案](2026-09-23-prepared-session-surfaces.zh.md)：一个应用生命周期内的文档／投影
   所有者，各窗口只订阅范围受限的首屏历史和带版本的增量。导航、滚动、选区、草稿仍归视图所有。
   命令交给既有权威写入者；替换各 renderer 独立的 Repo／游标之前，先设计持久化确认、重连代次
   和崩溃恢复。只共享整份 JSON 历史仍会重复投影和渲染，不能解决全部成本。

单独将 BrowserWindow 换成 BaseWindow/WebContentsView，不能消除各 renderer 的文档导入和布局。
现有窗口契约要求源会话保留，因此搬走唯一实时视图属于另一种操作。让暂存附件发送跟随应用而非
窗口存活，也会改变当前取消／持久性契约，应单独决策，不能作为共享只读投影的附带变化。

## 验证与限制

检查了当前检出及已安装 Nightly 0.103.0-nightly.8 的代码，没有访问会话内容或修改已安装应用。
其框架版本为 Electron 43.7.6。同版本隔离探针使用临时配置与合成 HTML：无监听器、未触发的
编辑器式监听器、已经移除的暂存发送监听器都能直接关闭；启用的暂存发送式监听器会否决关闭。
探针等待原生关闭事件，没有使用 sleep。这验证的是 Electron 语义，并非完整应用或报告现场。

初步只读调查时，当前检出未安装依赖，未运行应用性能基准、类型检查或产品测试。后续
[实现与评估](../../implemented/architecture/2026-10-04-shared-desktop-session-owner.zh.md)
在独立且依赖完整的克隆中完成。上文尚未实现的建议仍属提案，不表示存在 PR 或人工批准。
