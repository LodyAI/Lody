# 移动端 Prompt Shortcuts Beta 开关

Status: implemented
Translation: current

[English](2026-09-25-mobile-prompt-shortcuts-beta.md)

## 摘要

移动端「关于」设置提供了 Inbox Beta 开关，却遗漏了已有的 Prompt Shortcuts 开关。
现在启用开发者模式后，移动端 Beta 区域也会显示 Prompt Shortcuts。
该入口复用桌面端的持久化选项和派生功能开关，关闭开发者模式时仍保留用户选择。

## 实现与验证

`MobileAboutSettings` 复用桌面端翻译键和 `promptShortcutsBetaEnabledAtom`，
无需新增存储或功能门控。现有开发者模式测试套件覆盖可见性、开关切换、
关闭开发者模式，以及重新启用后恢复已保存的选择。

修改的 TypeScript 文件通过 Oxlint 和 Oxfmt；翻译及平台边界检查通过。
当前检出缺少依赖，测试和 `pnpm check` 无法运行，根目录格式化同样依赖这些工具。
文档和公开仓库边界检查遇到缺失的 ACP 子模块。尚未手动验证原生移动端交互。
