# 队列触摸操作

Status: draft
Translation: current

[English](message-queue-touch-actions.md)

## 场景

在窄屏或粗指针设备上，用户需要编辑、引导、移除、重试或取消队列消息，避免误触相邻控件。

## 行为

视口宽度不超过 600 px 或使用粗指针时，队列操作按钮的真实区域至少为 44 × 44 px，
互不重叠。操作独占一行，保留消息文本的阅读宽度。精细指针桌面端仍使用紧凑布局。
发送、编辑、排序和能力规则不变。

## 依据与限制

[队列样式](../packages/components/src/components/sessions/message-queue/surface.ts)
应用于已入队和本地待发送行。已有队列测试覆盖操作；已有 320 px Storybook 状态可供视觉评审。
浏览器几何布局和真机触摸体验尚未验证。
