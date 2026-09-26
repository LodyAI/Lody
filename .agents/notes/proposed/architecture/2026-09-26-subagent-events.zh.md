# 在扩展边界统一 provider 子 agent 事件

Status: proposed
Translation: current

[English](2026-09-26-subagent-events.md)

## 摘要

Builtin provider 对子 agent 暴露的能力不同：独立子 transcript、任务摘要，或可查询
的输出尾部。Lody 此前既没有消费原生子会话生命周期，也没有保存其他子 sessionId
的输出。建议在 Core 中统一为三种事件，明确每次执行的能力，并复用 ACP 内容。
代价是增加扩展适配工作，收益是明确显示输出缺失，而非假装所有任务都有完整实时
transcript。Codex 首轮已在本地实现并进行合成测试；其他 provider 仍是提案，
尚未证明真实发布运行包与源码行为一致。

## 事件清单

目标 schema 和语义见 [draft Spec](../../../../specs/subagent-events.zh.md)。
下表箭头表示目标映射，本次仅实现 Codex。

| Provider | 原生输入及现有扩展输出                                                                                                                                                                  | 建议映射与限制                                                                                                                                                              |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude   | SDK `task_started`、`task_progress`、`task_updated`、`task_notification`；子消息携带 `parent_tool_use_id`。原生 ACP 模式输出 `subagent_spawned`、`subagent_state_update` 和普通子更新。 | 开始/metadata/结束事实 → snapshot；摘要/当前工具/usage → progress；子文本/思考/工具 → output。只收真正的子 agent 任务，Bash/后台/计划任务保持独立。                         |
| Codex    | `collabAgentToolCall`、`subAgentActivity`、子 `turn/*`、`item/agentMessage/delta`、reasoning 与工具 `item/*`。扩展已有原生 ACP spawn/state 和子输出。                                   | 生命周期 → snapshot；子内容 → output。不提供原生没有的数值进度。工具活动可保留在 output，不必合成计数。终态 thread 再使用需要新执行身份。                                   |
| Grok     | `_x.ai/session_notification` 中的 `subagent_spawned`、`subagent_progress`、`subagent_finished`；子普通 ACP 输出；xAI `tool_call_delta_chunk` 携带参数原始片段。                         | 生命周期 → snapshot；耗时/轮次/工具/context/错误 → progress；子 ACP → output。参数片段在扩展内有界缓冲后转换为有效 ACP 工具更新，不将不完整 JSON 当成完整输入。             |
| Kimi     | 主 agent `task.started` / `task.terminated` → Core `_meta.lody.task`；list/output/cancel 接口。子执行器在完成后写入 output。                                                            | snapshot 和最终摘要；stream 为空；outputRead 为 final_tail。ACP 订阅主 agent 内容而非子增量，实时输出需要新增引擎到扩展的订阅。                                             |
| Pi       | 子 `message_update(text_delta)` 追加有界缓冲；`tool_execution_start` 发布 lastToolName；子退出发布生命周期。支持 Core list/output/cancel。                                              | snapshot 和 progress；outputRead 为 live_tail；当前 stream 为空。转发已接收 delta 即可增加文本流，但尚未发布。工具名是进度，不是完整工具调用；思考/工具结果流还需额外工作。 |
| DSH      | preset 的 subagent/spawn/fork/control 工具；ACP 只处理已注册、归属自己的 Agent/session 事件。                                                                                           | 原有父工具调用继续作为父输出，不能仅从 title 推断子任务。声明规范生命周期/输出前，需要专门的子发现、归属和事件订阅。                                                        |

只有为所选 runtime 实现并验证后才声明对应 stream 类别。目标 schema 允许 plan，
但不声称每个 provider 都提供。取消独立协商，支持原生 spawn/state 不代表支持取消。

## 理由与替代方案

1. 三种事件，而非一个巨大 provider 联合：完整任务快照明确恢复状态，稀疏进度
   保留可选观测，ACP output 保留既有富内容和工具行为。UI 只需一个 reducer。
2. 一次执行不等于一个 agent：Codex 可重新激活终态 thread，仅按原生 agent ID
   分组会混合不同执行，也会错误接纳迟到输出。
3. 失去观测不等于执行失败。现有任务状态会合并多种结果，新投影保留 cancelled、
   unknown 和原因；不改写旧行来推断从未保存的事实。
4. 进度与计费分开。Grok context 占用不是累计计费，各 provider 子 usage 口径也不同。
5. 查询与推送分开。Pi 的重复文本尾部会重叠，Kimi 的 output 在结束后才出现；
   将 `output: true` 称为实时 transcript 会过度承诺，还可能重复内容。
6. 使用 ACP 投递顺序，不在 envelope 增加流 ID 和序号。保持初版契约精简，
   不暗示 provider 未提供的回放保证。重连时标记观测不完整，后续历史恢复需要
   独立的对账契约。

替代方案是端到端使用原生 ACP 子会话，仅添加 Core 进度 metadata。它直接遵循
草案，也省掉新内容 envelope，但要求宿主支持多 wire identity、草案变体与 xAI
转换；只有任务能力的 provider 仍需合成子会话。建议的 envelope 复用 ACP 载荷并
集中适配。审阅可选择原生传输，而不改变三种概念事件分类。全部轮询较简单，但丢失
工具/思考保真度并引入重叠快照；只统一生命周期不满足查看执行细节的要求。

