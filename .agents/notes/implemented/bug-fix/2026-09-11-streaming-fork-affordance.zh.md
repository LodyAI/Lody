# Fork 控件仅在回复完成后出现

Status: implemented
Translation: current

[English](2026-09-11-streaming-fork-affordance.md)

## 摘要

正在流式输出的 assistant 回复会显示 Fork 图标，因为部分内容复制复用了已完成
回复的 Fork 菜单。原生 Fork 当时仍是禁用的，但共享的入口会让人误以为未完成的
回复也能被分叉，并让等待中的 Fork 状态越过完成边界继续显示。现在流式回复通过
一个直接的 Copy 动作保留上下文复制能力，而 Fork 及其加载状态只在回复完成后
渲染。

## 决策

上下文复制能力与原生 Fork 的生命周期是两个独立的展示状态。按照
[会话上下文复制 Spec](../../../../specs/conversation-context-copy-and-text-attachments.md)
的要求，部分回复仍可导出，但不再渲染 `AssistantForkButton`。等待中的 Fork 会在
指针移开后保持已完成回复的操作组可见；如果该回复重新打开，其 Fork 加载指示会
隐藏，直到消息再次完成为止。

这修正了
[Conversation context fallback](../feature/2026-09-09-conversation-context-fallback.md)
中记录的共享菜单决策，但没有移除流式期间的时间点导出，也没有改变原生 Fork 的
能力检查。

## 验证

现有的 fork destination 测试套件现在覆盖了边界的两侧。流式 fixture 故意携带
一个匹配的 pending-fork id，并验证：存在直接的上下文复制动作、没有 Fork 控件、
没有被强制常驻显示的操作行。已完成 fixture 验证上下文复制仍可从 Fork 菜单使用，
而 assistant footer 套件保留了对已完成回复上可见的 pending Fork 组的覆盖。
