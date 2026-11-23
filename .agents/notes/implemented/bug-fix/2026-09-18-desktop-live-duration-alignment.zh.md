# 在桌面端活动状态中显示实时耗时

Status: implemented
Translation: current

[English](2026-09-18-desktop-live-duration-alignment.md)

## 摘要

桌面端实时轮次页脚此前将耗时单独显示在思考过程下方。现在实时活动状态本身携带耗时，例如“探索中（工作了 35秒）”。桌面端页脚不会再仅为显示耗时而创建。移动端仍保留说明性文案，因为它的前导槽同时承担无障碍和手势避让；已完成轮次的文案不变。

## 决策

`AgentActivityRow` 接收当前未完成的助手消息，并在叶组件中采样耗时。它的本地化标签组合活动文案与耗时。现有移动端页脚仍负责独立的耗时标签；桌面端页脚只在存在实际操作或已完成轮次元数据时出现。这样修正视觉层级，不改变耗时语义或移动端操作栏预留宽度。

实时状态可能出现在三个位置：会话末尾的独立状态行、实时轮次内页脚操作之上，或作为结束实时轮次的折叠活动组标签（带 shimmer）。三处都用同一个 `LiveActivityLabel` 叶组件并传入该轮消息，因此状态出现在哪里，耗时就跟到哪里（折叠组显示为“Ran 2 commands (Worked for 30s)”），且每次采样只重渲染这段文字。

这是对先前[桌面端实时耗时决策](../feature/2026-09-17-desktop-live-turn-duration.zh.md)的修正；该决策原先描述桌面端会显示 `Worked for ...`。

## 验证

`packages/components/tests/assistant-turn-action-inset.test.ts` 使用 fake timers 渲染真实会话流，验证实时活动标签会从 `Exploring (Worked for 5s)` 推进到 `Exploring (Worked for 7s)`，且不存在桌面端页脚。同一测试仍保留移动端 `Worked for 5s` 断言。`packages/components/tests/agent-activity-row.test.tsx` 覆盖独立状态行、轮次内状态和折叠组标签三处的耗时。
