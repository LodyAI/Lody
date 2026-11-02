# 跨机器 Agent chat steer

Status: implemented
Translation: current
PR: [#2223](https://github.com/LodyAI/Lody/pull/2223)

[English](2026-11-02-cross-machine-agent-steer.md)

## 摘要

以前 Agent chat 的目标在另一台 Machine 时，消息总是排到下一轮。
现在发送端复用 UI 的活跃 assistant 历史函数，在有限时间内尝试一次 steer。
已应用输入及执行端接管的恢复继续交给目标 daemon。
远端结果不明确且消息仍等待 steer 时转成普通下一轮，接受可能重复投递的代价，
避免永久未送达；绝不取消目标。

## 决策与边界

行为由[编排契约](../../../../specs/session-orchestration.zh.md)拥有。
本机 steer 和加密成员派生规则不变。启动与发送共用五秒期限；晚到客户端不得再发 steer。
不增加 RPC 重试。`requeueUndeliveredSteer` 说明普通派发跳过 `pending_apply`；
RPC 未到达时，执行端没有恢复责任，消息会永久滞留。因此启动失败、超时、传输失败及
没有恢复所有权的响应，只提升仍为 `pending_apply` 的消息，再复用持久派发。
已开始、结束的消息保留；发送端中断或回退写入失败留下的消息在 Operation 恢复时直接排队。
跨副本丢失确认可能导致重复。这与 UI 的不确定投递及本机 `STEER_DELIVERY_UNKNOWN`
策略不同，二者保留原行为。现有命令测试使用真实 Loro 历史和替代的 Machine RPC，
覆盖投递、回退、恢复及晚到启动，不能证明真实跨机器或 Provider 验收。
