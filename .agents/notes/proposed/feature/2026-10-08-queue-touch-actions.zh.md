# 队列触摸操作

Status: proposed
Translation: current

[English](2026-10-08-queue-touch-actions.md)

## 摘要

紧凑的队列按钮不易触摸。本次让窄屏或粗指针设备上的行操作使用真实 44 px 区域，
并独占一行，同时保留桌面的紧凑布局。浏览器和真机验收仍待完成。

## 决策与依据

共享行样式避免隐形点击区域重叠，同样覆盖本地待发送消息。现有发送和编辑处理不变。
本次扩展[本地队列行](../../implemented/feature/2026-09-28-local-queue-pending-rows.zh.md)，
遵循[触摸意图](../../../../specs/message-queue-touch-actions.zh.md)。
已有队列测试覆盖操作行为，320 px 故事支持视觉评审。
