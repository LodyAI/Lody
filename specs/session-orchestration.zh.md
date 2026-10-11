# 会话编排

Status: draft
Translation: current

[English](session-orchestration.md)

Agent 通过 Lody 委派异步工作时，每个委派目标都会从发起它的人类 Turn
继续同一条因果链。Lody 最多接受 16 次这样的跳转。已经处于深度 16 的
Turn 再发起命令时，会在创建 Operation 或目标 Session 之前被拒绝，并返回
不可重试的 `CHAIN_DEPTH_EXCEEDED` 错误。

这个深度表示因果委派次数，不是通用的 `parentSessionId` 树深度。创建
Session、向另一个 Session 发送工作、以及投递 Operation 完成通知，都会让
目标 Turn 增加一层。普通人类 Turn 缺少深度时从零开始。这个上限仍是共享
协议中的固定值；修改它必须同步更新所有生产者、恢复路径、可执行模型和本
Spec。

实验性的 Review agent 自动化已移除，不再在 MCP 委派链之外运行。
参见 [Review agent 移除](review-agent-retirement.zh.md)。

## 会话创建配置

编排 Agent 可以通过 `lody_session_create` 和 `lody_session_create_many`
选择目标 Agent 公布支持的配置，无需创建 Agent Role。可选的 `modeId`
使用 ACP mode id；`configOptionValues` 使用真实 option id，值为字符串或布尔值。
所有公布的 option 均可选择，包括没有类别的权限项。发现接口返回 mode 和 option
的 id、类型、可用值，不返回当前值或启动配置。

创建复用 CLI 的目标能力校验。不支持的 mode、未知 option id 和非法值，在单个
Operation 接受前被拒绝；批量各项失败仍彼此隔离。批量 defaults 与 items 浅合并，
item 的 map 整体替换 defaults map。Raw options 保持 CLI 现有继承合同：提供的
map 整体替换继承 map。显式 raw mode/model selector 覆盖继承的标量 selector。
省略两个新字段时，保持已有继承和受支持的内置默认值。

显式语义 model、reasoning、Fast 和 Plan 保持既有优先级，解析不得丢掉无关 raw
option。独立 Plan option 可以与权限共存。旧式 Plan 若占用 ACP mode `plan`，
则拒绝不同的显式 mode，不能静默覆盖。显式 Role 仍具有完整优先级：手填目标和
配置字段在能力校验、命令身份和派发前被忽略。

显式权限可能宽于父会话。调用方必须遵守获得的用户授权。本接口不新增权限等级、
升级审批政策，也不形成相对 CLI 创建路径的安全边界。通过 `lody_session_chat`
修改已有会话不在本次范围。

显式 selector 参与 canonical command 指纹。Map 键顺序变化仍是同一请求；已接受
Operation id 下更改选择返回 `OPERATION_ID_REUSED`。接受时冻结各目标的有效派发
配置。重试和恢复使用冻结配置，不重新计算 requester 默认值或 Role 配置。
不需要 Operation 存储迁移。

## 运行时拒绝模型

请求被接受后，如果 agent 拒绝所请求的模型，必须产生 GUI 可见的
`agent_warning`，标明被拒绝的模型；Codex 和 Claude 同样适用。创建会话及后续
Turn（包括 resume）均遵守这一规则，无论模型通过 `modelId` 还是 agent 公布的
config option 传入。运行时状态仍反映 agent 确认的实际模型。报告复用现有异步
警告路径，不中止 Turn，也不保证在 prompt 开始前完成显示。

## 冻结 turn 输入

带 Role 的首次启动失败后，即使重试走不同执行路径，也必须保留已接受的指令和附件。
turn 的 `inputConfig.prompt` 是有效的冻结文本，包含接收时组合的 Agent Config 和 Role
指令。`inputBlocks` 保留用于展示、编辑的原始文本及用于执行的结构化附件；原始文本不能
覆盖冻结 prompt。

create、continue、steer 和恢复使用同一解释规则。Role 身份、revision 和 snapshot 仅记录
来源，不要求重新解析当前 Role。缺少 prompt 的旧输入从已有 blocks/history 派生文本；
显式空 prompt 表示没有执行文本，可以携带附件。运行时指令、附件落地和历史回放与冻结任务
分离，因此整个 provider 请求不要求字节完全相同。

## 本地与云端执行

