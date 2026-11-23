# DSH Core 控制与执行归属

Status: implemented
Translation: current

[English](2026-10-09-dsh-core-capabilities.md)

## 摘要

Harness 已具备多数 Core 操作，但适配器此前只暴露流、用量和恢复能力。现已桥接只读历史、steering、Goal 控制、子代理查询与取消、后台任务状态及 worktree 逻辑身份。原生服务保持权威，ACP 跨目标自动续轮持有根 prompt。定时唤醒和账户额度窗口因当前组合无法满足契约而保留不支持；子代理能力不代表所有远端执行都可取消。

## 决策与证据

基于精确 profile 依赖闭包中的 Harness 0.2.0-rc.2 发布包类型及 JavaScript，对照 Core 0.1.9 重新核对，取代初步的 0.1.5 审计。[Harness 升级](2026-10-09-dsh-harness-upgrade.zh.md)与[会话恢复](2026-10-09-dsh-session-restore.zh.md)仍是独立决策。用户明确要求升级后桥接全部可行 Core 能力。

- SessionQuery 提供带租约的不可变快照；复用回放投影，避免 resume、写锁、存储修复与模型调用。标准列表过滤委派会话。宿主优先使用声明的 Core 历史接口，内置 Codex/DeepSeek 缺少契约时明确失败。
- Steering 使用不唤醒 Agent 的注入，通过持久化 user/message ID 确认消费，而非入队或 inbox claim。原生回合检查拒绝跨回合消息；结束时移除未消费输入并报告失败。
- GoalService 管理 CAS 状态及原生续轮。set/resume 忽略备用文本，ACP prompt 跨原生检查点保持打开。pause/clear 使用独立请求。取消先暂停再排空；active 但解除续轮授权映射为 paused，轮数耗尽映射 limited。不伪造 token 预算或目标专属计费。
- 子代理 carrier 祖先链决定根归属；查询使用 Core run ID，保留观察到的执行和有界文本尾部，拒绝外部 ID。本地取消同时排空可续接的直接子代理；远端声明 final-tail/no-cancel。不把历史会话驻留当成运行中。
- 新版 Jobs 事件直接提供所属会话的任务快照，不读取模型输出。上游空闲完成通知默认 wakeup；注册预设时把原生 job 工具覆盖为 quiet，保留 vendored 源声明，并在根 Agent 执行前拒绝无 prompt 归属的工作。重试活动和当前上下文用量来自原生事件/tokenMeter，不混用累计值。
- Worktree 身份存于适配器原子目录索引旁文件；验证后的绝对目录可组织原生 cwd 会话，不修改执行路径、权限或 Harness 存储。fork 默认继承，可覆盖。

放弃的方案包括：只声明不实现、用 loadSession 浏览历史、入队即确认 steering、首轮结束就关闭 Goal prompt、UI 消耗后台输出、把 HTTP 重试延时当额度窗口。实验性 schedule 会启动独立 followup，目前缺少兼容的工作归属入口。

## 验证与限制

适配器构建、单测、格式检查及原生 Core 验证覆盖合成模型真实回合、steering 消费和取消、Goal 自动续轮/暂停/恢复/轮数耗尽、只读历史、项目持久化和 Jobs 读取游标隔离。既有恢复与迁移、fork、profile/settings、问答原生验证继续适用。子代理单测检查执行身份、祖先归属、保留输出及外部 ID 拒绝。不使用真实模型、账户或用户对话。

宿主嵌套 checkout 缺少根依赖及部分子模块，根 check/format/public-boundary 和完整宿主测试不能宣称通过；既有文档链接错误单独报告。不宣称原生 Windows 执行或远端 provider 取消已验证。不声明 rateLimits/tasks.scheduled；子代理列表覆盖本次激活，不覆盖冷历史。

适配器：[PR #28](https://github.com/LodyAI/acp-extension-dsh/pull/28)。
宿主：[PR #1353](https://github.com/LodyAI/Lody/pull/1353)。
行为意图：[draft Spec](../../../../specs/deepseek-harness-core-capabilities.zh.md)。
