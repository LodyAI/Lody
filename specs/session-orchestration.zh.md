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

## 回复当前任务的发信人

当 A 的 Agent 输入驱动 B 的当前 turn 时，B 不能再向 A 创建新的 chat。
单条和旧兼容 chat 在派发前返回不可重试的 `REVERSE_CHAT_FORBIDDEN`。
批量中指向 A 的项独立失败；全部指向 A 的批量在接受 Operation 前拒绝。
其他目标仍可使用；已经接受的重试继续保留固定身份。

限制依据当前准确输入的发信人，不依据会话父子关系或更早的历史。
后来由用户或另一个会话发起的输入替换这个范围。识别需要已知的 Agent
发信人来源；缺少来源的旧输入继续可读并保留原行为。本次不新增留言工具，
也不改变结果派发时机。

## Agent chat 发给正在工作的会话

编排 Agent 会向仍在工作的会话补充纠正或新信息。只要目标在发起调用的同一
Machine 上运行，且其 agent 接受 steer，`lody_session_chat` 和
`lody_session_chat_many` 就把输入 steer 进当前 turn，不受用户排队或引导偏好
影响，也不管当前 turn 由谁发起。被 steer 的输入有自己的回复，作为 Operation
结果；被它打断的更早 turn 在该处结束。

能证明未送达的 steer 与人类发送一样转为下一个普通 turn。送达不确定时绝不重放：
该项以不可重试的 `STEER_DELIVERY_UNKNOWN` 失败，由发起请求的 Agent 决定是否重发。
空闲目标、其他 Machine 上的目标和恢复重放仍走普通派发。证据：
`apps/cli/src/commands/session.ts` 中的 `sendSessionChatResult`、其测试
`session-default-fallback.test.ts`，以及 `apps/cli/src/orchestration/coordinator-workflow.ts`
中的项协调。

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

CLI `lody session create --agent-role <idOrName>` 按固定 id 或唯一名称解析同一
目录中的 Role。Role 的 machine、代理配置、运行配置和 Prompt 前缀具有优先级；
被覆盖的手填参数会以警告形式报告，`--repo`、`--local-project`、`--branch`、
`--worktree` 等工作上下文参数仍然有效。

显式权限可能宽于父会话。调用方必须遵守获得的用户授权。本接口不新增权限等级、
升级审批政策，也不形成相对 CLI 创建路径的安全边界。通过 `lody_session_chat`
修改已有会话不在本次范围。

显式 selector 参与 canonical command 指纹。Map 键顺序变化仍是同一请求；已接受
Operation id 下更改选择返回 `OPERATION_ID_REUSED`。接受时冻结各目标的有效派发
配置。重试和恢复使用冻结配置，不重新计算 requester 默认值或 Role 配置。
有效继承的 mode/model/options 保留内部来源；重放保留兼容值、丢弃不兼容的继承值，
即使目录新鲜度未确认也不改变该行为。当前显式选择仍须严格校验。首次校验和冻结
重放时，effort 与 Fast 都使用最终目标模型。

内部合成的内置模式保留独立来源，避免把回退默认值误判为用户显式选择。固定
UserTurn 写入前，根据可用能力重新推导默认值。物化中断后的重放仅保留冻结的
继承或合成来源能够产生的已有值，不改写历史，也不放宽完整的不可变输入身份
校验。来源字段不属于公开 MCP 输入或会话历史。旧的继承默认值标记仍可读取，
无需存储迁移。

## 运行时拒绝模型

必要模型选择遵循[会话配置所有权](session-config-ownership.zh.md)。所有 provider 的拒绝、矛盾确认或未知结果都会在 prompt 提交前使输入失败，模型配置选项及恢复执行同样适用。已确认的部分配置保持可见；错误标识字段，不暴露 provider 原始载荷。不得替换模型并继续被拒绝的输入。

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
检查固定 Turn。Cloud workspace 不能把云端断连当成本地权威。完成结果在同一
Operation 事务内直接写入原生 Inbox，执行遵循下方消费规则。此次改动本地持久
存储，不改托管 API。

## 启动时 Inbox 数据库不可用

打开或激活 Inbox 失败不能阻断工作区启动和普通人类对话。通过现有运行时 warning
通道提示降级；依赖 Inbox 的 Agent 任务和自动续跑调用返回明确的不可用错误，
不访问该数据库。coordinator 持有有上限的退避恢复，并在关闭时取消；schema/protocol
不兼容时不自动重试。恢复保留已有提交证据，绝不重放结果未知的输入。鉴权、E2EE
以及本地／云端边界保持不变。

