# 把旋转动画从 SVG 上移走，让它在 Retina 上走合成器

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/672

[English](2026-09-13-spinner-off-svg-retina-composite.md)

## 摘要

打包版桌面端在两个会话运行、页面毫无变化时，renderer 仍常驻 40–50% CPU。原因是所有
`animate-spin` 图标都直接旋转 Lucide 的 `<svg>` 本身，而 Chromium 拒绝为 effective zoom
不等于 1 的 SVG 元素在合成器上运行 transform 动画；在 Retina 屏上每个 SVG 都是如此。
于是只要有会话在忙，旋转动画就每个 vsync 在主线程重跑一次 style、pre-paint 和
layerize。现在所有 spinner 统一经由 `Spinner` 原语渲染，动画放在包住图标的 HTML
wrapper 上；agent 就绪环的不定态弧线也从 SVG `<g>` 移到 span。在同一 Electron 中的受控
trace 显示动画已被合成、逐帧主线程工作消失。该模式只有一个约束：wrapper 的盒子必须
就是图标的盒子，否则旋转会变成绕圈。

## 问题与证据

2026-09-13 在打包版（Electron 39.5 / Chromium 142）、2× 屏、两个会话工作中、页面无可见
变化时实测：

- 主窗口 renderer 40–50% CPU，GPU helper 5%。CPU profile 里 JS 只占 1%，其余是 Blink
  的 `UpdateLayoutTree`、`PrePaint`、`Layerize`、`Commit`，每个 vsync 一次（120 Hz 下
  6 秒 719 个主线程帧）。
- 用 `document.getAnimations()` 暂停 sidebar 里的两个工作中 spinner 后，主线程忙碌降到
  3.5%；在同样位置放两个 `<div class="animate-spin">`，开销接近零。
- `blink.animations` trace 报告这些动画 `compositeFailed=1088`，其中 bit 10 是
  `kTransformRelatedPropertyCannotBeAcceleratedOnTarget`。

## 根因

`CompositorAnimations::CheckCanStartTransformAnimationOnCompositorForSVG` 会拒绝
`EffectiveZoom()` 不为 1 的 SVG 元素上的 transform 动画（crbug.com/1186312）。Blink 把
device scale factor 乘进 layout zoom，所以 DPR 2 下每个 `<svg>` 的 effective zoom 都是
2，动画回落到主线程。HTML 元素没有这个限制。该检查同样覆盖 SVG 内部元素，因此
`<g class="agent-readiness-orbit">` 的弧线也是同样下场。Tailwind 的 `animate-spin`
只是普通的 `rotate(360deg)` keyframe，唯一的变量是它挂在哪个元素上。

### 这算谁的缺陷

