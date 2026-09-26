# 窗口的第一帧是启动外壳

Status: implemented
Translation: current

[English](2026-09-26-boot-shell-first-paint.md)

## 摘要

Lody 所有的加载态都由 React 绘制，所以在渲染 bundle 下载、执行并完成首次 commit 之前，
窗口只是一块空画布。加载慢时，这意味着数秒的空白，然后是一个形状不同的占位，最后才是真实布局。
现在，窗口的第一帧是内联进 `index.html` 的静态启动外壳：按用户保存的宽度和主题画出侧栏列，
内容区正中是 Lody 标志。React 的启动与鉴权闸口渲染同一份标记，所以唯一可见的变化是真实布局出现。
代价是一段需要 CSP hash 的小型内联脚本，以及从内置主题复制出来的颜色，由测试锁定。

## 问题

React 绘制的一切在首次 commit 之前都不存在：`LoadingPlaceholder`、懒加载布局的
`CriticalWorkspaceShell`、启动失败卡片，都只覆盖 commit 之后。在那之前 `#root` 是空的；
加载慢时，入口 chunk、i18n 和路由就绪前它一直是空的。
我们录制了一次桌面端重载，把每个脚本和样式表都延迟 1.5 秒，结果是约 5.7 秒的空白画布，
接着是 `CriticalWorkspaceShell`（侧栏 220 px、带文字行，真实侧栏是 280 px），
然后才是真实布局，一共三种不同的画面。

入口样式表让 Web 端更糟：Vite 把它链接在 `<head>` 里，它会阻塞首帧，直到整份产品 CSS
下载完成。所以即使 `index.html` 里有标记，也要等 CSS 下完才显示。

## 决策

- **一帧，两处绘制。** `lib/boot-shell.ts` 持有标记、样式和颜色；启动脚本在
  `lib/boot-shell-script.ts`，不带任何 import，桌面端 CSP 测试可以直接在 Node 下计算它的 hash；
  `vite-boot-shell.ts` 把它们内联进带有 `<!-- lody:boot-shell-head -->` 与
  `<!-- lody:boot-shell -->` 标记的入口；`components/boot-shell.tsx` 在 React 中渲染同一份标记。
  React 的首次 commit 会替换 `#root` 里的静态副本；两者完全一致，替换不可见。
  测试会比对两者的结构，以及标志元素的逐字节一致。
- **只画确定的东西。** 外壳只画侧栏列（不画行）和标志。行、标题或输入框都是猜测，
  真实布局随后会移动或替换它们。侧栏列是确定的：宽度一致（`sidebarLastWidthAtom`，
  按 `LoroSidebar` 的范围夹取）、颜色一致、边框一致。
- **`<head>` 脚本决定主题与侧栏列。** 它在外壳被解析之前运行。
  它读取 `ThemeProvider` 将要应用的主题（用户保存的选择，否则跟随系统偏好），
  在 `<html>` 上设置 `dark` 或 `light`。它还判断工作区侧栏是否会显示：
  非工作区路由、设置页、侧栏折叠时都不显示；会话窗口默认折叠，辅助窗口读取自己的存储。
  结果以 `data-lody-boot-sidebar` 记录在 `<html>` 上，宽度写入一个 CSS 变量。
  React 的副本读取同样的属性，所以只判断一次。脚本只读不写；任何失败都退回为浅色画布加居中标志。
- **连续优先于动效。** 标志在 120 ms 后淡入，1.2 s 起缓慢呼吸，所以启动快时看不到任何动效。
  延迟从导航开始计算（`--lody-boot-elapsed`），因此 React 副本会接续静态副本的相位，
  而不是重新开始。闸口文字在 0.9 s 时淡入到标志下方。开启“减少动态效果”时两者都关闭。
