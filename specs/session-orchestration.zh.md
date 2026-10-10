# 会话编排

Status: draft
Translation: current

[English](session-orchestration.md)

Agent 通过 Lody 委派异步工作时，每个委派目标都会从发起它的人类 Turn
继续同一条因果链。Lody 最多接受 32 次这样的跳转。已经处于深度 32 的
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

## 实现证据

实现检查位于 `apps/cli/src/mcp/lody-mcp-server.ts`，共享上限位于
`packages/shared/src/session-orchestration.ts`，可执行 Operation 模型位于
`apps/cli/src/orchestration/operation-model.ts`。

本草稿记录将上限改为 32 的请求。依赖安装后仍需补充运行时和已发布客户端
验收。
