# Nightly 会话切换阻塞渲染主线程

Status: implemented
Translation: current

[English](2026-10-20-nightly-session-switch-blocking.md)

## 摘要

原生 Nightly trace 中，12 次会话切换点击的呈现耗时为 96–271 ms，中位数 191 ms。React 同步渲染／提交、滚动强制布局和语义可见性检查占主导，重复控制器和过早订阅进一步放大更新。修复复用工具栏控制器，将编辑订阅收回编辑器，稳定表面 ref／事件，保留固定 CSS 并收窄提示刷新，惰性挂载子会话正文，并限制静态 Markdown 解析复用。浏览器探针与隔离应用验收区分了已证实的重复工作和未经验证的收益；原生历史就绪等待与极端首屏负载仍是独立边界。

## 范围与来源

本调查在[托管页面切换调查](../../proposed/architecture/2026-10-17-session-switch-rendering-cost.zh.md)之外补充独立的原生录制，不改写此前的 owner 读取修正或四秒就绪观察。[滚动引擎决策](../../implemented/architecture/2026-09-27-conversation-scroll-engine.zh.md)仍是行为契约。

用户提供的 `Trace-20261020T161455.json.gz` 开始于 2026-10-20 08:14:55.200 UTC，约八秒内有 164,257 个事件。压缩文件 SHA-256 为 `a5493d631325215f3b3be96597fb30c813fd6db6c365839cbc75dff80d2efc1f`。渲染进程 PID 为 2198，主线程为 31877262。已安装应用中与 trace URL 匹配的 `main-C6-XEjWR.js` 的 SHA-256 为 `ab0c182fbf998cd5b62c76e1ccf0a4816e0449c12643e745483ef91a4505a45d`。

包元数据声明 `0.105.0-nightly.0`、build 114 和 2026-10-10 构建时间。这只是包元数据，不能证明产物对应当前 checkout。实际 bundle 确认了被测的 `clientHeight` getter、滚动事务路径和语义路由在 layout effect 中无条件刷新的行为。当前 checkout 的路由已有更新的交互逻辑，其精确运行成本未测量。

笔记只保留汇总证据。附件保持忽略，提取的 bundle、原始 trace 和分析资料留在 Git 之外；不把对话或截图转为夹具。

## 实测成本

| 边界 | 观察 | 含义 |
| --- | --- | --- |
| 十二次点击交互 | EventTiming duration 为 96.0–271.1ms，中位数 190.9ms | 输入到下一次呈现，不代表完整历史或打字就绪。 |
| 点击派发 | 53.6–223.0ms，中位数 144.4ms，合计 1,661.7ms | 几乎整个派发都包含同步微任务 flush。 |
| 排除 profiler 启动后超过 50ms 的渲染线程调度任务 | 17 段，总计 2,020.1ms，减去各段前 50ms 后为 1,170.1ms | 来自 trace 的阻塞指标，与 Devbar BLK 定义分开。 |
| React 工作 | `performWorkOnRoot` 包含式 CPU 采样约 3,373ms，同步 render 约 1,888ms，commit 约 1,527ms | 存在嵌套重叠，不能把本表各行相加。 |
| 滚动 `afterCommit` | 包含式采样约 504ms，视口 getter 约 464ms | getter 的大部分成本是读取强迫浏览器执行的样式／布局。 |
| `readViewportHeight` 触发的样式／布局 | 248 个事件，包含式事件时长之和 470.5ms，去除嵌套重叠后约 464.9ms | 最贵的一次布局为 38.7ms。 |
| 语义路由 `paint` | 包含式采样约 174ms，可见性检查触发 95.8ms 样式／布局 | layout effect 刷新、DOM 扫描和可见性读取都发生在绘制之前。 |
| React HTML 替换 | `innerHTML` setter 自耗时采样约 280ms；898 次更新路径的 `ParseHTML` 合计 178.9ms | 已存在的元素被反复解析；trace 未标识所属 React 组件，也未证明内容未变化。 |
| 其他采样路径 | Markdown `parse` 约 126ms，垃圾回收约 155ms，`loadReplica` 约 101ms | 并非这份录制的主要成本。`loadReplica` CPU 不代表 owner／网络等待。 |
| 浏览器绘制 | 880 次 `Paint` 合计 47.3ms | 单纯绘制成本明显小于同步 render／commit 工作。 |

