# 项目协调者模式架构与契约

Status: draft
Translation: current

[English](project-coordinator-mode.md)

## 场景与问题

在 Lody 中，一个项目往往横跨多个角色、多个代码仓库与多台机器上的大量对话。如果把协调者设计成所有消息都必须经手转发的“单点星形传声筒”，在实际协作中会遇到四类结构性瓶颈：

1. **直连沟通导致状态失步**：用户在右侧面板直接与子对话多轮讨论、修改实现或创建 PR 后，协调者对这些进展毫不知情，界面上仍挂着过期的动作建议卡片。
2. **缺乏多子对话协作编组**：一个完整任务经常需要多个子对话配合（例如 `A` 负责实现、`B` 负责独立 Review，或主仓库与 Submodule 分别由不同对话并行推进），按“1 个子对话 = 1 个任务”编号无法表达它们之间的协作归属。
3. **多产物与多 PR 关联受限**：同一任务可能关联跨仓库的多个 PR，以及 Issue、预览地址或导出文件等非 PR 交付物。
4. **高频共创与后台编排的边界模糊**：复杂方案讨论若经由协调者来回转述，既增加延迟又丢失细节；反之若子对话每聊一轮都唤醒协调者，又会造成通知噪音与 Token 浪费。

## 整体架构：单一窄腰 `Project Store` 与调和循环

项目协调者模式将 **控制面（Control Plane：意图拆解、选人组队、跨阶段接力、最终验收）** 与 **数据面（Data Plane：用户与子对话的高带宽直连共创及具体执行）** 分离，并围绕唯一逻辑窄腰 **`Project Store`** 收敛所有状态与事件流：

```mermaid
flowchart TB
  subgraph Producers["平级状态产生端 (彼此零直接依赖)"]
    Human["用户交互 (主窗对话 / 右侧直连子对话 / 看板操作)"]
    Workers["执行子会话池 (单兵 / 流水线成员 / 多仓并行成员)"]
    Connectors["连接器与插件 (Git / GitHub 多 PR / Issue / 定时触发)"]
  end

  Store[("逻辑窄腰: Project Store\nWorkItems (id, mode, members[], artifacts[], revision)\n+ 子会话单调轮次指针")]

  subgraph Consumers["独立视图投影与协调调和端"]
    UI["纯函数视图投影 UI = f(Store)\n任务组聚合 / 多 PR 徽章 / 过期卡片因果失效"]

    subgraph Reconciler["协调者调和闭环 (Reconciler)"]
      WakeGate["无状态唤醒门控 Wake Gate\nCodeMode 沙箱守望谓词 + 焦点在场抑制与防抖合并"]
      Coord["协调者会话 (持有本地已读游标 cursor)\n每次开轮统一读取 Store.diff(cursor..head)"]
    end
  end

  Human --> Store
  Workers --> Store
  Connectors --> Store

  Store --> UI
  Store --> WakeGate
  WakeGate -->|"shouldWake = true 时发送无状态 poke()"| Coord
  Store -.->|"有界读取未读增量 diff(cursor..head)"| Coord
  Coord -->|"写回编排意图 (建组 / 派发子对话 / 设 direct 直连 / 挂载守望条件)"| Store
  Store --> Workers
```

四个端点互不耦合：

- **执行子会话（Worker Sessions）**：只负责执行任务与响应用户直连输入，不感知协调者、看板或外部插件的存在。
- **连接器与插件（Connectors & Plugins）**：只负责把外部状态（PR、CI、Issue、定时事件等）同步为可观测资源与通用关联产物，不内嵌编排业务策略。
- **视图投影层（UI Surface）**：作为 `Project Store` 的纯函数投影，零模型开销地计算看板分桶、多仓库 PR 列表以及卡片是否已被子对话新进展超越。
- **协调者调和器（Coordinator Reconciler）**：无论因用户发话醒来，还是被 `Wake Gate` 的 `poke()` 信号唤醒，都走唯一输入路径读取 `Store.diff(cursor..head)`。

## 核心契约

### 1. `WorkItem`（`T1..Tn` 任务组）与小队拓扑

`WorkItem` 是介于 `Project` 与 `Session` 之间的一等任务单元：

