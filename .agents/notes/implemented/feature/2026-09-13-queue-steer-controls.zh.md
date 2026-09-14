# 队列反转与直接操作

Status: implemented
Translation: current

[English](2026-09-13-queue-steer-controls.md)

## 摘要

此前若要在“排队”和“引导”间切换，必须修改持久设置；后续队列项不显示“引导”，重排也只能
从狭小的左侧把手开始。本次采用一次性反转提交命令、在 daemon 能安全识别目标行时让每行
显示“引导”，并把消息内容区作为拖动区域。队列顺序与立即“引导”保持独立。精确队列项引导
必须版本协商、保留 native ACP Steer、遵守 editing lease，并在目标 ID 缺失时保持当前 turn 不变。

## 决策

- 在命令系统注册 `session.sendWithInverseQueueBehavior`，默认仅在输入框聚焦时由
  `Mod+Shift+Enter` 触发。输入框直接调用 `sendMessage({ queueBehavior: "inverse" })`，普通
  提交不传选项。输入框聚焦、有内容且可以发送是命令级条件，因此用户覆盖 binding 后也不会
  丢失；路由器只反转本次有效偏好。
- 在 `MachineMeta.protocolCapabilities` 声明 `queueItemSteer`。只有该版本存在时，Renderer
  才调用 `session/queue-steer`；缺失即表示不支持。请求携带队列 `$cid` 与预期活动 turn，
  Renderer 等待结果，不在本地修改队列或历史。
- 远程请求写入前，Renderer 必须使用已认证且以 Convex 为权威来源的可见 machine 快照做
  授权；快照尚不可用或不包含目标时应 fail closed。RPC 不携带请求者身份，因为目标 daemon
  无法认证 workspace stream 写入者声称的身份。同机 local IPC 仍是可信的本地控制路径。
- Daemon 确认两个 ID 及目标 editing lease 后决定执行机制。支持 acknowledged native ACP
  Steer 时，原子消费目标行为 `pending_apply`，并进入既有 `steerPrompt` handoff。Native Steer
  的 requester 必须来自已认证的活动 invocation，绝不信任共享 queue row；若缺少该冻结身份，
  应在消费前失败。否则消费为
  普通 pending turn，发布 activation pointer，并仅在两项写入都成功后删除 queue row，再只
  取消预期活动 turn。部分发布失败时保留 row 作为重试标记，并复用已有 history ID。
- 混合版本兼容不得恢复“先重排后取消”。旧 daemon 若 authoritative capability 声明支持
  acknowledged Steer，则使用旧 native 路径；其他旧 daemon 只保留既有队首 interrupt，后续行
  “引导”禁用并提示升级。
- Daemon 为已完成的精确操作 key 保留有界 receipt。响应丢失后的重试返回相同结果，不再次
  消费或取消。消费后取消失败也只留下一个持久 follow-up，并以幂等方式返回。
- 左侧序号和消息正文合并为一个支持鼠标及键盘的拖动区域。操作按钮保持在区域外；编辑器
  接管交互时禁用该行拖动。

## 备选方案与取舍

只允许队首“引导”会迫使用户先做一次无关重排。没有采用“重排后取消”：并发客户端删除所选
行时，重排仍可能 resolve，进而在没有可提升消息的情况下错误 Stop 当前 turn。也没有让
Renderer 写历史仅保留给旧 daemon 的 native 兼容路径；它无法提供精确队列项原子性。没有删除
native steer，因为 `steerPrompt` 注入当前 prompt，而 cancel-and-dispatch 会开启新 turn，两者
语义不同。没有让整行都可拖动，因为那会使“引导”、“编辑”和“移除”成为意外拖动起点。

## 验证与边界

- 路由测试覆盖 prompt 活动时“排队 → 引导”和“引导 → 排队”的反转。
- 命令测试覆盖默认 binding、显式提交选项和命令级输入框聚焦规则。
- 队列组件测试覆盖后续行引导、旧 daemon 仅启用队首、authoritative legacy native 选择，以及
  拖动区域边界。
- CLI service 与 Session Doc 测试覆盖精确消费 C、native `steerPrompt`、精确取消、目标缺失、
  伪造或缺失的 native identity、editing lease、activation 发布失败、取消失败及响应丢失重试。
- Machine RPC 与 protocol capability 测试覆盖队列／turn 两个 ID、拒绝请求者身份声明、来源
  授权以及混合版本协商。
- 组件测试使用合成指针状态；未验证物理触摸拖动和完整的 Provider-backed steer 流程。

## 参考

- [消息队列交互 Spec](../../../../specs/message-queue-interactions.zh.md)
- [队列作用域](../../../../packages/components/src/components/sessions/message-queue/AGENTS.md)
- [提交路由](../../../docs/sessions-live-status.md)