- **启动闸口使用外壳。** `LoadingPlaceholder` 新增 `variant="boot"`。
  `routes/index.tsx`、`routes/$workspaceName.tsx` 与 `_auth.tsx` 中的路由闸口
  （启动本地工作区、登录中、加载工作区）改用它。`viewport` 保留给面板内的调用方（会话详情、登录页）。
  本地布局的 `RouteSuspense` 在所有路由上都以外壳作为 fallback。`CriticalWorkspaceShell` 已删除；
  它在非 chat 路由上回退为 `null`，会让窗口再次变空白。
- **样式表放到外壳之后。** 构建时，插件把 `<head>` 里的样式表链接移到 `<body>` 末尾。
  在那里它只阻塞其后的内容，所以外壳立即绘制；而 module 脚本仍会等待阻塞脚本的样式表，
  React 不会在无样式状态下渲染。
- **刻意使用纯 CSS。** 外壳要给一个还没有任何 bundle 触碰过的文档上样式，
  所以不能依赖 StyleX、主题变量（由 JS 写入）或产品字体。标志用的是品牌水母
  （`assets/icon-transparent.png`，owner 选定，替换了单色的 `lody.svg` 剪影），
  裁边后重新编码为 96px WebP，以 data URL 内联（约 6KB），不需要额外请求。
  颜色是 Lody Light 与 Vesper 的 `--background`、`--sidebar-background`、`--sidebar-border`、
  `--muted-foreground` 的字面值副本；`tests/boot-shell.test.tsx` 会解析内置主题，颜色偏离时测试失败。
- **CSP 用 hash 放行。** 桌面渲染进程禁止内联脚本。`index.html` 与 `devbar.html`
  以 SHA-256 放行启动脚本；脚本变了而 hash 没更新时，`renderer-csp.test.mjs` 会失败。
  使用响应头 CSP 的宿主需要加入 `bootShellScriptCspSource()`。

## 考虑过的方案

- **真实布局的骨架屏。** 被 owner 的要求否决（“最明显的简易框架即可”），本身也不划算：
  占位行永远对不齐真实的行，只会多出一帧会移动的画面。
- **外链启动脚本。** 可以免去 CSP hash，但会在首帧前多一个阻塞渲染的请求，
  而这正是慢网络最承受不起的。
- **只用 CSS 的 `prefers-color-scheme` 主题。** 不需要脚本，但保存的主题与系统不同的用户，
  整个启动期间都会看到错误颜色的画布；CSS 也读不到侧栏宽度。
- **把静态外壳作为覆盖层，直到布局发出信号再移除。** 这样也能遮住 React 的前几帧，
  但需要一套移除协议，每个闸口、启动失败路径和预热窗口都得遵守。
  让 React 闸口画同一帧，就能得到同样的效果而不需要这套协议。

## 验证

- `tests/boot-shell.test.tsx` 覆盖：
  - 脚本的主题解析；
  - 侧栏判断（工作区、hash 路由、保存的宽度及其夹取、折叠、设置、登录、onboarding、
    有无上次路由的根路径、会话窗口与辅助窗口）以及存储失败时的回退；
  - 注入的脚本与 CSP hash 一致；
  - 标记处理与样式表移动；
  - React 与静态标记一致；
  - 颜色与内置主题一致。
- `apps/electron/src/renderer/renderer-csp.test.mjs` 检查两个渲染入口都带有标记和当前 hash。
- 在 Xvfb 下录制了改动前后的桌面端重载：通过主进程的 `file:` handler，
  把每个脚本、样式表和 wasm 请求都延迟 1.5 秒。

## 局限

- Web 宿主在本仓库之外。它需要接入插件和标记；如果 CSP 通过响应头下发，还要加入 hash。
  Web 端的首帧时间没有在这里测量。
- 内联的标志让每个入口 HTML 增加约 8KB 的 base64；Web 宿主的 CSP 需要允许 `data:` 图片
  （桌面渲染进程已经允许）。
- Electron `BrowserWindow` 的背景色仍然跟随系统主题。保存的主题与系统不同的用户，
  在文档绘制之前可能看到一帧颜色不对的原生窗口。
