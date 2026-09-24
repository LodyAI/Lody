# 不支持的输入框 steering 进入正规 Queue

Status: implemented
Translation: current

PR: [#861](https://github.com/LodyAI/Lody/pull/861)

[English](2026-09-21-unsupported-steer-regular-queue.md)

## 摘要

此前忙碌时，输入框即使未从能力缓存确认支持原生 steering，也会尝试 Guide。
daemon 拒绝后将消息提升为历史轮次，可能越过已有队列消息，并失去正常的队列编辑能力。
现在输入框与队列行共用能力判断，只有权威能力明确支持 acknowledged steering 才走原生路径，
否则直接追加到正规 Queue。能力未知时保守排队；已经提交的原生请求保留原有投递与恢复语义。

## 决策与职责

[提交路由](../../../../packages/components/src/components/sessions/session-message-submit-route.ts)
在活跃 prompt、未结束 assistant turn 之外，还要求 `nativeSteerAvailable`。
`SessionChatInterface` 从当前会话的 ACP 能力派生该值，同时传给输入框路由和队列行 steering。
现有 `queueInputBlocks` 路径负责接受队列消息及保存输入/配置；本次没有增加历史 writer、
队列实现或恢复状态。

Guide 偏好和反转 Queue 的快捷键都使用这层判断。能力变化会更新提交 callback。
显式 force-direct/force-queue 覆盖与空闲时直接发送保持原有优先级；队首显式的
interrupt-and-send 回退也保持原样。

本决策部分替代[逐行 steer 与反转发送决策](../feature/2026-09-18-per-row-queue-steer-and-inverted-send.zh.md)
中的输入框回退方式。拒绝把注定不支持的 RPC 当作正常路由：确认未投递后的恢复并不保留正规
Queue 的位置和编辑生命周期。支持原生 steer 仍可能在运行时被拒绝；其历史提升及投递未知时的
冻结仍由[历史写入 Spec](../../../../specs/session-history-writes.zh.md)约束。

## 验证

原有路由测试覆盖 Guide 偏好和反转 Queue，分别组合支持、不支持、缺失、provisional 与
unavailable 能力，并保留空闲、顺序屏障和显式覆盖测试。消融仅移除能力门控，重跑同一组断言后
恢复门控。路由、能力与队列编辑三个测试套件共 37 项全部通过。仅移除
`nativeSteerAvailable &&` 后，8 项回归用例失败、12 项路由用例通过；恢复后 37 项再次全部通过。
测试使用独立检出、仓库记录的 ACP 子模块版本与冻结锁文件。
Node 22.23.2 下，`pnpm check` 通过类型检查、lint 和组件包 3,821 项测试，随后被继承本机
提交签名设置的 Git 测试夹具阻断。仅在测试进程中禁用签名后，helper 重跑 34 项通过，CLI
2,825 项通过（原有 4 项跳过）；安装 Electron 运行时后，其 152 项全部通过。
剩余 i18n、导入、平台及公共边界检查通过，`pnpm format`、本次文件 Oxfmt 检查和
`pnpm run docs check` 也通过。未执行真实 provider 或交互式桌面验证。
