# 可复用 Diff 渲染

## 问题

全屏和内嵌 Diff 都走 [YiTong](https://github.com/onevcat/YiTong) 的独立 `WKWebView`。每次打开文件都新建 WebContent 进程并重新加载 `@pierre/diffs` bundle，首次渲染慢，内嵌场景还自带纵向滚动，和外层 sheet 抢手势。YiTong 的嵌入配置也不够用：高度靠 KVO、字体靠注入 CSS，复用和预热做不到。

## 决定

按入口拆成两条渲染路径，RPC / ContentStore / 原生工具栏 / 导航不变。

1. **全屏 Diff**（`FileDiffScreen`）：`'use dom'` + `@pierre/diffs@1.4.1`，底层是 vendored `@expo/dom-webview@57.0.1` 的**单一 Diff 专用共享实例**。根布局预热后停泊；进入文件时接管已加载的 WebView，只重放 props，不重新导航 bundle。
2. **内嵌 Diff**（工具详情 `DiffBlock`）：LodyKit 自有 UIKit/TextKit 视图。Swift `CollectionDifference` 算行级 Myers diff，相邻删/增再做词级强调；语法颜色复用现有 `CodeHighlighter`。无内层纵向滚动，回报完整高度给外层 sheet。

不做：通用 WebView 池、DataRuntime WebView 共享、Android、绿色强调、把源码写入日志或 Debug probe。

本文件取代 [2026-09-07-diff-and-file-tree-design.md](2026-09-07-diff-and-file-tree-design.md) 里「YiTong 渲染全屏和内嵌」的决定。Machine RPC、ContentStore、2 MiB/side、页面入口与错误态仍以那份为准。

## 基线（YiTong，实施前）

现有 `changes` 验证覆盖：文件卡片 → 全屏 Diff、Unified/Split、取消返回手势、返回后取消选中。WebKit shadow-root 行不进 AX，视觉靠截图和视频。

当前实现特征（对比用）：

- 每个 `LodyDiffView` 挂载新建一个 YiTong `WKWebView`；同实例内 `update(document:configuration:)` 可换文件，跨页面不复用。
- 内嵌 `scrollEnabled=false`，高度来自 `scrollView.contentSize` KVO。
- 全屏把 `webView.scrollView` 注册给导航栏 soft edge。
- 单文件上限 2 MiB/side，与 Machine `file/preview` 文本上限一致。

实施后的硬门槛是 warm path：**同一 `instanceId`，第二次打开 `navigationCount` 不增加**。`data-ready → first-render` 的毫秒数写入验证产物作观测，不作为模拟器抖动下的失败条件。

## 共享边界

```
AppRoot
  └─ DiffWebViewWarmer          屏外、屏幕尺寸，首帧后挂载
        └─ SharedDiffWebView    单一实例：warm / take / detach / park / reset / discard
              ├─ FileDiffScreen 前台宿主（不可被 warmer 抢占）
              └─ parkingHost    离屏保活；memory warning 或进程终止时丢弃
```

- `shared` 只给 Diff 用。其他 DOM 组件（若以后出现）保持独立 WebView。
- 前台全屏宿主持有时，warmer 的 `take` 必须失败，不得把正在显示的实例拖走。
- 离开页面：`__lodyResetDiff()` 清空 DOM 与 RN state，再 `park`。源码不进日志、不进 probe。
- URL 不匹配、停泊态 WebContent 终止、停泊态 memory warning：`discard`，下次重建。
- 显示中 WebContent 终止：尝试一次 reload；再失败走现有可重试错误态。
- DataRuntime 的离屏 WebView 完全隔离，不加共享或预热。

## 全屏 DOM Diff

- 仓库内 `packages/dom-webview` vendor `@expo/dom-webview@57.0.1`，只留 iOS。`pnpm-workspace.yaml` 用 override 指到这份，避免 expo 静默回退到自带副本。`vendor: "lody"` + `__DEV__` 断言。
- 共享实例使用 `WKWebsiteDataStore.nonPersistent()`。导航白名单：release 只允许已打包的 DOM file URL；dev 只允许当前 Metro DOM URL。源码内容不得触发任意导航或远程脚本。
- `DiffDocument`（`'use dom'`）：`parseDiffFromFile` + React `FileDiff`。支持 unified/split、词级差异、行号、选择、跟系统亮/暗。禁用文件内 header。主题覆盖为 system blue / system red 淡色，不用绿色。
- 协议：`window.__lodyAttachDiff` / `window.__lodyResetDiff`；消息 `lody:diff-runtime-ready` / `lody:diff-rendered`。复用时只重放 props。
- `FileDiffScreen` 对 ContentStore handle `readContentText` **一次**，得到 `{old,new}` 再交给 DOM。loading / error / retry、`NativeDiffToolbar`、unified/split 偏好、push 手势保持原样。
- Warmer：首个 native paint 后以屏幕尺寸离屏挂载，预热 Pierre 主题和常用语言；ready 或 4 秒后卸载宿主、保留底层实例。不预取具体文件。
- Debug probe（匿名）：`instanceId` + `navigationCount`。不含路径、不含源码。

## 内嵌 UIKit Diff

- `InlineDiffModel`：`CollectionDifference` 行序，3 行上下文 hunk，相邻删/增词级强调。覆盖重复行、空文件、Unicode、纯新增/删除。
- `LodyInlineDiffView`：统一视图（无 split）。行号栏固定，代码区只横向滚动。纵向滚动关闭，向 RN 报完整高度。可选、VoiceOver。超过 256 KiB 退纯文本（与 `LodyCodeView` 同一门槛）。
- 新增行背景：system blue 淡色；删除行：system red。不用绿色。
- `DetailBlocks.DiffBlock` 改用 `NativeInlineDiff`；`onFail` 仍退原始 JSON。

## 安全与故障

| 情况                            | 行为                                        |
| ------------------------------- | ------------------------------------------- |
| 每侧超过 2 MiB                  | 沿用现有 `too_large`，不送进 DOM / 内嵌视图 |
| 退出全屏                        | 立刻 `__lodyResetDiff`，清空 RN 文本 state  |
| 停泊态进程终止 / memory warning | 丢弃实例                                    |
| 显示态进程终止                  | 一次 reload，失败则现有错误 + 重试          |
| URL 不在白名单                  | 拒绝加载并 discard                          |
| 内嵌渲染失败                    | 该 block 退 raw JSON                        |

## 验收

- Swift：模型、降级、完整高度、无纵向滚动。
- UI `changes`：连续打开两个全屏 Diff，同一 `instanceId`，第二次 `navigationCount` 不增加；Unified/Split、返回手势、截图和视频仍在。
- UI 工具详情：native 行内容、完整高度、外层纵向滚动、横向代码滚动、深浅色、失败 fallback。
- 产物记录 cold/warm `data-ready → first-render`。
- `pnpm check`、`pnpm bundle`、`pnpm test`、native verification、带正常签名的 `pnpm verify:simulator`。

## 视觉系统（设计追加，不改架构）

两个 Diff 界面共用一套 token，目标是"原生 iOS 代码评审"，不是 Pierre/GitHub 网页控件。

- 字体：SF Mono 13 / 行高 20。Web 侧必须用 `ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace`（裸 `"SF Mono"` 在 WKWebView 常解析失败）；native 侧 `UIFont.lodySFMono(ofSize: 13)`。分隔行等 chrome 用系统无衬线体。
- 颜色：新增 = system blue（`#007AFF` / `#0A84FF`），删除 = system red（`#FF3B30` / `#FF453A`）。禁止绿色。
- 淡色层级（gutter < 行 < 词级强调）：浅色 0.09 / 0.12 / 0.22，深色 0.15 / 0.20 / 0.32。两侧一致。
- 行号：`tertiaryLabel`，改动行也不着色；改动语义由 3pt 前导变更条（Xcode 风格，增删都是实心）承担。
- 背景：`--diffs-bg` 直接锁定 `systemBackground`（`#FFF` / `#000`），与宿主 `colors.reading` 对齐；不用 GitHub 主题的 `#0d1117`。
- Pierre 覆写点：所有 token 走 `unsafeCSS`，因为它被包进 `@layer unsafe`，是唯一能压过 `@layer base` 里 `:host { --diffs-added-light: #0dbe4e }` 的层。文档级 `:root` 变量无法覆盖 `:host` 上的同名声明。
- 明暗：显式传 `themeType`，让 Pierre 在 `:host` 写 `color-scheme: light|dark`；token 值按主题在 JS 里直接算出字面量，不依赖 `light-dark()` / `color-mix()`。文档级样式表不再声明 `color-scheme`，否则外层树会盖掉 `themeType`。
- 布局：`overflow: 'wrap'`（移动端不横向滚动全屏），`disableFileHeader`，hunk 分隔行降到 28pt，split 下 gutter 收到 `2ch`；`#root` 保留 88pt 底部留白让最后几行能滑过悬浮工具栏。
