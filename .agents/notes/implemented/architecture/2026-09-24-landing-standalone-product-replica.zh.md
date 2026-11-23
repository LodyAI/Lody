# 落地页产品演示改为独立复刻

Status: implemented
Translation: current

[English](2026-09-24-landing-standalone-product-replica.md)

## 摘要

公开站点落地页的产品演示原本通过 `@/*` 别名直接渲染 `packages/components`
里的真实应用组件，因此任何应用改动都可能让落地页出故障：最近一次（#937）是
composer 的一个 hook 依赖应用的 Convex 认证 provider，导致整个演示区消失。
现在演示区改为 `site-docs` 自有的纯展示复刻：组件只接收演示数据和 props，
不从应用导入任何东西，一旦再次越界就会有测试失败。代价是落地页不再自动跟随应用：
外观是复制过来的，当应用外观变化到足以让落地页失真时，需要重新复制。

## 问题

- 落地页挂载了真实的桌面外壳、会话列表、composer、ai-gui 对话渲染器、diff
  查看器、移动端首页以及用量/PR 视图。为了让它们在公开静态站点上运行，需要约十几个
  指向站点 shim 的 Vite 别名、防止 React 18/19 双重加载的 `forceSingletonDeps`
  插件、Loro Wasm 构建插件、手写的 `types/lody-app-components.d.ts`（TypeScript
  看到这些导入的唯一途径）、一个塞满假 runtime/agent/machine atom 的 jotai store，
  以及一套私有 i18n 实例。
- 故障是静默的：预览在 `OptionalEnhancement` 里渲染，崩溃只会让演示区消失，其他检查
  依然全绿。一次过时的声明曾让 `DesktopSessionDetailLayout` 的顶栏和面板消失而 typecheck
  通过；#937 则是一个需要 Convex 的 composer hook。
- 这种耦合还有体积代价。演示区挂载后，落地页会下载约 5.3 MB JS（未压缩）、一个
  2.3 MB 的 CRDT Wasm、一个 PostHog 分析模块，以及 515 KB 的共享 CSS——因为
  Tailwind 为每个公开页面扫描了整个 `packages/components/src`。

## 决定

- `site-docs/components/landing-replica/` 只复刻功能标签脚本能到达的状态。演示框是
  `inert` 的，所以菜单、弹层、hover 和无法到达的会话都没有搬过来。三段脚本对话
  （字号设置计划、roadmap 反馈、移动端键盘）和权限请求卡片从未能被打开，已删除。
- 每个复刻组件按落地页的渲染路径复制应用的 DOM 结构和 class 字符串。共享原语
  （`cn`、`Button`、品牌与文件图标）复制进该目录；`clsx` 和 `tailwind-merge` 成为直接
  依赖，让复制来的 class 覆盖与应用中的解析结果一致。diff 直接使用 `@pierre/diffs`，
  这是应用同样在用的公开 npm 包。
- `landing-app-preview.tsx` 保留 ghost cursor 脚本及其 DOM 钩子；演示文案和对话移到
  `landing-preview-data.ts`。已经是空操作的 Ken-Burns 镜头和布局持久化被移除。
- `use-sync-external-store` 的两个别名保留并移到 `lib/`：Base UI 和 TanStack Router
  也会导入这个 CJS shim，而开发服务器无法把它作为 ESM 提供。它们从来不只服务于预览。
- 删除了：`app-preview-shims/`、`@/*` 别名及各 shim 别名、`forceSingletonDeps`、
  Loro 浏览器插件、`types/lody-app-components.d.ts`、对 `packages/components` 的
  `@source` 扫描、只为预览存在的 CSS（Radix portal 配色、镜头变量），以及
  `@lody/components`、`@lody/shared`、jotai、i18next、react-i18next 依赖。
- 站点 `test` 运行的 `scripts/app-boundary.mjs` 会在出现 `@/*`、`@lody/components`
  或 `@lody/shared` 导入、构建输入指向 `packages/components/src`、或 `package.json`
  声明这些依赖时失败。

## 备选方案

- **逐字复制依赖闭包。** 落地页的传递依赖是 771 个 `packages/components` 模块
  （约 9.9 万行）加 110 个 `@lody/shared` 模块。这样规模的 fork 仍然需要 shim 和
  provider，会立刻漂移，崩溃面也不变。否决。
- **录屏。** 不受应用改动影响，但演示区必须跟随站点的明暗主题和语言，ghost 脚本依赖
  布局，而且视频会增加体积、文字不清晰。否决。
- **继续复用应用组件，改进 shim。** 这就是 #937 的做法：一次修一个 hook，落地页离下一次
  空白只差一次应用重构。仅作为 #937 已上线的临时止血方案保留。

## 证据

- 改动前后截图（1600×1000、1280×800、390×844 视口；中英文；明暗主题；四个演示的
  定时关键帧、减少动态效果下的结束状态，以及 power 区）只在滚动位置和下列预期修正上
  有差异。每张截图的像素差异比例都低于 5%，主要来自动画中的 WebGL 背景。
- 预期的可见变化：旧演示 i18n 缺失的字符串现在有翻译（例如中文“已完成工作”“搜索”
  “可合并”）；composer 显示真实占位文案，而不是未翻译的
  `composer.promptPlaceholder.compact`；运行配置芯片显示 Codex 标志，而不是兜底的
  Bot 图标；已合并 PR 图标与应用一样是紫色；选中的本地项目行使用应用的选中色；移动端
  新对话面板的输入会换行而不是被截断。
- 生产静态构建，Chrome 1600×1000，从本地静态服务器获取的未压缩字节数。挂载演示区的
  落地页：JS 5.26 MB → 2.16 MB，CSS 544 KB → 299 KB，Wasm 2.26 MB → 无。文档页：
  JS 1.22 MB → 1.20 MB，CSS 538 KB → 299 KB（共享样式表不再包含应用的工具类）。
  `/price/`：JS 1.18 MB → 1.16 MB，CSS 538 KB → 299 KB。
- `test:static` 全部 282 个用例通过，包括 `/` 与 `/zh` 的 `landing app preview mounts`；
  `app-boundary.test.mjs` 能在夹具目录中检出每一种被禁止的导入形式。

## 局限

- 复刻是一份拷贝。在有人复制之前，它不会显示应用的后续变化，也没有任何机制检测这种
  漂移；记录的形状在 `.agents/docs/site-landing-and-marketing.md`。
- power 区的用量卡片是可交互的（手动滚动、范围切换、按天明细）；其中图表是对应用
  Recharts 输出的手绘 SVG 近似，未复刻其悬停 tooltip。
- `scripts/generate-landing-agents.mjs` 在生成时仍读取应用的 agent 图标资源；产物是
  提交在仓库里、归站点所有的文件。

相关：[#937 临时方案](../bug-fix/2026-09-24-landing-app-preview-mention-expansion.zh.md)。