**归因细化：**十二次点击派发区间内有 202 次更新路径 HTML 重解析，合计 42.4ms，`innerHTML` 自耗时采样约 69.5ms。派发之外另有 696 次更新重解析，合计 136.5ms，setter 采样约 210.5ms；其中可能既有切换后续工作，也有独立更新。不能把整段 280ms setter 成本或全部 898 次事件都归给点击处理器，也不能直接认定全部可避免。

Devbar 的[采样实现](../../../../apps/electron/src/renderer/src/devbar/index.tsx)把 BLK 定义为上次成功采样以来每个长任务的**完整时长之和**，采样周期名义上约一秒。它不是磁盘 I/O 阻塞，也没有像标准总阻塞时间那样减去每段前 50ms。繁忙任务同时阻止动画回调，直接拉低显示的 FPS。当前空闲快照恢复 60 FPS，并不否定切换录制中的卡顿。

开头 455.8ms 的渲染线程任务包含 450.5ms 启动 CPU profiler，必须从会话切换延迟和预期节省中排除。录制开销也影响其他测量，不能据此声称设备总体分位数或无采样基线。

复现分析时，按进程和 profile ID 合并 `Profile` 与 `ProfileChunk`，chunk 来自 profiler 线程，不能按原主线程 ID 过滤。用 `timeDeltas` 推进采样时间，按调用帧身份汇总 self time；包含式统计对每个采样中的函数名去重，避免重复计算递归 React 栈。样式／布局按发起栈帧归组并去除嵌套区间重叠，点击派发与 `EventTiming` 对照，不能累加嵌套事件。

## 职责与可能机制

[React 滚动器适配层](../../../../packages/components/src/components/ai-gui/conversation-list/engine-conversation-scroller.tsx)在每次 commit 的 layout effect 中调用 `afterCommit`，host 读取 `clientHeight`。[控制器](../../../../packages/components/src/lib/conversation-scroll/controller.ts)的初始事务和 `isSettled` 都可能刷新视口几何，后者明确强制刷新。因此，其他组件改脏文档后，即使列表看似未变，快速路径也可能成为同步布局边界。

[语义路由 Hook](../../../../packages/components/src/lib/commands/use-semantic-action-router.ts)也在每次 commit 后刷新。[路由](../../../../packages/components/src/lib/commands/semantic-action-router.ts)扫描阻挡弹层及操作区域、检查可见性并更新激活区域属性，监听整个 body 的 MutationObserver 还会带来额外刷新。实际部署 bundle 的可见性读取触发过单次约 15ms、涉及约 2,890 个元素的样式重算。

trace 支持同一输入任务内出现 React DOM 更新、同步滚动测量、后续更新和语义可见性读取。移除一个读取者不一定消除布局，其他读取或浏览器帧仍可能需要完成它。语义路由是受 `semanticShortcutsEnabled` 控制的开发者 beta，并非所有配置都会承担的成本。

## React 源码与关键路径

