# 面向桌面窗口的已准备会话视图

Status: proposed
Translation: current

[English](2026-09-23-prepared-session-surfaces.md)

## 摘要

预热外壳仍需在打开窗口后加载目标历史并渲染。本提案在请求前准备数量受限、绑定目标的可交互
视图，点击时直接呈现已有内容。长期可通过共享数据所有者消除跨 renderer 的重复文档导入；
macOS GPU surface 则提供独立的视觉预览路径。macOS 专用基准原型现已测得准备好的真实会话
显示中位数约 41 ms、文字插入确认约 90 ms。第一阶段已接入可选的 macOS 本地预热路径；
共享数据所有权与 GPU 预览仍为提案。缓存未命中与独立副本仍是明确限制。

## 证据与约束

[当前修复](../../implemented/bug-fix/2026-09-22-warm-window-content-readiness.zh.md)及
[基准](../../../../packages/components/benchmarks/window-bootstrap/README.md)显示：冷文档提前合并、
布局预加载之后，3,000 条历史中位数为 430.77 ms，100 条为 256.56 ms。五次长历史样本从
调用原生 show 到 show 事件分别为 30.99、31.42、54.97、38.05、31.55 ms；就绪信号到
调用 show 约 0.2 ms。这些是探针事件计时，不是像素实际出现在屏幕上的时间。主要耗时仍在显示之前。

[窗口 Spec](../../../../specs/desktop-windows.zh.md)要求新窗口打开时源窗口不变，搬走唯一实时视图
不满足这个行为。Provider 规则现在仅允许主进程管理的 macOS 已准备窗口生命周期推测性挂载
会话，并遵循草案契约；原始快照后台预取仍然独立，不得获取会话 UI store。

## 建议顺序

1. **绑定目标的已准备视图（已接入）。** 沿用现有原生窗口，只保留一个隐藏的目标窗口。根据会话菜单
   打开或会话行悬停／聚焦提前准备。当前单槽位有过期与取消，没有最近目标缓存。提前完成真实历史加载、
   布局和滚动恢复。命中后直接显示该 renderer，不导航、不重挂载。单靠 mouse-down 没有足够
   提前量；未命中保留现有正确打开路径，报告命中率，不能把未命中排除出结果。
2. **分离视图与窗口生命周期。** 第一阶段证明收益后再考虑 BaseWindow/WebContentsView。
   视图挂入原生宿主时保留 renderer 状态。源窗口不变的重复打开仍需要提前准备另一份视图。
   搬移适用于单独定义的“移出窗口”操作；合成画面能否无缝保留仍需验证。
3. **共享数据所有权。** 评估由应用生命周期内的 utility process 或现有 daemon 唯一持有
   桌面文档及投影。视图订阅有版本、范围受限的历史投影与增量，不再各自导入完整 CRDT。
   草稿、选区、滚动和导航保持视图独立。命令发送给真实所有者，不能额外加一个乐观写入者，
   或让独立副本共用游标。此方案替换现有 Runtime 契约，须一起设计迁移、持久化写入确认、
   重连代次及所有者崩溃恢复。
4. **可选 macOS 视觉过渡。** Electron 39.5.1 的离屏共享纹理暴露 IOSurface。Native addon
   可将已渲染的目标帧复制到应用自有 GPU 纹理，用 AppKit／Metal 宿主显示，同时准备独立实时
   视图。这只加速可见内容，帧本身并不是独立可交互文档。完整 OSR 交互还需输入法、无障碍、
   输入、弹出层和焦点集成。不能把预览可见算作输入就绪，也不能推测性排队有破坏性的点击。

参考 Mac 上可将命中时输入到内容、输入到输入框可用的 P95 小于 100 ms 作为实验验收目标；
这是目标，不是预测或普适感知阈值。原生事件计时与屏幕帧证据分开报告。覆盖冷未命中、零提前量、
流式更新、目标删除、重复领取、取消、缩放、Retina／外接屏、Spaces／全屏、关闭源窗口、
崩溃恢复、RSS 与空闲 CPU。就绪状态同时匹配工作区、会话、准备代次和视口配置；重新检查目标
有效性，明确淘汰与资源所有权。推测性视图不能标记已读、发通知、抢焦点或改变共享状态。

