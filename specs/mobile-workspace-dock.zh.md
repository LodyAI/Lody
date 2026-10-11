# 移动工作区底部导航

Status: draft
Translation: current

[English](mobile-workspace-dock.md)

向下滚动收起导航，向上滚动展开。列表与编辑器命令式信号共用同向 14px 阈值，反向时重置；距顶部不超过 4px 时始终展开。点击收起的标签会原地展开并重置阈值，不改变滚动位置。

选中图标始终为同一个可见的 24×24 元素。文字、选中背景和其他标签共同淡化。中途反向保持位置与速度连续；减少动态效果时直接跳到目标。隐藏标签不能接收输入，标签隐藏前将其焦点转移到选中标签。

两种主题行为一致。没有匹配的选择时保持展开；标签变化不能擅自选择其他标签。实例互不影响，包括相同的旧 `layoutId`。尺寸变化或省略新建会话操作时，保留可用宽度与安全区布局。

## 证据

[组件](../packages/components/src/components/mobile/mobile-workspace-tabbar.tsx) · [决策与验证边界](../.agents/notes/implemented/bug-fix/2026-10-05-mobile-workspace-dock-motion.zh.md)
