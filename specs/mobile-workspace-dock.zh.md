# 移动工作区底部导航

Status: draft
Translation: current

[English](mobile-workspace-dock.md)

阅读工作区或项目列表时，向下滚动收起导航，向上滚动展开。DOM 与编辑器命令式滚动采用相同的同向 14px 阈值，反向时重置；距顶部不超过 4px 时始终展开。点击收起的标签会原地展开并重置阈值。

选中图标始终为同一个可见的 24×24 元素。尺寸变化不能拉伸内容；中途反向保持位置与速度连续。文字、选中背景和其他标签共同淡化。减少动态效果时直接跳到目标。隐藏控件不能接收指针或键盘输入；即将隐藏标签的焦点转移到选中标签。

共享组件负责动画和滚动解释，调用方负责带键标签、主题图标、翻译文字、选择和可选新建会话操作。两种主题行为一致。没有匹配的选择时保持展开；标签变化不能擅自选择其他标签。实例互不影响，包括相同的旧 `layoutId`。尺寸或可选操作变化保留可用宽度与安全区布局。

## 证据

[组件](../packages/components/src/components/mobile/mobile-workspace-tabbar.tsx) · [决策与验证边界](../.agents/notes/implemented/bug-fix/2026-10-05-mobile-workspace-dock-motion.zh.md)

本草案记录已接受的方向，不表示本修订获得附链接的人类批准。浏览器测试不能证明 Android 真机性能。