- **成员编组（`1..N` 个子对话）**：普通单对话任务无需额外工具调用，自动以自身 `sessionId` 构成隐式单成员 `WorkItem`，界面保持单行极简展示；当多个子对话围绕同一目标协作（如 `implement` + `review` 流水线，或多仓库并行修改）时，协调者通过 `workItemId` 将它们归入同一任务组，并可标记各自的 `workItemRole`。将既有单对话任务升级为多对话任务组时，直接复用原主对话的 `sessionId` 作为 `workItemId`，其 `T<n>` 编号保持不变。
- **状态与多产物聚合**：`WorkItem` 汇总组内所有成员的运行态计算分桶（`needsYou`、`working`、`review`、`accepted`），对所有成员关联的跨仓库 PR 取去重并集（`pullRequests[]`），并支持挂载通用的 `externalRefs[]`（如外部 Issue、预览链接等）。验收（Accept）一个任务组会一并标记并归档组内全部成员对话。
- **协作模式（`delegated` | `direct`）**：
  - `delegated`（托管模式）：协调者负责派发简报、回收回执并生成下一步预测卡片。
  - `direct`（直连共创模式）：面对高歧义方案共创、复杂交互打磨或多轮高频微调时，协调者先为子对话注入背景，主动建议用户在右侧面板与子对话直接沟通，自身退居后台守望，避免中间传话损耗。

### 2. 物理存储归属

`Project Store` **不新建任何独立的 Loro Stream ID**，也**不引入跨会话写竞争**，物理上按职责分摊在三个既有存储容器中，由读端在内存拼装：

