# 替换失效 ACP 实例时保留当前轮次

Status: implemented
Translation: current

[English](2026-10-17-stale-acp-recovery-turn-ownership.md)

## 摘要

失效 ACP 恢复原先终止已注册的 Session，并被误当作当前轮次结束。
终止回调会提前完成助手回复、清除输出归属，原生恢复的回放抑制随后还可能丢弃替代实例的输出。
恢复现在复用实例退役机制，在重试结束前保留同一轮次。退役失败或被中断时，旧 Session
仍由现有释放流程持有；原生 presence 租约本来就能保护心跳。

## 决策与职责

本修改把[创建失败实例的生命周期决策](2026-09-11-failed-session-create-lifecycle-events.zh.md)
延伸到已经提交过 prompt 的实例。普通用户轮次仍仅允许在没有 ACP 输出时，因连接失效或
会话不存在而重试一次。Inbox 提交继续遵守不自动重试的策略。

执行服务本来就会在传播 prompt 拒绝前排空原始 prompt/steer 工作。两个 prompt 之间改用
`retireSessionForReconfiguration(activeSession)`：验证精确实例、解绑生命周期事件，
等待实际终止后才恢复。成功前 runtime 始终绑定旧 Session。现有 disconnected 释放标记
也覆盖会话不存在的退役，因此失败和 Stop 不会丢掉清理所有者。成功后先清除此标记，
再绑定健康的替代实例，同时丢弃旧 prompt 已完成的取消排空凭据，让 Stop 排空替代实例的原始请求。
持续清理失败由原有 runtime/release failure 持有，不允许在资源
尚未释放时启动另一个生产者。

当前[原生 presence 租约](../architecture/2026-10-13-effect-session-presence-leases.zh.md)
已经能抵抗附带的生命周期清理。新增心跳修复不能解决历史和输出损坏。终止后重新打开轮次
会与旧异步 finalizer 竞争；删除自动重试则会削弱现有用户轮次行为。复用退役无需新增注册表或抽象。

Effect skill 使用 feature/fix 模式。修改所在工作流已经组合原生 Effect；Session/进程获取
及 MessageHandler 仍是尚未迁移的上游编排。扩展迁移不能帮助修正本次错误事件源，
因此不改变迁移边界或台账声明。

## 验证与限制

现有 ACP batching suite 连接真实 Session 终止、SessionManager 事件转发、MessageHandler、
临时状态、离线 SessionDocument、原生 presence 和渲染器会话索引规则。显式信号控制
有无 resume ID、两种生命周期终结顺序、连接关闭和会话不存在的清理失败、退役中及替代 prompt
执行中的 Stop，以及无输出和最多一次重试的提交限制。
四个所属测试 suite 共 369 个测试通过，CLI 类型检查通过。临时消融分别恢复普通终止、
去掉退役失败所有权、保留旧排空凭据，对应的行为回归均会失败。

Provider 与 Git 观察使用合成端口，不能据此证明真实 provider 或桌面安装包行为。
解绑监听器不能撤销已经进入的消费者；独立资源限制/error finalizer 和 provider 已排队的
任意回调不在本次回归声明内。普通 ACP 进程退出本身不会发布 Session exit 事件。
