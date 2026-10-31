# 会话配置由一个执行端拥有

Status: implemented
Translation: current
Supersedes: [仅警告的模型拒绝策略](../../archived/bug-fix/2026-10-09-model-rejection-gui-warning.zh.md)

[English](2026-10-31-session-config-ownership.md)

## 摘要

历史正文未加载时，旧机制可能丢弃运行时报告并恢复较旧的 Plan 请求。当前配置改由执行连接拥有；输入框只组合已确认快照与私有编辑。冻结输入是执行要求，不是下一条草稿的基线。必要配置失败会阻止提交，并保留实际已成功的部分变更。

## 决定与替代方案

[Spec](../../../../specs/session-config-ownership.zh.md) 定义所有权。连接代次隔离观察事件，即使 ACP 复用 session id；revision 为发布排序，不依赖历史。Loro 首次执行端准入只拒绝低于已加载会话 revision 的用户输入。检查、机器本地 Inbox 持久接纳和回执查询共用配置发布串行队列。该回执或 Roost 不可变历史接纳回执使重试、重启跳过重复检查；renderer outbox 不等于 owner 接纳。历史请求重建与队列提升保留冻结要求。

已加载 revision 与原生连接确认是两种证明。Loro 崩溃重开或文档尚无 revision 时，只等待已有的初始房间同步，受 30 秒配置预算限制，再读取已加载 revision，不把旧代次当作新连接确认；正常派发随后加载或建立原生连接，并在 prompt 前确认、持久化所需配置。加载失败、超时或仍缺 revision 时走既有可见的执行前失败与输入终态，不让输入永久 pending；晚到同步不会复活该输入。关闭时取消本地等待，保留原输入供下次启动处理，不写入晚到失败；底层同步仍由既有文档所有者保管。加密准入只读 native 已验证的受保护会话文档，不用 RPC 或元数据的当前 revision hint。Roost 的连接确认准入和原生 steer 确认规则保持不变。

可信系统派生输入仍需动作及来源 authority、接纳前守卫批准，随后进入既有 Inbox。继承 revision 作为冻结来源保留，不按用户新配置选择比较；后续队列提升和重试复用 owner 回执。仅提供 `_lodyAutomation` 字段不能取得权限，加密工作区的 Automations 产品策略仍保持禁用。

Loro 首次输入 revision 陈旧时，在 Turn 建立前写入持久 `chat_failed` 提示及失败终态。拒绝与接纳共用串行队列，重复投递不会重复提示或执行。原文和冻结配置保留在历史中；显式恢复使用当前已提交配置创建新输入，不复活旧执行或改写其冻结配置。失败提示写入错误继续向外报告，不视为成功准入。

仅使用索引修复正文加载问题仍保留多个基线；移动优先级链到另一个 hook 也保留歧义。通用命令总线或整个 Session 迁移超出配置职责。因此继续使用既有 SessionDocument 控制持久化与原始请求释放所有者。

[等待发送记录](../bug-fix/2026-09-30-composer-pending-send-config.zh.md) 继续约束 Role/MCP 来源，其运行配置桥接被替代。[私有草稿](../bug-fix/2026-10-07-session-run-config-drafts.zh.md) 仍负责捕获编辑代次的消费；模式、模型及依赖选项的[顺序](../bug-fix/2026-10-13-acp-model-effort-order.zh.md) 仍必要。原先仅模型拒绝发出警告且继续执行，现所有 provider 的必要配置拒绝都会失败。公开错误标识字段，不暴露请求值或 provider 原始载荷。

## 生命周期与原生边界

已接受输入触发 Turn 拥有的原生 Effect 应用：读取已建立连接，发布 applying，依次应用模式、模型及选项，验证实际结果，并在 prompt 前等待本地持久化，不等待云同步。Provider 变更不具备事务性；模式成功、模型拒绝时保留实际模式及 failed 状态，不回滚、不换协议重试。只有已选操作的旧式成功确认可作为证明；方法或响应缺失不算成功。

取消中断等待并阻止后续变更与提交，不代表已发 SDK 请求停止。AgentClient 用既有 pending-execution 所有者保管原始 Promise。未知结果交给既有 Turn 释放与连接退役，不自动重放输入。新连接使用新代次。通知发布脱离历史批处理，并保留 applying/failed/unknown 状态。通知写入失败可见并标记 unknown，不重放或静默取消正在运行的 prompt。本地写入错误只阻止依赖提交，不阻塞其他会话或 Stop。

`AcpConfiguration` 是 SDK 操作的窄服务；应用器及初始、恢复两个消费者组合原生 Effect。匹配的 steer 不应用配置。AgentClient 传输、进程释放及 SessionDocument Repo 持久化仍是上游 Promise 边界，不能宣称完整 ACP 或 Session 生命周期迁移。[迁移台账](../../proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.zh.md#单元台账) 记录此限制。没有新 runtime、cache、后台重试或期望状态存储。

原生 steer 在异步准备结束、真正注入前同步重查连接代次、已持久化确认和请求值；明确不匹配进入普通队列，不确定则失败。配置结果不确定时在 Turn 释放阶段关闭旧连接。Loro 首次准入读取会话 revision，不以这种原生连接确认作为重开前提。

## 兼容性与证据

更新客户端以 `sessionConfiguration` v1 限制发送；旧机器仍可读取历史及 Stop。旧快照不能建立确认。打开会话不启动 Agent；未指定字段在执行时继承，具体值必须应用。历史导入不创造当前状态；Fork 发布目标连接真实响应。能力删除保留具体选择并报错，不静默换默认值。

合成行为测试覆盖部分拒绝、矛盾确认、false、中断、复用 ACP id、本地写入失败、准入与重启、双 Loro 客户端的陈旧首次输入、已验证加密会话准入、冻结队列、正文缺失及草稿保留。仓库级检查及打包、真实 provider UI 验收需另行报告，不代表已证明每次线上反馈的具体原因。
