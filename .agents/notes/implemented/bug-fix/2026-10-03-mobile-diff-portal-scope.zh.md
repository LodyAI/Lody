# 将移动端 diff 保持在会话抽屉的模态作用域内

Status: implemented
Date: 2026-10-03
Translation: current

[English](2026-10-03-mobile-diff-portal-scope.md)

## 摘要

移动端 diff 使用 Base UI 抽屉，外层会话仍使用 Vaul/Radix 抽屉。diff 的 Portal 挂到 body 后会继承外层模态的指针锁定，因此在可见 diff 上滚动可能移动下方会话。移动端 diff 内容现在显式使用外层抽屉提供的无布局盒弹层宿主。这保留了模态作用域且不改变全局弹窗定位；Android 触摸行为和完整文件查看流程仍需设备验证。

## 决策与证据

UI 迁移将移动端 diff 面板替换为 `@lody/ui` 抽屉。其默认容器是 body，而会话的 Vaul/Radix 抽屉将 body 的 pointer events 设为 `none`，自身内容设为 `auto`。现有 `DrawerContent` 弹层宿主位于该内容内部、滚动子元素外部。

`SessionMobileDiffDrawerContent` 读取 `usePopupContainer` 并显式传给 `Drawer.Content`。现有根组件、关闭处理、diff 数据和文件切换流程保持原样。没有外层 provider 的界面仍使用基础组件的 body 默认值。未改变所有模态的默认容器，因为带 transform 的祖先面板可能改变 fixed 弹窗定位。

使用 Vaul 1.1.2 和 Base UI 1.7.0 的合成测试页已通过 Computer Use 在 Lody 内置浏览器中验证。在 body Portal 的 diff 上滚动一页，背景聊天从 0 移动到 641 px，diff 保持 0。Portal 位于外层抽屉内时，同样操作使 diff 从 0 移动到 641 px，背景保持 641 px；反向滚动也只移动 diff。这是组件组合证据，不代表完整 Android Release 已复现。

独立的[移动端 diff 文件切换修复](2026-09-28-mobile-diff-file-handoff.zh.md)仍有必要：打开源文件仍先关闭 diff。实现说明：[会话文件界面](../../../docs/sessions-file-surfaces.md)。

## 验证

现有抽屉测试套件将真实移动端 diff 内容放入真实会话抽屉，覆盖初始打开和点击后打开。测试检查模态包含关系、有效 pointer events、焦点保持、行选择以及仅关闭内层抽屉。JSDOM 不验证原生滚动命中测试；浏览器和 Android 验证仍是独立检查。

抽屉、移动端文件查看器、文件内容界面和会话 diff 数据套件的 61 项测试通过。去掉显式容器会使新增的两个回归案例失败，恢复后通过。共享组件类型检查、修改文件的 lint/format、根目录 `pnpm format` 和平台边界检查通过。根目录 `pnpm check` 在 CLI 类型检查阶段因 Claude、Codex、Grok、Devin ACP 子模块未初始化而停止。公共边界和文档检查也报告这些缺失子模块；没有文档错误涉及修改文件。
