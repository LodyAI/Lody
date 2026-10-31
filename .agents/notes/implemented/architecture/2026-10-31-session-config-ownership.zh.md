# 会话配置由一个执行端拥有

Status: implemented
Translation: current
Supersedes: [仅警告的模型拒绝策略](../../archived/bug-fix/2026-10-09-model-rejection-gui-warning.zh.md)

[English](2026-10-31-session-config-ownership.md)

## 摘要

历史正文未加载时，旧机制可能丢弃运行时报告并恢复较旧的 Plan 请求。当前配置改由执行连接拥有；输入框只组合已确认快照与私有编辑。冻结输入是执行要求，不是下一条草稿的基线。必要配置失败会阻止提交，并保留实际已成功的部分变更。

## 决定与替代方案

[Spec](../../../../specs/session-config-ownership.zh.md) 定义所有权。连接代次隔离观察事件，即使 ACP 复用 session id；revision 为发布排序，不依赖历史。首次执行端准入在配置发布串行队列内检查捕获的 revision。已有不可变 Roost 回执在重试、重启后不再检查；本地等待附件的准入不等于该回执。队列保留冻结值。

仅使用索引修复正文加载问题仍保留多个基线；移动优先级链到另一个 hook 也保留歧义。通用命令总线或整个 Session 迁移超出配置职责。因此继续使用既有 SessionDocument 控制持久化与原始请求释放所有者。

[等待发送记录](../bug-fix/2026-09-30-composer-pending-send-config.zh.md) 继续约束 Role/MCP 来源，其运行配置桥接被替代。[私有草稿](../bug-fix/2026-10-07-session-run-config-drafts.zh.md) 仍负责捕获编辑代次的消费；模式、模型及依赖选项的[顺序](../bug-fix/2026-10-13-acp-model-effort-order.zh.md) 仍必要。原先仅模型拒绝发出警告且继续执行，现所有 provider 的必要配置拒绝都会失败。公开错误标识字段，不暴露请求值或 provider 原始载荷。

## 生命周期与原生边界

已接受输入触发 Turn 拥有的原生 Effect 应用：读取已建立连接，发布 applying，依次应用模式、模型及选项，验证实际结果，并在 prompt 前等待本地持久化，不等待云同步。Provider 变更不具备事务性；模式成功、模型拒绝时保留实际模式及 failed 状态，不回滚、不换协议重试。只有已选操作的旧式成功确认可作为证明；方法或响应缺失不算成功。

取消中断等待并阻止后续变更与提交，不代表已发 SDK 请求停止。AgentClient 用既有 pending-execution 所有者保管原始 Promise。未知结果交给既有 Turn 释放与连接退役，不自动重放输入。新连接使用新代次。通知发布脱离历史批处理，并保留 applying/failed/unknown 状态。通知写入失败可见并标记 unknown，不重放或静默取消正在运行的 prompt。本地写入错误只阻止依赖提交，不阻塞其他会话或 Stop。

`AcpConfiguration` 是 SDK 操作的窄服务；应用器及初始、恢复两个消费者组合原生 Effect。匹配的 steer 不应用配置。AgentClient 传输、进程释放及 SessionDocument Repo 持久化仍是上游 Promise 边界，不能宣称完整 ACP 或 Session 生命周期迁移。[迁移台账](../../proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.zh.md#单元台账) 记录此限制。没有新 runtime、cache、后台重试或期望状态存储。


本地 owner 重启时会作废磁盘中的旧确认快照，直到新连接接管。接纳与 steer
要求当前 revision 已完成本地持久化，仅出现在 mirror 中不算确认。steer 在异步
准备结束、真正注入前同步重查连接、持久化确认和请求值；明确不匹配进入普通队列，
不确定则直接失败。配置结果不确定时在 Turn 释放阶段关闭旧连接。

## 兼容性与证据

更新客户端以 `sessionConfiguration` v1 限制发送；旧机器仍可读取历史及 Stop。旧快照不能建立确认。打开会话不启动 Agent；未指定字段在执行时继承，具体值必须应用。历史导入不创造当前状态；Fork 发布目标连接真实响应。能力删除保留具体选择并报错，不静默换默认值。

合成行为测试覆盖部分拒绝、矛盾确认、false、中断、复用 ACP id、本地写入失败、准入与重启、冻结队列、正文缺失及草稿保留。仓库级检查及打包、真实 provider UI 验收需另行报告，不代表已证明每次线上反馈的具体原因。