OSS 的 Agent Role mention 必须无需 Lody 账号、无需经过产品云端认证请求即可
创建工作。Session/catalog MCP 调用进入持有本地 workspace 的 daemon，由正在
执行的 Turn 提供身份，校验精确的本机与项目，并运行与 Cloud 共用的 Role 解析
和持久化 Operation 状态机。支持已注册的本地项目和普通聊天；托管仓库上下文
仍不可用。

恢复使用冻结的 prompt、Role revision 和派发配置。重放缺失的目标输入前，
Cloud 确认远端文档追平；OSS 确认权威 daemon repo，并在已有创建 claim 下重新
检查固定 Turn。Cloud workspace 不能把云端断连当成本地权威。完成回传继续
使用已有的单一所有者 Delivery 协议，不需要持久化 schema 或托管 API 变更。

## 幂等消息消费

A 给 B 发送任务、B 完成后，重复通知、重试和 Worker 替换不得使 A 再次消费同一条
完成消息。身份是机器本地的 `(requesterSessionId, operationId)`，对应固定的目标输入、
Delivery 和完成 Turn。重试保留这组 ID 以及原始来源 Turn、请求人和命令。新的 Operation
id 表示新任务，即使文本完全相同；不能按内容相等去重。

接受任务和完成任务使用 SQLite 事务。Host-lease Worker 在请求方 Session 的互斥锁下
认领 Delivery，写入固定完成 Turn，再记录 `prepared`；提交给 ACP 之前先持久化
`started`。确认发生在 provider 提交之前的中断可以释放准备状态并有限恢复。提交之后，
Delivery prompt 绝不自动再次提交。连接断开时，即使尚未观察到输出，也不能证明没有被
消费；保留完成消息和输出，并显示 `DELIVERY_EXECUTION_UNCERTAIN`。启动恢复遵守相同
规则。成功或取消的结算消费 claim；结算写入失败只重试结算，不重新执行 provider。

持久化去重和消费确认属于消息编排存储，不属于模型 provider 协议。所有运行时使用
相同行为，不修改 ACP client、adapter 或协商能力。重复通知只协调同一条持久化 Delivery；
成功结算持久化消费状态，结算写入失败后只继续结算同一 claim。这保证每条完成消息
至多提交一次，不保证在持久化启动检查与提交之间崩溃时模型仍能成功执行。
普通用户 Turn 的旧连接恢复保留原有行为。

已消费结果七天后可以过期，但清理必须原子地保留不含 prompt 或输出的精简 retired-id
记录。同一存储内不能再次接受该 ID，数据库触发器也阻止旧版写入方重新插入。
新版调用方收到不可重试的 `OPERATION_ID_REUSED`；过期结果的查询仍返回不存在。
记录随已完成 Operation 数量增长。删除存储会重置此保证；迁移之前已经删除的 ID 无法
重建。降级运行的 Worker 仍保留其旧版 ACP 重试行为。

## 实现证据

实现检查位于 `apps/cli/src/mcp/lody-mcp-server.ts`，共享上限位于
`packages/shared/src/session-orchestration.ts`，可执行 Operation 模型位于
`apps/cli/src/orchestration/operation-model.ts`。

消费和保留策略位于 `apps/cli/src/orchestration/operation-store.ts`，续接提交位于
`apps/cli/src/session/session-execution-service.ts`，协调恢复位于
`apps/cli/src/orchestration/operation-coordinator.ts`。对应测试覆盖连接失败、claim 和结算
竞争、重启以及结果过期。

本草稿记录将上限改为 16 的请求。依赖安装后仍需补充运行时和已发布客户端
验收。

## 用户终止整棵对话树

关联对话树提供需要二次确认的整树终止操作，范围遵循创建与包含关系。
持久化、由用户控制的停止状态阻止执行、MCP 委派和自动回传唤醒，直到用户明确恢复协作。
运行中的回合沿用正常取消流程；待处理输入保留但不提升执行。
晚到的完成结果保留，并记录 `COLLABORATION_STOPPED`；恢复后不重放该续接。
快照之后创建的后代继承祖先停止状态。仅通过 MCP 联系的无关已有对话不在此范围内。

界面写入状态前，所有目标机器必须声明支持此能力。离线机器收到状态后才会执行停止；
界面不得承诺所有机器同时停止，也不回滚已经完成的操作。
