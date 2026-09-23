# Mermaid 内嵌视图

Status: draft
Translation: current

[English](mermaid-inline-view.md)

读者平移或缩放图表以查看节点后，点击其他地方必须保留节点的位置。激活不添加描边或光环。

点击外部、移走键盘焦点、按 Escape、切换到未激活状态或打开全屏查看器，都只停止内嵌交互，
不重置平移或缩放。再次点击图表从原视图继续操作。每张渲染后的图表在挂载期间保留各自的视图；
替换或重新挂载可以从初始视图开始，不承诺跨会话持久化。

未激活的图表不消费捏合手势。普通滚轮在两种状态下都继续滚动会话。触摸保持打开查看器的行为。
全屏查看器独立从自然尺寸开始，打开或关闭时均不改变内嵌视图。

## 证据

- [交互实现](../packages/components/src/components/ai-gui/use-mermaid-diagram-canvas.tsx)
- [行为测试](../packages/components/tests/markdown-mermaid-fullscreen.test.tsx)
- [决策记录](../.agents/notes/implemented/bug-fix/2026-09-21-mermaid-retain-view.zh.md)
