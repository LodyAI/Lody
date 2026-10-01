# 紧凑导航拥有模态焦点边界

Status: implemented
Translation: current

[English](2026-10-01-compact-navigation-modal-focus.md) | 中文

PR：[#1199](https://github.com/LodyAI/Lody/pull/1199)（draft）。

## 摘要

窄桌面浏览器打开导航时，背景控件仍在键盘焦点顺序内，机器选择器因此能在导航遮罩上打开。
紧凑导航现复用已有 Dialog 边界，并将内容焦点区域设为 inert。
关闭后恢复至打开控件或内容区域，嵌套弹层先处理 Escape。
500×745 的合成 Chromium 回归通过；生产云端、打包 Electron 和原生 iOS 尚未验证。

## 根因与决策

在 main `7d502f3d99fdcdbbdd43d032c6d903d4ed497e04` 上，
`web-workspace-layout.tsx` 的紧凑分支只是两个普通 motion 元素：点击关闭的遮罩和侧栏。
二者均没有模态焦点约束，相邻内容区域仍可交互。所属布局回归因内容区域没有 inert 而失败。
当前开放 PR 列表及 sidebar/navigation/focus 检索没有发现该分支的有效修复；
PR #1177 的图片预览焦点修复属于另一界面。

`CompactNavigationDialog` 复用产品 Dialog 适配层，处理焦点约束、外部点击、嵌套弹层顺序和
弹出控件的 portal 容器。面板挂载在工作区布局内，保留紧凑宽度与滑动过渡。
布局在打开导致失焦之前记录内容区域最后聚焦的控件，仅在紧凑导航可见时将内容设为 inert。
Escape、遮罩和布局动作关闭导航均写入已有的持久化收起状态。
拉宽窗口解除模态边界，不改写该状态。

原控件被移除、禁用或隐藏时，焦点退回内容区域。Base UI 会将不可 Tab 聚焦的 finalFocus 元素
替换为其第一个可 Tab 聚焦子元素，因此该回退在焦点约束清理之后显式聚焦区域本身。
嵌套 Popover 关闭后可能聚焦导航面板；嵌套 Dialog 恢复自己的打开控件。
二者都必须将焦点留在导航内，直到导航关闭。

仅添加 inert 会缺少模态语义和关闭事件归属；另写焦点约束则重复已有 Dialog 行为。
通用 `ui/sidebar` 移动抽屉及原生壳行为不在本项范围。
本决策补充[紧凑布局决策](../feature/2026-09-25-compact-desktop-layout.zh.md)，
不改变断点或自动抑制策略。[行为 Spec](../../../../specs/desktop-windows.zh.md) 仍为 draft。

## 验证与边界

- 所属布局、紧凑状态及焦点区域测试：17 项通过，覆盖两次 Escape／打开循环、持久化收起、
  完整宽度侧栏状态与拉宽后的边界释放。
- 所属侧栏 Playwright 测试的紧凑分组：500×745 Chromium 下 4 项通过，含减少动态效果及动画关闭，覆盖
  两次 Tab／Shift+Tab 循环、背景聚焦被拒绝、遮罩关闭、背景恢复交互、嵌套 Popover／Dialog
  Escape 顺序、打开控件恢复及控件被移除后的回退。
- `pnpm format` 通过。现有依赖条件下，全仓 `pnpm check`、`pnpm check:quick` 和组件类型检查
  未通过：缺失包类型及旧版已安装依赖在未改动源码中产生错误。组件类型检查中本项文件没有
  诊断，但不能将其报告为全量检查通过。
- 本项文件 Oxlint 及 `pnpm lint:i18n` 通过。`pnpm run docs check` 报告 45 个指向缺失子模块
  源码的断链，本项文档没有错误；仓库没有已注册的 SHA 保护主题。
  `pnpm check:public-boundary` 报告六个来自未初始化 ACP 子模块的工作区依赖无法解析。
- 浏览器回归使用真实紧凑模态组件的合成 Storybook 场景；布局集成由 jsdom 中的合成侧栏独立
  覆盖。未操作生产登录、真实机器选择或云端账号数据；未验证屏幕阅读器、打包 Electron、
  原生 iOS。

证据：[布局测试](../../../../packages/components/tests/web-workspace-sidebar-toggle.test.tsx)、
[浏览器测试](../../../../packages/components/tests/e2e/sidebar-nav-leading-column.spec.ts)、
[场景](../../../../packages/components/src/stories/CompactNavigationDialog.stories.tsx)。