## Native 可行性与替代方案

[Electron 39.5.1 WebContentsView](https://github.com/electron/electron/blob/v39.5.1/docs/api/web-contents-view.md)
可以接收已有 WebContents，但一份 WebContents 同时只能由一个 WebContentsView 呈现。
[BaseWindow](https://www.electronjs.org/docs/latest/api/base-window)关闭不会自动销毁挂载的
WebContents，需要明确所有权。

[utilityProcess](https://github.com/electron/electron/blob/v39.5.1/docs/api/utility-process.md)
提供 Node 进程及消息端口，不会自动共享 JS／WASM 对象。
[OSR](https://github.com/electron/electron/blob/v39.5.1/docs/tutorial/offscreen-rendering.md)
提供无需回读 CPU 位图的 GPU 输出。
[原生纹理指南](https://github.com/electron/electron/blob/v39.5.1/shell/browser/osr/README.md)
说明帧来自有容量限制的复用池，应复制到自有纹理后及时释放。macOS 句柄是进程内指针，不能把
裸指针当跨进程传输。布局尺寸、缩放及内容版本共同决定预览是否可用。

[NSWindow.animationBehavior](https://developer.apple.com/documentation/appkit/nswindow/animationbehavior-swift.property)
可禁用自动显示动画，但不能消除 React 渲染和文档准备；尚未实测其单独收益。用 AppKit 重写
对话仍需加载数据与布局，也有很高的功能对齐成本，不是第一阶段实验的前置条件。

## macOS 原型证据

[可复现探针](../../../../packages/components/benchmarks/window-bootstrap/README.md#macos-prepared-content-prototype)
让真实目标窗口按正常就绪流程准备好后继续隐藏，再通过探针专用 IPC 显示。
临时 N-API／Objective-C++ 扩展从原生 NSView 句柄取得 NSWindow，通过公开 AppKit API
关闭窗口显示动画；不随产品打包，不改变正式依赖或产品 IPC。

唯一输入标记验证下，十个已准备／native 样本从显示 IPC 到原生 show 的中位数为 40.76 ms
（32.85–75.72 ms），插入文字并在下一帧读回确认中位数为 90.15 ms（80.73–144.70 ms）。
三个舍弃的预热样本也通过。当前路径五个样本中位数为 443.82 ms 显示、490.78 ms 输入确认。
不改原生动画的提前准备路径，五个样本为 38.31 ms 显示、84.64 ms 输入；三组最终共 29 次
检查（含预热）全部通过。
请求前仍需约 409.11 ms 的准备，合成场景刻意保证 100% 目标命中。这验证了显示路径的潜力，
不是预测算法或已交付的秒开功能。

探索阶段五样本 native 显示中位数曾为 22.43 ms，更长复测未维持该数值。此前一次复测因重复
输入标记断言失败而中止，原因没有确定。修订探针要求每次输入此前不存在的唯一标记，并在下一帧
仍保留，避免已有草稿导致假通过；不重试输入掩盖失败。原生文字插入不等于物理键盘／输入法
验收。尾部输入耗时仍超过提出的 100 ms 目标，单独关闭动画的稳定收益尚未建立。
产品生命周期与副作用验证见[实现记录](../../implemented/bug-fix/2026-09-22-warm-window-content-readiness.zh.md)。
真实命中率、内存预算及签名原生扩展分发仍未验证；扩展仍仅用于探针。

## 结论

优先实验目标已绑定、完全可交互的预热视图。共享所有权作为独立架构迁移，GPU 预览作为可选
视觉机制。探针专用原生扩展不改变产品行为；第一阶段已通过现有 BrowserWindow 接入，契约保留 draft，
实现证据由链接的记录维护。文档检查仍受既有缺失子模块断链影响，
全仓检查仍因 packages/ignore 缺少依赖停止。macOS arm64 扩展已在隔离探针中编译运行，
尚未验证打包分发。