## 证据、版本与待完成事项

### Codex 首轮实现

配套 PR：[Core 契约](https://github.com/LodyAI/acp-extension-core/pull/15)与
[Codex 扩展](https://github.com/LodyAI/acp-extension-codex/pull/56)。
独立发布 Codex 扩展前，需要先发布 Core 并更新对应依赖版本。

用户要求先验证 Codex，再接入其他 provider。Core 所有 `_lody/subagents/event`
校验及双向 v1 能力协商。Codex 复用现有原生路由，将重新使用的执行映射为新的
不透明 run ID，不合成数值进度。客户端在转发事件或接受授权请求前验证根/run
归属。子权限工具在根交互路径使用命名空间 ID，规范子输出保留原生 ID。

```text
Codex 子事件 → Core envelope → AgentClient → HistoryWriter
                                             └─ subagent_task.run
                                                ├─ snapshot / progress
                                                └─ text / thought / tool / plan
```

每个 run 保留在发起它的 assistant entry 内，后续轮次接收的更新也不迁移归属。
工具 enrichment 按 run 隔离，权限镜像不重复记录编辑证据。Message/turn 身份仅
属于子执行，旧历史继续兼容。Daemon 声明 `subagentEvents` v1 控制新实时 UI，
离线仍可阅读已存历史。按要求将 UI 委派给 UI Designer Role：紧凑列表显示最新行动，
弹窗显示全部已保留历史。

不引入 `streamId`、序号、回放保证或新调度器。断连保留部分历史并标为未知/不完整。
不声称支持单独取消或输出查询。非文本消息块目前会将 transcript 标为不完整，
工具富内容保留。不增加 transcript 上限。Codex 扩展随应用构建，因此首轮不更改
其原生 runtime pin。

行为验证覆盖协商、授权归属、断连、嵌套/复用执行、迟到输出、跨轮次持久化和工具
隔离。其他适配前仍需真实 Codex 测试。全部 provider 上线及持久化重连映射仍是
提案，因此 Note 保留 `proposed`，Spec 保留 draft。

验证：Core 7 项、Codex 协商/协作 33 项、宿主定向 109 项、面板交互 12 项、对话
读取 21 项以及共享层全量 1,182 项测试通过。相关类型检查、lint、文档和边界检查
通过。Codex 全量运行有 811 项通过，未改动的符号链接路径测试有两项失败。
更广泛的宿主/UI 测试遇到未改动的 GitHub shim 失败和 provider 弹窗超时后停止，
不声称全仓检查全绿。
UI Designer 检查了亮色/暗色 Storybook 截图，但历史使用替身渲染器；真实工具/思考
渲染仍需桌面端及真实执行验证。

### 源码清单

- Claude pin `f88c966a`，Codex pin `5e18d2a0`，Grok wrapper pin `21768816`，
  DSH pin `48dc9556`，Kimi 源码 pin `4befe38f`，Pi 源码 pin `49570ee8`。
- Kimi 托管源码为 `d4caf044fe0c`，Pi 为 `e6debc2f6aac`，检查到的任务/输出限制
  相同。源码 gitlink 不等于托管包，新能力必须发布并更新 artifact pin。
- Grok 公开源码 `f0e3be11` 为 1.0.41，同样的生命周期/进度在公开 1.0.38 快照
  `4247f661` 已存在。没有找到精确的 1.0.40 快照/tag，Lody 的 1.0.40 二进制未验证。
- 宿主 `AgentClient.sessionUpdate` 拒绝其他 sessionId；initialize 不声明原生
  subagents。Grok wrapper 透传未处理通知，宿主不解释 xAI 子生命周期通知。
- 已有[客户端接口收敛决策](../../implemented/simplification/2026-09-12-subagent-client-surface.zh.md)
  删除了未使用的宿主 list/output wrapper。本提案增加实际 UI 消费者，不声称那些
  wrapper 仍存在。[唯一写入者决策](../../implemented/architecture/2026-09-07-single-history-writer.zh.md)
  继续约束持久化所有权。
- 没有真实 provider 执行。后续 provider 工作需要按需发布运行包、确认原生身份
  与恢复证据，并测试各扩展的事件顺序和有界输出尾部行为；Codex 测试不能证明
  其他 provider 具有同样能力。

源码入口：[Claude 路由](../../../../packages/acp-extension-claude/src/native-subagents.ts)、
[Codex 路由](../../../../packages/acp-extension-codex/src/subagents/CodexSubagentEventRouter.ts)、
[Kimi ACP](../../../../packages/acp-extension-kimi/packages/acp-server/src/session.ts)、
[Kimi 任务输出](../../../../packages/acp-extension-kimi/packages/agent-core-v2/src/agent/tools/agent/subagent-task.ts)、
[Pi 任务](../../../../packages/acp-extension-pi/src/subagents.ts)、
[DSH 适配](../../../../packages/acp-extension-dsh/src/adapter.ts)、
[Grok 事件](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-shell/src/extensions/notification.rs)、
[Grok 路由](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-shell/src/leader/server.rs)。
