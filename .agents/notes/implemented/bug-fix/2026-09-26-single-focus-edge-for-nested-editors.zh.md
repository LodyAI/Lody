# 嵌套编辑器只保留一层焦点边界

Status: implemented
Translation: current

[English](2026-09-26-single-focus-edge-for-nested-editors.md)
[PR #1030](https://github.com/LodyAI/Lody/pull/1030)

## 摘要

多个编辑区域同时在外层容器和内部输入框绘制焦点边界。裸原生输入框会命中应用外壳的旧版 `:focus-visible` 阴影，而共享的 Textarea 会绘制自己的输入槽焦点环。现在由外层负责边界的输入框会关闭内层边界；消息编辑器使用无边界的 Textarea 外观，归档行则由实际控件显示焦点。键盘焦点仍然可见，但不会出现嵌套矩形。由于此检出目录没有安装依赖，尚未在运行中的应用里完成视觉验证。

## 问题与证据

Prompt Shortcut 编辑器的提及输入框位于带 `:focus-within` 焦点环的输入槽内，但全局输入规则还会在 textarea 上绘制内阴影。浏览器地址栏、移动端筛选搜索框和排队消息编辑框也采用了相同的原生输入框组合。排队消息 textarea 上的 `focus-visible:ring-0` 无法关闭这层阴影，因为全局规则直接设置了 `box-shadow`。就地编辑用户消息时，共享 Textarea 的输入槽焦点环位于自身也会变更焦点边界的卡片内。归档行也会在内部标题、复选框或操作按钮获得焦点时绘制整行焦点环。

## 决定

视觉上承载输入槽的组件负责绘制焦点边界。由外层承载的原生输入框使用 `focus-visible:shadow-none`，保留外层的焦点样式。共享 Textarea 增加 `appearance="bare"`，供外层承载输入槽时使用，并复用组合式 Input 已使用的 `well.bare` 样式。默认 Textarea 仍是自带输入槽的控件。归档行保留分隔线和悬停行为，键盘焦点交由实际的标题、复选框或操作按钮显示。

该决定延续[输入框原语记录](../feature/2026-09-09-ui-field-primitives.md)和 [UI 原语 Spec](../../../../specs/ui-primitives.md)。如果在全局关闭所有输入框的焦点阴影，独立输入框也会失去焦点提示，因此每个组合式输入区域明确自己的边界归属。

## 验证

已对照全局焦点规则、StyleX 输入框样式和组件渲染结构检查修改后的选择器。UI Gallery 增加了无边界 Textarea 示例，供视觉检查。`git diff --check` 已通过，修改过的 TypeScript 文件已用仓库所需版本的 Oxfmt 格式化。此检出目录缺少 `node_modules`，且仓库规定嵌套检出目录跳过安装，因此完整类型、测试、格式脚本及视觉检查未能运行。文档检查报告了指向缺失 ACP 子模块的既有坏链接，新记录没有相关错误。
