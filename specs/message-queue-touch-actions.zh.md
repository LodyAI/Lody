# 队列触摸操作

Status: draft
Translation: current

[English](message-queue-touch-actions.md)

## 场景

在窄屏或粗指针设备上，用户需要编辑、引导、移除、重试或取消队列消息，避免误触相邻控件。

## 行为

视口宽度不超过 600 px 或使用粗指针时，队列行是至少 36 px 高的紧凑单行，每行的操作收进一个
“更多”按钮，其真实区域至少为 40 × 36 px。按钮区域不与相邻行重叠，因此行高即触摸目标高度；
队列是对话的次要信息，保持紧凑，不追求 44 × 44 px 的平台建议值。操作与消息保持同一行并与文本垂直居中，
不另起一行。精细指针桌面端仍使用紧凑布局。
发送、编辑、排序和能力规则不变。

## 依据与限制

[队列样式](../packages/components/src/components/sessions/message-queue/surface.ts)
应用于已入队和本地待发送行。已有队列测试覆盖操作；已有 320 px Storybook 状态可供视觉评审。
浏览器几何布局和真机触摸体验尚未验证。