安装 bundle 确认 React 和 React DOM 均为生产版 19.2.0，其实现与对应版本的上游[根调度器](https://github.com/facebook/react/blob/v19.2.0/packages/react-reconciler/src/ReactFiberRootScheduler.js)、[工作循环](https://github.com/facebook/react/blob/v19.2.0/packages/react-reconciler/src/ReactFiberWorkLoop.js)、[memo 协调](https://github.com/facebook/react/blob/v19.2.0/packages/react-reconciler/src/ReactFiberBeginWork.js)和 [DOM 属性更新](https://github.com/facebook/react/blob/v19.2.0/packages/react-dom-bindings/src/client/ReactDOMComponent.js)一致。

```text
点击 → 根调度微任务 → 同步 render
     → DOM mutation → layout effect
     → 同步 lane 的 passive effect → 新的同步工作 → 呈现
```

`processRootScheduleInMicrotask` 会排空待处理同步工作，`performWorkOnRoot` 对阻塞工作选择同步渲染。`flushSpawnedWork` 可以执行同步 lane 的 passive effect，并在返回前继续排空新同步更新。因此，仅把工作从 layout effect 搬到 `useEffect`，不能证明下一帧已解除阻塞。trace 约有 2,405.5ms 经过调度微任务入口，仅约 42.3ms 经过显式 React DOM 同步 flush 入口；内部函数名 `flushSyncWorkAcrossRoots_impl` 不代表应用到处手动调用了 `flushSync`。此处采样到的显式调用来自选区指针处理（约 34.5ms）和滚动 ResizeObserver 修正（约 7.8ms）。

| 采样阶段 | 整段录制 | 十二次点击派发内 |
| --- | ---: | ---: |
| 同步 render | 1,887.9ms | 750.9ms |
| DOM mutation effect | 476.0ms | 146.5ms |
| layout effect | 707.5ms | 351.0ms |
| passive effect | 314.7ms | 227.9ms |

这些是包含式采样路径，不是可直接相加的阶段独占时间。在 layout effect 采样内部，互斥归因得到滚动器 504.1ms、语义提示刷新 149.0ms、其余 54.5ms，前两者约占该阶段采样的 92%。passive effect 包含发布会话查看 presence 约 49.6ms、Machine Flock 消费者清理约 40.8ms、组织重试设置／清理约 41.8ms；这些采样不代表网络等待。

## 放大更新的业务组件

最大的具名业务 render 入口是 `SessionChatInterface`，包含式采样约 199ms；`SessionDetail` 约 68ms，`SessionChatInputArea` 约 54ms，`ChatComposer` 约 47ms，Markdown 约 123ms。这是函数／Hook 入口采样，不是完整 React 子树耗时或渲染次数。Base UI 通用 `FastComponent` 另占约 122ms，关闭态控件及其 Hook 也有成本。Hook 依赖比较自耗时约 96ms，context 传播约 74ms，两者大部分位于点击派发之外；仅凭这些总数不能确定是谁发起更新。

以下模式存在于部署 bundle 和基线 checkout `a27a34c9e`：

| 边界 | 已确认的源码行为 | 影响与限制 |
| --- | --- | --- |
| [会话属性](../../../../packages/components/src/components/sessions/session-detail.tsx)的 `getSharedChatSurfaceProps` | 父级每次 render 都创建新的 callback ref 和若干操作闭包。 | React memo 同时要求 props 相等及 ref 相同，仅变化 ref 就会阻止跳过渲染，也会改变 `useImperativeHandle` 的实际依赖。其他 props 仍变化时，只稳定 ref 不够；真正改变会话身份时仍需渲染。 |
| 同文件的桌面工具栏 | `desktopHeaderToolbar` 使用 `hideMessageArea` 和 `headerVariant="toolbar"` 挂载完整 `SessionChatInterface`，正文另有一个实例。 | [聊天接口 Hook](../../../../packages/components/src/components/sessions/session-chat-interface.tsx)在 JSX 隐藏消息区之前执行，只显示头部仍运行许多聊天控制 Hook。trace 没有把其成本从合计 199ms 中单独分离。 |
| 聊天接口中的编辑 mention source | 编辑器尚未打开就传入 `enableCodeCollabProvider: true`，包括仅头部实例。 | 该组件下 `useSessionMentionSource` 采样约 40ms。如果把获取移到编辑边界，仍需保留编辑器首开就绪。 |
| [Mention 展开](../../../../packages/components/src/components/mentions/mention-expansion.ts) | 消息流编辑、输入区和 composer 各自调用展开 Hook，涉及会话、Role、Skill 目录。 | 路径包含式采样约 83ms。[已有共享 item 缓存](../../../../packages/components/src/components/mentions/mention-session-source.ts)避免了部分重复 slug 构造，没有消除各消费者自身的 Hook 与订阅。 |
| [旧 ScrollArea 包装](https://github.com/LodyAI/Lody/blob/683aaec1fe8cb9f1f1eb18ee447b8cd8341a1697/packages/components/src/ui/scroll-area.tsx) | Radix 1.2.10 的 viewport 每次 render 都返回新的 `dangerouslySetInnerHTML` 对象，其 CSS 固定。 | React 将其视作属性变化，再次写入 `<style>.innerHTML`。这是已确认的冗余生产者，也是部分重解析的候选，尚不能认定它拥有全部 898 个事件。 |

React DOM 在进入 `setProp` 前按对象身份比较 `dangerouslySetInnerHTML` wrapper，setter 赋值时不再比较内部字符串。部署的注册表 `InlineSvg` 已共享 wrapper，下述浏览器对照验证了这一实现的作用，不能再次建议已有 SVG 修复。其他候选包括 Mermaid markup 和旧 ScrollArea CSS，需要定位宿主元素后才能分配实测收益。CPU 栈的 `commitHostUpdate` 没有 Fiber／组件身份，无法还原缺失的归属。

## 合成浏览器验证

独立本地页面在无头 Chromium 154 中运行生产 React／React DOM 19.2.0 和实际 Radix ScrollArea 1.2.10，只使用合成 markup、原生 `innerHTML` setter 包装及真实 React DOM root。挂载后更新二十次，观察到：

| 场景 | setter 写入次数 | 与上次赋值字符串相同的次数 |
| --- | ---: | ---: |
| 每次 render 新建 SVG wrapper | 20 | 20 |
| 稳定 SVG wrapper | 0 | 0 |
| 实际 Radix viewport | 20，全部写入 `style` | 20 |
| 稳定 CSS wrapper 对照 | 0 | 0 |

另一组 memo 包装的 `forwardRef` 会话面在二十一次父级渲染中保持普通 props 不变：每次新建 callback ref 导致二十一次会话面 render，稳定 ref 只 render 一次。这证明 ref 身份变化单独就能阻止 memo，不代表稳定它以后应用的所有更新都会消失。

一次真实浏览器点击触发状态、layout effect 的状态修正及 passive effect，观察顺序为 `click → layout(false) → passive(false) → layout(true) → passive(true) → animation frame`。它在生产版确认了下一帧之前继续更新的机制，没有添加延迟，也没有使用墙钟断言。

实验源码、bundle、依赖锁和汇总结果留在 Git 之外的 `/tmp/lody-react-hotspot-probe/` 及 `/tmp/lody-react-hotspot-{results,phase}.json`。源码 SHA-256 为 `ea5c77dd75b1f3f3f27e98009a4452a9134e3045de82afbb33af2d374772cd4a`。实验验证可观察的更新行为，不测 Nightly 延迟、真实对话、其精确 Chromium 构建或可节省毫秒数。

## 已采用的修复与验证

桌面标签栏通过 portal 复用已有的根会话控制器，不再为了几枚按钮挂载第二个完整控制器。头部元数据仍属于根会话，搜索、复制、重命名、分叉、归档和分享动作仍指向当前选中的标签。会话表面的适配器保持 imperative ref 与浏览器、模拟器、分叉事件回调稳定，并转发最新提交的处理函数；其他数据或工具栏 props 改变时，仍不保证 memo 可以跳过渲染。

聚焦 Tab 切换的补充调查确认另一项持续变化的 prop：批注提交回调工厂在父级每次 render 时都返回新函数。会话适配器现在也稳定批注、评论、PR／变更及会话导航事件，并转发最新提交的处理函数，保留可选动作是否可用的语义。工具栏对象与侧栏按钮 JSX 按实际输入记忆，避免无关父级更新继续使根控制器失效。

桌面子会话正文在 URL 首次选中时挂载，并在当前根会话内保留；工具栏仍由根控制器提供。等待历史就绪的分叉目标保留显式预挂载例外。已访问标识在既有 render-phase 会话重置分支清空，关闭标识被移除，实际挂载／卸载仍走原有 store 借用与释放。这不改变传输所有权、持久化策略、就绪门槛或错误交付，也不增加资源缓存。标识集合记录已挂载历史，并非第二份选中状态。

桌面会话容器具有 absolute inset 确定的尺寸，加入严格 CSS containment，让内容不再参与外壳的固有尺寸计算，无需删除有效滚动测量。未选中表面继续使用 `display: none`，既有隐藏暂停、resize／重新显示路径与阅读锚点协议保持原状；无需将隐藏机制改为 visibility／content-visibility。

随后对 30 次切换的采样定位到约 570ms 的 `react-markdown` 解析包含时间，相比之下布局约 99ms、绘制约 66ms；这些诊断采样值不作为验收延迟。重新打开内容未变的结束消息仍会完整解析 Markdown。静态渲染器现在按固定语法配置持有窗口级原始 AST LRU，各配置最多 64 项、1,048,576 个源字符与 8,192 个节点；超过 131,072 字符的输入不保留。下游转换前复制语法树，不保留 React 元素、回调、VFile 或转换后的 HTML。流式前缀绕过缓存；HTML 清理、URL 策略、自定义组件、数学公式、引用与搜索仍针对当前消费者执行。

该缓存没有 I/O 生命周期、失败集合、就绪门槛或会话资源租约；解析失败不进入缓存，淘汰仅导致重新计算。初始化断言要求已安装解析器，两套固定配置中 react-markdown 的 `remark-parse` 阶段均先于缓存插件。行为测试覆盖消费者修改后仍返回新 AST、语法配置隔离、项数／字符／节点预算淘汰、超大输入绕过、解析失败后恢复，以及重挂载时重新应用 HTML 策略。


编辑并重发的文件来源与目录展开订阅只在编辑器挂载期间建立，消息流不再为了关闭的编辑器订阅目录。保存时先展开原始输入，再 trim，并重定位 span 后提交。普通输入框的发送与剪贴板消费者仍然独立，没有增加全局 store 或条件 Hook。

既有 Radix 1.2.10 补丁在 ESM 与 CommonJS 中共享固定 CSS 包装对象，保留此前的滚动轮询清理。CSSOM 测试验证真实内容更新后 stylesheet 与解析规则身份不变，并保留滚动结束、卸载清理覆盖；锁文件只更新补丁 hash。

语义关闭提示不再每次 React 提交或普通消息内容变化都扫描可见性，只观察作用域、菜单、模态层及其祖先可见性变化，包括 class/style。一次 paint 复用一份可见性快照。关闭命令仍实时检查当前可见性和阻挡层，即使 MutationObserver 尚未交付也不能关闭背景内容。指针、键盘、重置、延迟激活和清理契约继续由行为测试覆盖。

滚动引擎的几何测量、锚点、resize/coverage 检查与唯一写入者保持原状；删掉有效读取可能掩盖问题并造成视口错误。这些 React 所有权与固定 CSS 改动无需引入 Effect 生命周期迁移，资源借用与释放继续由既有缓存负责。

应用验收使用两个独立构建、版本锁定的 OSS Electron checkout，真实 main/preload/renderer、内置 CLI、独立临时用户目录，以及通过真实 UI 配置的确定性外部 ACP fixture。没有修改用户 Nightly、账号或会话内容。合成种子关闭后分别复制给 before/after；Playwright 录制整个应用窗口，CDP 运行时快照、EventTiming、帧间隔与原生 HTML setter 插桩提供汇总证据。两端均承受录像和插桩开销，数值不代表用户 Nightly 的原生延迟。

## 首轮应用验收

最终验收使用冻结脚本（SHA-256 `aa159fc0da9037edd9b3ef4408306bcd21acfed86b1412aafe76a6afa85db592`），分别复制同一份已关闭的 12 会话种子（回复为 8/32/64 KiB），两端各点击侧栏切换 240 次，均通过草稿隔离、工具栏宽度切换、搜索、重命名／取消。基线为 `a27a34c9e`；最终源码摘要分别为 `c04ddc91390084172a25fd3bf77b8421dc3768840a648ff28c233fa7196dcd7e`（before）和 `cde9f468c6d5ebc265d8f417728b1e709e3f20cf68c27d007bdd9e5184319363`（after）。

| 最终成对测量 | Before | After |
| --- | ---: | ---: |
| 相同 `<style>.innerHTML` 写入 | 1,685 | 0 |
| 测量循环内渲染线程任务 CPU | 17.512 s | 15.702 s |
| 点击呈现 p50 / p95 | 72 / 88 ms | 64 / 80 ms |
| 点击处理 p50 / p95 | 35.75 / 48.8 ms | 31.3 / 43.8 ms |
| 长任务次数／总时长 | 12 / 640 ms | 5 / 294 ms |
| 标准 TBT（各长任务扣除前 50 ms） | 40 ms | 44 ms |
| 动画帧间隔 p95／最大值 | 32.5 / 34.3 ms | 17.7 / 50 ms |

该轮任务 CPU 下降约 10.3%，长任务总时长下降约 54.1%；TBT 和最坏单帧未改善，因此结论是减少重复工作，不保证每个尾部样本都更快。此前一轮为相同 CSS 写入 1,858→0、长任务总时长 2,395→362 ms，但两端呈现中位数同为 72 ms，说明数值对轮次和阈值敏感。时间观察不作为单元测试门槛。测试窗口隐藏且关闭后台节流；rAF 间隔是渲染观察，不是物理屏幕 FPS。成对比较循环没有运行 CPU sampler。

独立 after soak 通过 1,000 次 Playwright 侧栏切换、300 次逐帧 DOM 点击导航、会话草稿恢复及最终路由／输入目标。GC 后 DOM 节点为 3,009→2,973，document 保持两个，监听器为 936→937，JS 堆为 85,340,496→104,551,804 字节；这个有限轮次不能证明不存在堆保留。独立 beta 流程通过 24 次切换、原生应用菜单关闭草稿标签且保留根会话，以及 12 轮真实发送／回复。自定义 ACP Provider 按契约不显示 builtin 专属编辑动作；编辑由真实编辑器组件测试覆盖 mention 展开、trim／span 重定位及 IME 抑制，不声称录到了 builtin Provider 的编辑视频。Before/after 均成功恢复 256 KiB 消息、读取完整 262,220 字符并输入草稿；此前整页文本匹配超时不能作为应用卡死的诊断。

验证：两端 OSS 应用构建通过；聚焦测试 103 项通过；最终组件套件在排除已知 boot-shell 文件后，585 个文件、5,710 项通过。根类型检查、lint、Effect lint、i18n 和全部边界检查通过。根 `pnpm check` 停在既有 Git identity 测试失败（CLI 的 4,428 项通过）；boot-shell 的 storage-unavailable 断言也失败，两者均在未修改的 before 版本复现。`pnpm format`、定向 Oxfmt 和 `git diff --check` 通过。文档检查只剩旧 subagent-events 笔记中 Kimi/Pi 的六个既有断链，没有受保护主题哈希变化。

原始合成证据在 Git 外的 `/tmp/lody-session-switch-acceptance/`，冻结脚本为 `/tmp/lody-session-final.mts`。可下载的并排／原始／工作流视频及汇总报告位于被忽略的 `.lody/attachments/session-switch-performance/`。并排版从两端原片第十秒各取 25 秒，以原速展示，不逐次对齐每个交互；时间归因以 JSON 测量为准，不能比较剪辑总长度。

## 状态与订阅所有权

本路径以 React 本地状态和 TanStack Router 管理视图与路由身份，Jotai 原子／选择器管理应用 UI 和 runtime 句柄，Loro CRDT 与 Mirror 管理会话控制状态，Flock 管理元数据／文件索引，窗口化 ConversationView 管理历史。`useSessionDoc` 通过按帧合并的 React 状态适配外部订阅，runtime 分别保留热文档和传输订阅。这是多个订阅所有者，并非单一 Zustand/Redux store。

React 的 [memo 指南](https://react.dev/reference/react/memo)强调本地所有权和稳定输入，[Effect 指南](https://react.dev/learn/you-might-not-need-an-effect)反对反复镜像派生状态的更新链。此次将工作放到实际挂载的消费者，并删除重复提交工作；URL、输入框与命令目标同步切换，不延迟整个会话，也不新增 Effect 镜像状态。

## 聚焦 Tab 与会话切换的最终验收

独立冻结轮次将上一轮修复与本次最终改动比较，不再以 `a27a34c9e` 为基线。脚本 SHA-256 为 `4d4ea75a27ec56741797a72c3429efaff13da905bc36f48262984cf00f6ca94d`。两端分别复制同一份十二会话、四个持久化子标签的种子，核对实际渲染的 8/32/64 KiB 回复，各执行 160 次侧栏会话切换与 160 次正文 Tab 切换。测量循环不运行 CPU sampler 或 Playwright DOM 快照录制，两端均保留视频及被动观察器。三个源码文件的摘要与原始观察由 JSON 制品保存。

| 成对观察 | 上一轮修复 | 最终版本 |
| --- | ---: | ---: |
| 会话点击处理 p95 | 79.5 ms | 30.2 ms |
| Tab 点击处理 p95 | 30.4 ms | 14.1 ms |
| 会话点击呈现 p50／p95 | 72 / 120 ms | 56 / 72 ms |
| Tab 点击呈现 p50／p95 | 72 / 72 ms | 56 / 56 ms |
| 会话循环最大帧间隔 | 68.6 ms | 18.7 ms |
| 会话循环超过 25ms 的帧 | 42 / 864 | 0 / 650 |
| 两类循环长任务次数／总时长 | 28 / 2,163 ms | 0 / 0 ms |
| 两类循环标准 TBT | 763 ms | 0 ms |
| 两类循环渲染线程任务 CPU | 18.005 s | 10.499 s |

两端帧间隔 p95 仍约 18.5ms，因此证据支持处理耗时、尾部帧和长任务改善，不表示所有分位数都改善。独立的 30 次切换采样中，解析包含时间从 570.3 降到 4.1ms，布局仍约 98ms、绘制约 64ms，确认复用了纯解析工作，没有删除必要几何。时间仅用于诊断，不作为回归测试门槛，也不是物理屏幕 FPS 测量。

最终 soak 额外通过 500 次 Playwright 会话切换、500 次 Tab 切换、150 次逐帧会话 DOM 点击与 150 次逐帧 Tab DOM 点击。两类逐帧突发均无长任务；会话帧间隔 p95／最大值为 18.5／34.2ms，Tab 为 18.4／18.7ms。会话突发仍有一帧超过 25ms，不能承诺所有帧或所有硬件绝无卡顿。相同热状态下，GC 后节点／监听器／堆字节从成对测量后的 5,457／1,300／98,640,112，变为 soak 后的 5,458／1,302／106,651,380；document 始终为两个。这一有限观察不能证明不存在保留问题。

应用验收通过逐标签草稿隔离、隐藏／显示与路由卸载后的语义阅读位置、选中子标签重命名及实际搜索高亮、宽度切换、原生菜单关闭、已关闭正文卸载与重新进入。阅读恢复比较同一行的屏幕位置：前方行可以重新测量，而读者看到的位置不变。首次进入五标签工作区只挂载两个控制器，原来是五个；根控制器仍负责工具栏，只有选中的子标签获取正文。源码保留分叉目标预准备例外，但本轮合成自定义 provider 未执行 builtin 专属分叉。

两端均在切换测量开始前记录相同的既有启动期 RuntimeProvider 初始化 AbortError；切换运行期间均未记录 page error。

最终 OSS 应用构建、组件类型检查、作用域 lint、根 format，以及 586 文件的 5,719 项测试通过；既有 boot-shell 环境失败仍排除，Markdown 专项含 231 项通过。文档检查仍只有相同的六条旧 Kimi／Pi 链接错误。制品位于忽略目录 `.lody/attachments/session-switch-smooth/`：十六秒并排视频按阶段原速截取，不逐次同步每个交互，同时附原片、冻结脚本与汇总报告。

## 剩余边界

原始 trace 无法定位全部 HTML 重解析的宿主来源，也不能量化 owner／网络就绪等待；此前 hosted 调查的四秒等待仍是独立观察。用户 Nightly 没有 CDP 监听，未被重启；隔离应用验收没有复现它的完整数据集或构建。超大消息首屏与更多轮次／预览组件负载须与热切换分别报告。