## 幂等消息消费

Operation 完成回执持久入队并携带唤醒资格。会话空闲、未暂停、没有活动执行及已接受的排队输入时，一个可唤醒回执即可产生持久自动派发意图。忙时等当前执行交还槽位；Stop 后等新的用户输入或 Agent chat 输入。回执与空闲派发意图在同一完成事务保存，重开无需新事件即可恢复未提交意图。Agent 发起的回合不发用户完成通知，但仍产生 Operation 回执及其唤醒资格。

唤醒资格与批次成员分开：一个可唤醒回执带上同一会话／用户队列中全部未消费、未认领结果，包括被动结果。认领批次时才取当前水位并固定成员；认领前到达的一起合批，认领后到达的进入下一批。重复回执／释放不产生重复执行，空队列不启动；已提交或提交未知成员不能再次进入批次。

Stop、新输入接受和实际提交使用同一个会话准入。支持 Inbox 的 Stop 先持久暂停，取消此前排队输入的执行资格并保留其历史。暂停只阻止自动完成回传唤醒；Stop 之后由用户或其他会话的 Agent chat 发来的新输入同级处理：照常接受、解除暂停并携带已保存结果，旧指令需重新发送才执行。来源回执只决定输入是否记为 human。失败退出本身不触发续跑；槽位退役后，新可唤醒回执可以触发执行，后续轮次继续遵循回执驱动规则。

无法确认资源释放时，不阻塞后续输入。中断的执行直接退役，旧输入以结果未知结束且不重放，清除历史阻塞并保留排队工作。给出提示并在后台有上限地清理；清理失败不能阻止发消息或关闭。终止失败的 Agent 不得复用：移除旧 Session，下一轮新建 ACP。启动退役时没有历史写入路径可以只记警告。清理状态永远不参与准入判断，也不需要离线人工确认。

自动批次给提交前接受的新用户输入让位，成员与新绑定原子转移；正在准备的普通用户输入不因后来排队的新输入被取消。提交栅栏与实际 transport 启动间不释放准入，也不插入异步检查。Stop 后新输入解除暂停不能复活已取消的旧执行。执行 ID 与排队输入 ID 独立。

批次成员与 batchId 固定。用户 prompt、附件、配置及深度独立，结果作为资料块；自动续跑深度为当前输入与成员最大深度再加一。禁止零成员自动批次。预览 64 KiB，完整内容通过绑定当前会话与用户的只读批次分页读取，每页至多 128 KiB；大单项用有序 JSON 分片，不另开模型轮次。

跨过提交栅栏后状态不明即 unknown，不能重发；用户消息只要携带批次，也禁止整份 stale-ACP 重发。失败写入只重试结算。原始请求与资源的真实释放不同于取消等待者或关闭 Scope；保留完整失败和共享关闭回执；恢复只使用旧句柄，不阻塞后继。

升级保留已发布的 Operation、作者／输入快照、任务恢复状态和退役 ID；未完成的 Operation 继续协调。只删除逐 Delivery 的存储和执行接口及未被新批次使用的兼容结果副本，旧完成通知积压不导入、不重放。当前 Inbox 的暂停、资源所有权、未知／已提交批次证据仍保留；删除数据不代表物理资源已经释放。Schema/protocol v2 要求 host launch v3；受支持启动入口先结束旧 Worker，再移交所有权，并在访问存储前拒绝旧契约。被动结果数据不算正在执行的工作。普通不带批次的用户恢复、当前 Operation ID 退役及整树停止规则保留。

新 Stop 发送方先核对目标机器的 Inbox v2 能力；没有该能力时省略 cancelId／pauseInbox，持久兜底使用原始 assistant Turn ID。新 CLI 将没有暂停协议字段的旧 Stop 作为普通执行取消，不设置旧客户端无法解除的持久 Inbox 暂停。缺失来源回执的输入仍不能猜成 human；支持 Inbox 的 Stop 保留上述暂停规则。

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

## 用户停止被委派的工作

用户手动停止目标对话中被委派的那条输入后，该目标以取消状态结束，仍可查询；但它的取消不会自动回执给发起 Agent，也不会随之后的用户或自动批次派发。重启和 deadline 协调均不能补发。目标中后来的新用户消息属于独立工作，不恢复这条回执。批量 Operation 只从自动回执中排除被手动停止的目标，其他目标照常回传；全部被排除时，不产生回执或唤醒。错误、超时与发起方明确取消 Operation 的行为不变。
