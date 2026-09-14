# 收敛横向滚轮滚动的实现

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/617

[English](2026-09-11-shared-horizontal-wheel-scroll.md)

## 摘要

任务看板与侧边面板标签栏各自把竖直滚轮输入转换为横向滚动，使两者的手势、delta 模式与边缘行为
可能发生分化。现在由一个共享的 React hook 拥有原生非 passive 监听器、delta 归一化、钳制以及
浏览器事件释放规则。调用方只保留各自界面特有的适用性策略，例如让任务列内部的滚轮事件保持竖直
滚动。

## 决策

横向滚轮转换属于 DOM 行为而非 Session 或 Task 业务逻辑，因此由
[`use-horizontal-wheel-scroll.ts`](../../../../packages/components/src/hooks/use-horizontal-wheel-scroll.ts)
拥有。该 hook 通过回调 ref 直接绑定到滚动视口：React 委托的 passive 滚轮监听器在消费竖直 delta
之后无法可靠地调用 `preventDefault()`。

共享行为会忽略原生横向或斜向手势、浏览器缩放、已被消费的事件、竖直 delta 为零的事件，以及已到
达边缘的滚动方向。像素 delta 直接透传，行 delta 使用稳定的 16 像素单位，页 delta 使用视口宽度。
一像素的 epsilon 避免在分数设备像素溢出时把滚轮输入困住。

可选的 `shouldHandle` 谓词是界面特有策略的边界。
[`TasksBoardView`](../../../../packages/components/src/components/tasks/tasks-board-view.tsx)
用它在事件起始于看板列内部时保留竖直滚动；
[`SessionSidePanelTabBar`](../../../../packages/components/src/components/sessions/session-side-panel-tab-bar.tsx)
则接受所有其他符合条件的竖直滚轮事件。

## 证据与验证

本记录是 [PR #601](https://github.com/LodyAI/Lody/pull/601) 中合入的侧边面板行为的后续，并取代
了此前仅服务任务看板的解析器与监听器。DOM 层测试派发真实的可取消滚轮事件，覆盖像素、行与页
delta；钳制与边缘释放；横向与缩放手势；嵌套内容的归属；禁用行为；以及分数溢出。
