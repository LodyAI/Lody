# 防止重复消费 agent 完成消息

Status: implemented
Translation: current

PR: [#1422](https://github.com/LodyAI/Lody/pull/1422)

[English](2026-10-10-agent-message-idempotency.md)

## 摘要

Agent 完成消息的 Delivery 已有固定 ID 和持久化 claim，但旧连接恢复仍可能在启动检查
之后再次提交 prompt。结果清理也会删除阻止很久以后重试所需的身份信息。现在 Delivery
在连接失败后停止自动重发，清理保留精简的 retired-id，并通过数据库触发器约束旧版
写入方。此方案保证同一本地存储内每个 Operation 至多提交一次，代价是崩溃时可能只能
记录投递不确定、ID 记录持续增长；它不能证明 provider 恰好成功消费一次。

## 发现与决策

此方案扩展[本地编排决策](../architecture/2026-09-29-local-session-orchestration.zh.md)，
保留 daemon 的所有权。当前意图见
[Session 编排 Spec](../../../../specs/session-orchestration.zh.md#幂等消息消费)。

`promptWithStaleACPRecovery` 在未观察到 ACP 输出时重试断开的连接。Delivery 的
`runtime.promptStarted` 使此次重试跳过启动回调。Provider 可能在连接失败前就已收到
输入；没有输出不能证明未消费。现在 Delivery 跳过此恢复，并将提交后的断线结算为
`uncertain`。已有 SQLite claim、仅重试结算、Worker 恢复和固定历史 ID 继续负责协调。
普通用户 Turn 保留现有恢复策略。合成回归测试证明了这个缺口；没有采集受影响用户的
运行轨迹，因此不能确认所有报告的重复都由此造成。

已消费记录七天后过期，过去删除后可重新接受同一个键。独立的 `operation_retired_ids`
表只保留 Session/Operation 键。删除触发器原子地记录该键；插入触发器拒绝再次接受，
包括不知道此表的旧版写入方。新版调用方收到不可重试的 `OPERATION_ID_REUSED`。
独立存储保留严格解析旧行的兼容性，过期结果查询仍返回不存在。迁移在维护清理前检测
缺失的表和触发器。

按内容去重会吞掉合法的相同文本消息；永久保留所有结果会无谓保留 prompt 和输出。
只保留键的持续存储成本较小，但不能按时间清理，否则会再次允许很晚的重放。
以前已经删除的键无法恢复，删除数据库会重置保护，降级 Worker 仍会使用旧版 ACP
重试策略。若另行要求原生模型恰好成功执行一次，则需要更强的执行方契约；那不是
本次消息消费幂等的要求。去重与消费确认由消息编排存储负责，不需要新增 ACP 能力。

## 验证与限制

最终执行、coordinator、store 和 model 四个套件共通过全部 379 项测试。
执行回归先记录 provider 收到输入再模拟断线，
验证 Delivery 只有一次接收并结算为不确定，普通恢复仍会提交给恢复后的 Session。
真实 SQLite 测试覆盖过期、重开、晚到重试、旧版 SQL 写入以及不同请求方身份。
模型统计重复调度、中断、ID 退役和恢复过程中的 provider 提交次数。

验证复用了缓存依赖，包括指定的 `loro-repo` 0.21.2，并初始化固定版本的公开 ACP
submodule。CLI 类型检查、修改范围内的格式、lint 和文档检查通过。没有执行已发布
桌面复现或实际 provider 验收。
后续[范围纠正](../../rejected/architecture/2026-10-10-provider-prompt-receipts.zh.md)撤回
误加的 ACP 回执协议；最终改动只涉及消息编排与统一执行层。

深度复核检查了清理前的 retired-id 迁移、删除/插入事务栅栏、请求方作用域、并发
Worker claim、孤儿恢复、仅重试结算和普通用户 Turn 的恢复边界，未发现 P0/P1 问题。
五个所属套件（包含 ACP 错误分类）共 407 项测试通过。ACP client、adapter 子模块
与依赖清单没有本任务差异。ID 记录持续增长、以前已删除的 ID 和降级 Worker 的旧
重试行为仍是上述限制。

创建 PR 前，根目录 `pnpm format` 通过。已尝试根目录 `pnpm check`，但未修改的
Devin adapter 缺少本地 `node_modules` 与依赖/类型声明，构建阶段停止，未进入
完整根目录 lint/test 阶段。实现验证仍以上述局部检查为依据。