主要在上游，但只是部分。这个拒绝是有意的能力判定，而非计算错误：合成器无法复现 Blink
对 SVG 的 zoom 相关 transform 解析，与其冒险画错，不如放弃并把动画交还主线程。渲染结果
在视觉上仍然正确，错的只是开销，因此它是一个「带有保正确回退的优化缺失」，而不是渲染
缺陷。追踪于
[crbug.com/1186312](https://issues.chromium.org/issues/40172437)；其当前处理状态未经
核实，因为该追踪器需要登录。

图标库并不背锅。`lucide-react` 调用 `createElement("svg", ...)` 并把调用方的
`className` 合并到该根元素上，这是图标组件的正常行为；而且下文的受控 trace 在页面中
完全没有 `lucide-react`、只用手写 `<svg>` 时同样复现了失败。元素类型才是唯一的区分点。

我们的用法同样普通——给图标加 `animate-spin` 是多数 Tailwind 应用的写法——所以让它变贵
的是运行条件而非这个写法本身：device pixel ratio 为 2，这是触发的必要条件；120 Hz 屏幕，
使每秒开销翻倍；spinner 会在会话运行的数小时内一直挂载，而不是几百毫秒；每个运行中的
会话一个；以及 Electron，其 renderer CPU 会直接体现为耗电。同样的标记在 60 Hz 非 Retina
屏上是免费的，这也是为什么代码评审永远抓不到它，而 CPU profile 可以。

即使浏览器修复了也保留这个 wrapper。桌面端随 Electron 锁定的 Chromium 版本发布，上游
修复要很久才能到达用户，而 wrapper 本身没有成本。

## 决定

- `packages/components/src/ui/spinner.tsx` 是唯一施加 `animate-spin` 的地方。它渲染
  `<span class="inline-flex shrink-0 … animate-spin will-change-transform">` 包住图标，
  图标用 `size-full` 填满 span。尺寸、外边距、颜色类都放在 wrapper 上，使其盒子就是
  图标的盒子；`icon` 与 `spinning` 让刷新图标复用同一元素、仅在请求进行中旋转。
- `packages/components` 里所有直接写 `<Loader2 className="… animate-spin">` 的位置
  （247 处）由 codemod 改写；约二十处条件旋转或动态图标的位置、`Loading` 原语、emoji
  picker 的 loader、同步指示器和两个本地项目状态面板手工转换。包内不再有任何
  `animate-spin` 落在 `<svg>` 上。
- `AgentReadinessMark` 把静态轨道环和确定态填充留在同一个 `<svg>` 里；不定态弧线单独
  一个 `<svg>`，放进绝对定位的 `<span class="agent-readiness-orbit">`。
- `tailwind/index.css` 里其它无限动画（`agent-activity-dot-pulse`、`animate-badge-pulse`、
  `animate-progress-sweep`）本就作用在 HTML 元素上，未改动。`svg.animate-spin` 基础规则
  保留作为漏网之鱼的兜底。
- 规则已写入 `packages/components/src/ui/AGENTS.md`。

## 备选方案

- 只包 sidebar 那一个 spinner。能修掉实测的这例，但同步指示器、连接卡住横幅、移动端
  状态胶囊、各种活动状态里的长驻 spinner 仍走同一条路，也挡不住下一个
  `<Loader2 className="animate-spin">`。单一原语才能让规则可执行。
- 纯 CSS 圆环 spinner。同样能合成，但会全局改变图标外观，也无法承载那些条件旋转的
  刷新/旋转图标。
- 在 `prefers-reduced-motion` 下暂停。不是修复，只是对关闭动效的用户隐藏了开销。

## 后续：原语的默认值是转发陷阱

迁移复查发现，`Spinner` 把 `spinning` 默认为 `true` 在调用点是安全的，但经过包装组件
就不是：`undefined` 与「未传」无法区分，因此转发自身可选 `spinning` / `spin` 属性的
状态面板在其余所有状态都会落到该默认值——桌面端与移动端的「No machines available」
面板，以及移动端文件浏览器的「Files unavailable」、空文件夹和预览不可用面板，图标都在
永久旋转。三个面板辅助组件现在把该属性默认为 `false`。

原语保留 `true`：在它几乎所有调用点上，裸写 `<Spinner />` 就表示「加载中」，翻转默认值
只会让这些调用点失声。「转发用的包装组件必须自带默认值」这条约束已写入 `src/ui/AGENTS.md`
和属性本身的注释。其余九处转发传的是比较表达式或必填布尔值，已确认不受影响。

## 验证

- 在本工作区的 Electron 39.5.1 / Chromium 142.0.7444.265、主显示器 scale factor 2 上，
  通过 `webContents.debugger` 的 `Tracing.start`（`blink.animations` + `devtools.timeline`）
  做受控 trace，2 秒窗口，两个 12 px spinner：

  | 标记                            | compositeFailed | UpdateLayoutTree | PrePaint | Layerize | Commit |
  | ------------------------------- | --------------- | ---------------- | -------- | -------- | ------ |
  | `svg.animate-spin`（改前）      | 1024            | 244              | 248      | 243      | 244    |
  | `span.animate-spin > svg`（现） | 无              | 7                | 6        | 5        | 7      |
  | 无 spinner                      | 无              | 3                | 5        | 5        | 6      |

  Playwright 的 headless Chromium 145.0.7632.6 在模拟 DPR 2 下两种写法都能合成，说明该
  检查可能随版本或模拟方式不同；决定以与发布运行时一致的 Electron 实测为准。

- `tests/spinner-rotates-in-place.test.tsx` 还渲染桌面端与移动端机器选择器，以及不带
  provider 的移动端文件浏览器，断言静止态没有动画、加载态恰好一个，因此「干脆不转」的
  修法同样会失败。它对 sidebar 工作行、同步指示器、移动端状态
  胶囊和 `Spinner` 原语断言：唯一的动画元素是 HTML span、显式正方形、`shrink-0`、只含
  图标，且图标本身不再旋转。PR 标签页刷新和 sidebar PR 徽标测试已适配 wrapper。
- 在 macOS 上运行了 `pnpm check` 与 `pnpm format`；未在打包版中带真实会话重新剖析。
  上述 trace 使用与组件相同的标记和 CSS，在相同的 Chromium 中运行。
