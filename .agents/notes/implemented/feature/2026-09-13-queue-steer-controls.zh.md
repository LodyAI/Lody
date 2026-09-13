# 队列反转与直接操作

Status: implemented
Translation: current

[English](2026-09-13-queue-steer-controls.md)

## 摘要

此前若要在“排队”和“引导”间切换，必须修改持久设置；后续队列项不显示“引导”，重排也只能
从狭小的左侧把手开始。本次采用一次性反转提交命令、让每行都显示“引导”，并把消息内容区
作为拖动区域。队列顺序与立即“引导”保持独立：daemon 直接消费所选队列 ID；如果该 ID 已
不存在，则当前 turn 不受影响。

## 决策

- 在命令系统注册 `session.sendWithInverseQueueBehavior`，默认仅在输入框聚焦时由
  `Mod+Shift+Enter` 触发。输入框直接调用 `sendMessage({ queueBehavior: "inverse" })`，普通
  提交不传选项。输入框聚焦、有内容且可以发送是命令级条件，因此用户覆盖 binding 后也不会
  丢失；路由器只反转本次有效偏好。
- 会话允许引导时，每一行都显示“引导”。Renderer 通过 `session/queue-steer` 发送队列 `$cid`
  和预期活动 turn，等待 daemon 返回，且不在本地修改队列或历史。Daemon 在每会话 mutation
  与历史 rewrite lease 下重新确认 turn，并在一次 Session Doc 更新中把该行消费进历史，再请求
  精确取消该 turn。
- 左侧序号和消息正文合并为一个支持鼠标及键盘的拖动区域。操作按钮保持在区域外；编辑器
  接管交互时禁用该行拖动。

## 备选方案与取舍

只允许队首“引导”会迫使用户先做一次无关重排。没有采用“重排后取消”：并发客户端删除所选
行时，重排仍可能 resolve，进而在没有可提升消息的情况下错误 Stop 当前 turn。也没有让
Renderer 先写历史，因为它无法原子确认 daemon 的 turn 所有权和队列 ID。没有让整行都可拖动，
因为那会使“引导”、“编辑”和“移除”成为意外的拖动起点。

## 验证与边界

- 路由测试覆盖 prompt 活动时“排队 → 引导”和“引导 → 排队”的反转。
- 命令测试覆盖默认 binding、显式提交选项和命令级输入框聚焦规则。
- 队列组件测试覆盖对后续项执行“引导”，并验证消息内容属于拖动区域而操作按钮不属于。
- CLI service 与 Session Doc 测试覆盖从 `[A, B, C]` 消费 C 后保留 `[A, B]`、消费后精确取消
  turn，以及 C 已缺失时绝不调用 Stop。
- Machine RPC schema 测试覆盖两个必需 ID。
- 组件测试使用合成指针状态；未验证物理触摸拖动和完整的 Provider-backed steer 流程。

## 参考

- [消息队列交互 Spec](../../../../specs/message-queue-interactions.zh.md)
- [队列作用域](../../../../packages/components/src/components/sessions/message-queue/AGENTS.md)
- [提交路由](../../../docs/sessions-live-status.md)
