# 显示本地 worktree 加载状态

Status: implemented
Translation: current

[English](2026-09-28-local-worktree-loading-indicator.md)

## 摘要

本地项目的 Git 状态加载期间，worktree 控件原本会被禁用，但没有说明请求仍在进行。
共享的 worktree pill 现在会用同尺寸的 spinner 替换 checkbox，并在本地 Git 探测期间
暴露忙碌状态。移动端的工作目录标签也使用相同提示；在分支可用前，原有的禁用保护保持不变。

## 决策

加载提示放在 `WorktreeCheckboxPill` 中，因为 Chat Landing 和其他 worktree 界面共用这个控件。
`loading` 属性让控件保持不可操作，设置 `aria-busy`，并用 UI spinner 替换 checkbox，避免 pill
几何尺寸跳动。Chat Landing 传入本地 Git 状态请求状态，并让 tooltip 使用相同的加载文案；GitHub
强制 worktree 的 pill 行为不变。移动端本地工作目录标签在加载期间用 spinner 替换分支图标，并暴露同样的忙碌状态。

## 验证

定向组件测试覆盖加载时的 spinner／忙碌状态，以及加载完成后的正常 checkbox 状态；但当前嵌套 checkout
没有安装 Vitest，因此无法运行该测试。格式化和 diff 空白检查通过；未运行全仓库检查。