| 逻辑数据                                                                                      | 物理存储容器                                                                                                                   | 同步范围                                            | 核心保障                                                                                                                                               |
| :-------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workItems` 控制表（`id`、`taskNumber`、`title`、`mode`、`externalRefs`、`acceptedAt`）       | 协调者自身 `SessionDoc` 根级键 `workItems`（流 `{workspaceId}:s:{coordinatorSessionId}`，经 `sessionControlPlaneSchema` 读写） | 随协调者会话按需同步（天然继承 `doc` 级 E2EE 加密） | 不污染全局 `{workspaceId}:meta` 或 `{workspaceId}:wf:workspace`；删除协调者会话时随房间自动物理回收；旧客户端通过 `ignoreUnknownProperties` 安全忽略。 |
| 子会话归属外键（`workItemId`、`workItemRole`）、运行态、`latestUserMsgId` 与 `pullRequests[]` | 各子会话自身的 `SessionMeta`（流 `{workspaceId}:meta`）                                                                        | 随轻量 Meta Flock 同步（分组子会话仅增约 50 B）     | 远程机器上的子会话只写自己的 `SessionMeta` 与 `SessionHistory`，绝不跨房间打开或争抢协调者文档；`SessionMeta` 严禁写入对话正文摘要。                   |
| 动作卡片因果快照（`snapshotTurnBySession`）与处置记录 `actionResolutions`                     | 协调者历史中的 `coordinator_message.card` 条目                                                                                 | 随消息历史同步                                      | 发卡时冻结关联子会话当时的 `latestUserMsgId`，完全免疫跨机器系统时钟漂移（Clock Skew）。                                                               |
| 协调者已读游标 `cursor` 与守望探针状态                                                        | 协调者宿主机私有 SQLite（`operations.sqlite` 与 `automations/ledger.sqlite`）                                                  | 仅本机私有（不上云同步）                            | 高频游标推进与探针调度不产生任何跨设备网络广播。                                                                                                       |

### 3. 动作卡片因果失效机制

每当协调者通过 `lody_coordinator_send_message` 发出附带 `card` 的消息时，Daemon 自动读取该卡片关联子会话（及同一 `WorkItem` 下其他成员会话）当前的 `SessionMeta.latestUserMsgId`，冻结写入 `card.snapshotTurnBySession`。

- **前端即时折叠**：对于尚未被用户点击选择的开放卡片，一旦任一关联子会话当前的 `SessionMeta.latestUserMsgId` 与快照值不一致（说明用户已在右侧直接向子会话发送了新指令推进任务），卡片立即自动折叠隐藏。
- **CLI 隐式上下文防误绑**：用户后续在协调者输入框直接发送普通文本时，`resolveCoordinatorPromptReplyHeader` 会校验 `snapshotTurnBySession`；已被子会话新轮次超越的旧卡不再注入 `<related_card_context>`。

### 4. 业务无关的唤醒门控与有界增量读取

路由内核不包含任何硬编码的业务状态枚举（例如不把 GitHub PR 状态写死在内核中）：

- **按需懒摘要（`diff(cursor..head)`）**：用户在子会话内的日常多轮直连交流不唤醒协调者。当协调者下一次开启回合时，宿主机先在纯内存中对比 `SessionMeta` 与本地 `cursor` 筛出变动的子会话，仅对最近活跃的 Top-K 会话做有界并发（`<= 4`）的尾部瞬时读取生成紧凑增量摘要，并推进 `cursor`。
- **可编程守望探针（`CodeMode`）**：“什么算有进展”由运行在 `lody_automation` 沙箱中的轻量 JS 谓词按任务目标决定（可读取 `ctx.read` / `ctx.exec` / `ctx.fetch` 暴露的 PR、文件、测试结果或外部插件资源），命中时返回通用唤醒信号，未命中返回 `false`。
- **物理注意力闸门**：协调者自派 `Operation` 结束、子会话无人值守卡死/报错、以及守望探针命中统一经过物理注意力过滤——若用户此刻正聚焦在该子会话面板上则抑制唤醒，并在短防抖窗口内合并同批唤醒；若窗口期内用户已亲手在子会话发消息接管，则自动抵消挂起的唤醒。

## 性能与安全边界

- **流式与高频聊天零同步放大**：日常子会话多轮对话、流式输出与游标推进对 `workItems` 的写入量为 0 字节。
- **禁止全工作区打开房间扫描**：看板聚合与 `diff` 候选筛选只读内存中的 `SessionMeta`，绝不遍历打开未变动子会话的历史房间。
- **窄订阅隔离渲染**：协调者虚拟消息列表中的普通气泡零外部订阅，过期卡片集合在流容器层统一计算并按 Key 驱动未决卡片。
- **权限归属校验**：`lody_coordinator_work_item` 严格校验协调者会话身份与用户归属，禁止将其他用户的会话编入当前任务组。

## 依据与验证

- **已实现并验证（第一阶段 —— 黑板层、`WorkItem` 任务组、多 PR 全链路展示、卡片因果失效）**：
  - 共享契约与 Loro 控制面 Schema：[`packages/shared/src/coordinator-work-items.ts`](../packages/shared/src/coordinator-work-items.ts)、[`packages/shared/src/coordinator-actions.ts`](../packages/shared/src/coordinator-actions.ts)、[`packages/shared/src/schema.ts`](../packages/shared/src/schema.ts)、[`packages/shared/src/session-doc-schemas.ts`](../packages/shared/src/session-doc-schemas.ts)。
  - Daemon `lody_coordinator_work_item` 工具、`lody_coordinator_send_message` 自动冻结 `snapshotTurnBySession` 快照及 `<related_card_context>` 过期过滤：[`apps/cli/src/lib/loro/doc.ts`](../apps/cli/src/lib/loro/doc.ts)、[`apps/cli/src/mcp/lody-mcp-server.ts`](../apps/cli/src/mcp/lody-mcp-server.ts)、[`apps/cli/src/lib/coordinator-reply-context.ts`](../apps/cli/src/lib/coordinator-reply-context.ts)、[`apps/cli/src/lib/message-handler.ts`](../apps/cli/src/lib/message-handler.ts)、[`apps/cli/src/session/coordinator-system-prompt.md`](../apps/cli/src/session/coordinator-system-prompt.md)。
  - 前端任务组看板聚合、多仓库多 PR 徽章与卡片响应式失效：[`packages/components/src/components/project-mode/project-board-model.ts`](../packages/components/src/components/project-mode/project-board-model.ts)、[`packages/components/src/components/project-mode/project-board.tsx`](../packages/components/src/components/project-mode/project-board.tsx)、[`packages/components/src/components/project-mode/coordinator-action-engine.ts`](../packages/components/src/components/project-mode/coordinator-action-engine.ts)、[`packages/components/src/components/project-mode/coordinator-action-bar.tsx`](../packages/components/src/components/project-mode/coordinator-action-bar.tsx)。
  - 自动化测试：[`packages/shared/tests/session-doc-forward-compat.test.ts`](../packages/shared/tests/session-doc-forward-compat.test.ts)、[`packages/components/tests/project-board-model.test.ts`](../packages/components/tests/project-board-model.test.ts)、[`packages/components/tests/chat-virtual-rows-identity.test.ts`](../packages/components/tests/chat-virtual-rows-identity.test.ts)、[`apps/cli/src/mcp/daemon-session-tools.test.ts`](../apps/cli/src/mcp/daemon-session-tools.test.ts)。
- **已规划但尚未实现的后续阶段（第二、三阶段）**：
  - 主动建议直连的 `Handoff` 卡片与提示词切换策略、宿主机本地 SQLite `cursor` 持久化与 `<project_facts_delta>` 开轮懒注入，以及连接 `CodeMode` 守望谓词、焦点在场抑制与 `Session Inbox` `poke()` 唤醒的 `Wake Gate` 闭环。
- **关联文档**：[项目模式与协调者对话缺口梳理](../.agents/notes/proposed/feature/2026-11-11-project-coordinator-mode.zh.md)、[会话编排规范](session-orchestration.zh.md)、[Automations 规范](../apps/cli/src/automations/AGENTS.md)。
