# 实时工作时显示滚到最新操作

Status: proposed
Translation: current

[English](2026-10-08-scroll-to-latest-hover-arrow.md)

## 摘要

工作指示器表达了新输出正在到达，但弱化了滚动控件的导航用途。鼠标悬停或键盘
聚焦时改为显示向下箭头，交互结束后恢复工作指示器。既有工作状态信号与滚动
操作保持不变；真实浏览器验收仍待完成。

## 决策与依据

本改动扩展了[工作状态决策](../../implemented/bug-fix/2026-09-27-scroll-to-latest-working-state.zh.md)
及[滚动意图草案](../../../../specs/conversation-scroll.zh.md)。控件仍由
`SessionChatStreamView` 负责，通过 StyleX 祖先选择器切换两个图标，不新增状态
订阅，也不修改滚动引擎。等待权限和空闲状态保持普通箭头。

既有 `agent-activity-row.test.tsx` 测试检查工作中的控件保留两个图标，并验证点击后
恢复跟随末尾。组件测试无法证明悬停或聚焦后的视觉效果，仍需真实浏览器验收。
