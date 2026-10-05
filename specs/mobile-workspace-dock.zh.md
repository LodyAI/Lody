# 移动工作区底部导航

Status: draft
Translation: current

[English](mobile-workspace-dock.md)

阅读移动工作区或项目列表时，向下滚动将导航胶囊收起为当前标签的图标，向上滚动
即可展开，无须回到顶部。原生 DOM 滚动与编辑器的命令式滚动信号采用相同行为。
方向改变时重置累计距离；同向移动 14px 触发状态变化，距顶部不超过 4px 时始终
展开。点击收起的标签会原地展开并重置阈值，不改变内容的滚动位置。

过渡期间，选中图标始终是同一个可见的 24×24 元素。导航改变实际尺寸，不拉伸
内容；中途反向保持位置和速度连续。文字、选中背景和其他标签随同一过渡淡出。
减少动态效果时直接跳到目标状态。不可见控件不能接收指针或键盘输入；即将隐藏的
标签若有焦点，焦点转移到选中标签。

共享组件负责动画和滚动解释。调用方仍负责标签键、图标、翻译后的文字、选择状态
和可选的新建会话操作。iOS 与 Material 行为一致。没有匹配的选中标签时保持展开；
标签变化或重新排序不能擅自选择其他标签。即使旧的 `layoutId` 相同，各实例也互不
影响。尺寸变化或省略新建会话操作时，保留可用宽度和安全区布局。

## 证据

- [共享组件](../packages/components/src/components/mobile/mobile-workspace-tabbar.tsx)
- [浏览器测试](../packages/components/tests/e2e/mobile-workspace-tabbar.spec.ts)
- [决策与验证边界](../.agents/notes/implemented/bug-fix/2026-10-05-mobile-workspace-dock-motion.zh.md)

本草案记录已接受的动画方向，但不表示本 Spec 修订获得了附链接的人类批准。
浏览器测试不能证明 Android 真机性能。
