# 消息队列交互

Status: draft
Translation: current

[English](message-queue-interactions.md)

## 场景

用户在 Agent 工作时继续输入，并将“排队”或“引导”设为默认行为。他们可能只想让某一条
消息采用相反行为，也可能希望直接用任意一条已排队消息引导当前回复，而不必先手动调整队列。

## 契约

- `Mod+Shift+Enter` 以已保存“排队／引导”偏好的相反行为发送当前草稿。这是一次性的提交
  意图，不修改设置，并继续遵守普通的可用性、实时活动和未完成消息记录保护。
- 当前 turn 可接受引导时，每条排队消息都提供“引导”操作。选择后续项必须以该项为目标。
  原生带确认的 steer 直接移除并应用所选项；兼容路径先把它移到队首，只有重排成功后才中断。
- 序号和非编辑状态的消息正文共同组成队列重排拖动区域。“引导”、“编辑”和“移除”是独立
  控件，不能触发拖动。
- 编辑状态保留已有键盘与焦点行为，并在编辑结束前禁用该行重排。

## 边界与待审事项

只有“排队”和“引导”具有不同含义时，该快捷键才改变路由。空闲会话仍正常直接发送；没有
明确实时 prompt 活动时，即使反转意图是“引导”，也继续采用保守的排队屏障。触摸和鼠标共用
同一拖动区域；已安装应用和物理设备验证不由组件测试替代。

## 实现证据

- `packages/components/src/components/sessions/session-message-submit-route.ts`
- `packages/components/src/components/sessions/session-chat-input-area.tsx`
- `packages/components/src/components/sessions/message-queue/`
- `packages/components/tests/{session-message-submit-route,queued-message-steer,message-queue-row-editing}.test.*`
- [决策记录](../.agents/notes/implemented/feature/2026-09-13-queue-steer-controls.zh.md)

这是供人工审阅的草稿；实现和测试通过不代表 Spec 已获批准。
