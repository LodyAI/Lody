# Onboarding 埋点边界

Status: draft
Translation: current

[English](onboarding-analytics.md)

用户在普通 Chat Landing 中选择 Agent 或项目属于产品日常使用，不代表推进桌面引导。
这些选择和恢复的默认值不得发送 `onboarding/agent_config_selected`、
`project_selected` 或 `project_source_ready`。停用这三个历史事件，不新增替代流量。
桌面引导继续使用受平台 telemetry capability 控制的 flow、step、operation 契约；
OSS local 不发送任何遥测。

## 完成阶段

| 事件                              | 含义                                                             |
| --------------------------------- | ---------------------------------------------------------------- |
| `onboarding/completion_started`   | 一次已接受的进入产品尝试；并发触发共享本次尝试。                 |
| `onboarding/completion_succeeded` | 导航成功，与原生完成标记写入结果无关；耗时衡量进入产品。         |
| `onboarding/flow_completed`       | 导航和原生完成标记均成功；耗时衡量两者全部完成。                 |
| `onboarding/completion_failed`    | 导航失败，操作仍可重试。                                         |
| `onboarding/persistence_failed`   | 原生写入失败或不可用；导航仍可能成功；耗时衡量何时获知写入失败。 |

持久完成漏斗按 `flow_completed` 的不同 `flow_id` 计数，不累加三个完成阶段。
进入产品转化使用 `completion_succeeded`。递增的 `attempt` 关联同一次路由挂载期间的
完成尝试与结果；重载后归零，不是全局唯一尝试标识。flow identity 仍属于会话级别。

原生持久化与导航并行。写入等待或失败不得阻塞进入产品；只有两者成功才清除 renderer
恢复状态。不能把阶段事件合并成一个，否则会丢失“导航成功但持久化失败或等待中”的区别，
或丢失尝试分母与进入产品耗时。持久化仍在等待时不虚构成功或超时结果。

## 证据与限制

实现位于同一 package 的 `packages/components/src/routes/onboarding.tsx`、
`components/onboarding/desktop-onboarding-completion.ts` 和
`components/chat/chat-landing.tsx`。完成流程测试覆盖两种完成顺序及独立失败路径。
仅凭汇总计数无法证明这些监听对生产流量的实际贡献；本次修改不会修正历史数据。
