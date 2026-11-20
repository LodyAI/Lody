# 侧栏状态视图与人类 Owner 指定

Status: draft
Translation: current

[English](sidebar-status-view.md)

## 场景

当用户同时并行推进多个 Agent 对话时，按时间排序或按实时执行状态分桶（需要你 / 运行中 / 刚完成 / PR / 空闲）会导致侧栏条目频繁跳动，破坏空间记忆。用户需要稳定的手动顺序来管理当下工作、清晰区分“进行中”与“稍后 / 已完成”的边界，并允许 Agent 在创建对话时查询工作区成员并指定或继承合适的人类负责人（`SessionMeta.userId`）。

## 行为

### MCP 成员查询与人类 Owner 指定

- `SessionMeta.userId` 保持为全仓唯一的人类归属与权限标识。
- 新增只读工具 `lody_member_list`，从工作区实际成员目录（`workspaceMembers.listForCliToken`，与 UI 的 `workspaceMembers.list` 同源）列出当前成员供指定 Owner 使用；共享机器上 `isCurrentUser` 对应驱动本轮的真人（目录条目不赋予任何机器或工作区执行权限）。
- Agent 通过 MCP 创建对话（`lody_session_create`、`lody_session_create_many`）时可传入 `ownerUserId: string`；省略时默认继承当前调用会话的 `userId`。受理时即冻结进规范命令，确保后台重启恢复与首次执行保持一致。解析出目标机器与本地项目后，创建流程会校验目标 Owner 已拥有该机器与本地项目的访问权（与 UI 转交 Owner 一致），同时发起人的执行权限仍独立按现有规则判定。

### 侧栏「状态」视图

- 侧栏视图选项“按状态”统一更名为 **状态**（`Status`）。
- 顶部 **Pinned** 区保持独立，继续享受特殊待遇；Pinned 分组不混入下方的状态区。
- Pinned 区下方，状态视图将未归档、未固定的对话分为三层：
  1. **进行中（Focus）**：默认展开。按 `SessionMeta.orderKey`（与 Pinned 共用的 fractional index）手动固定排序，支持指针拖拽重排（复用 Pinned 的拖拽交互与落位动画）。尚无 `orderKey` 的对话排在有键对话之后并按 `session.id` 稳定升序排列，普通新回复不会导致跳位。不做键盘移动。
  2. **稍后（Later）**：默认折叠（显示条目数）。包含 `snoozedUntil > now` 的对话。展开后按 `snoozedUntil` 升序排列（最快唤醒的在前）。每行展示紧凑的倒计时提示（倒计时图标 + `3d`、`2h`、`45m`、`<1m`）。一旦 `now >= snoozedUntil` 且工作区同步在线，触发以 `snoozedUntil` 为锚点的一次性唤醒：推进 `snoozeWokenUntil`（不删除 `snoozedUntil`，避免覆盖他端重新设定的稍后）、将 `lastMessageAt` 推进至 `max(lastMessageAt, snoozedUntil)` 使其变为未读且不会在晚上线端把已读会话再次标未读、未读时写入顶部 `orderKey` 顶到「进行中」最前面（仍位于 Pinned 下方）并写入 `focusRestoredAt`（确保旧会话也会浮上来）。
  3. **已完成（Settled）**：默认折叠（显示条目数）。包含手动标记为已完成（存在 `settledAt` 且之后无新消息）或最近 7 天无新消息（`now - lastMessageAt >= 7d`、非运行中、非等待审批，且 7 天内未被手动移回进行中）的对话。展开后按最近活动时间降序排列。收到更新消息（`lastMessageAt > settledAt`）时自动回到「进行中」。
- **opened-by 子对话交互**：每个对话均按自身元数据判定所属状态分组。当父对话 `A` 与子对话 `B` 位于同一状态分组时，`B` 缩进显示在 `A` 下方；在 `B` 的菜单中执行「稍后」「标记为已完成」或「移回进行中」仅修改 `B` 自身。`A`、`B` 位于不同分组时各自在所属分组中独立显示，回到同一分组后自动恢复缩进。菜单展示的状态与该行所在分组保持一致。

### 入口与交互

- 侧栏右键菜单与对话页顶部「…」菜单（对有写权限且未归档的会话）均提供：
  - **稍后（Later）** 子菜单：快捷预设（今天稍后 +3h、明天上午 9:00、下周一 9:00、自定义时间）；已延后时提供 **移回进行中（Move to Focus）**。
  - **标记为已完成（Settle）**（处于进行中时）或 **移回进行中（Move to Focus）**（处于已完成时）。
- 向「稍后」或「已完成」的对话发送消息时，自动清除 `snoozedUntil` / `settledAt` 并回到「进行中」。
- 将「稍后」或「已完成」中的对话拖入「进行中」时，自动清除暂缓/完成状态（超过 7 天无消息的记录 `focusRestoredAt`），并落在松手位置的 `orderKey` 处。

## 数据归属与排序

- 将尚未上线的 `SessionMeta.pinOrderKey` 重命名为 `SessionMeta.orderKey`（使用 `@loro-dev/fractional-index` 规范大写十六进制键）。Pinned 与进行中共用 `orderKey`；取消固定时清除 `pinSectionId`，但保留 `orderKey`。
- 在 Meta Flock 的 `SessionMeta` 上新增四个可选字段（在工作区成员间共享；修改共享状态与进行中顺序均需要编辑权；按用户私有的状态排序不在本期范围内）：
  - `snoozedUntil?: number`（毫秒时间戳）
  - `snoozeWokenUntil?: number`（毫秒时间戳；已唤醒的最新到期水位，避免同一暂缓跨端重复唤醒）
  - `settledAt?: number`（毫秒时间戳；写入 `max(serverNow, lastMessageAt)` 避免时钟偏差）
  - `focusRestoredAt?: number`（毫秒时间戳；用于覆盖 7 天无消息自动沉降，自该时间起 7 天内保持在进行中）
- 正在等待人类权限审批的对话无论是否处于暂缓或已完成，都会强制归入 **进行中（Focus）**。
- 7 天自动归入已完成由 `now` 与元数据时间戳纯计算得出（derived state），避免离线多端产生后台 CRDT 写风暴。
- 不新增 room，不新增文档类型。

## 兼容性

- 所有新增字段均为 `SessionMeta` 可选字段，旧客户端忽略后仍正常展示对话。
- `pinOrderKey` 尚未上线，重命名为 `orderKey` 无需数据迁移。

## 不在范围内

- 进行中列表的键盘排序移动。
- Agent 托管未读抑制（`agentManaged`），留待后续独立设计。
- 个人私有的排序布局与基于 LoroDoc 的 Today 大纲编辑器（留待后续实验特性阶段）。
- 原生 iOS / Android 客户端。

## 证据

实现：

- 共享 schema 与排序：`packages/shared/src/schema.ts`、`packages/shared/src/pinned-sections.ts`
- 状态分类与倒计时：`packages/components/src/lib/sidebar-status-group.ts`
- 侧栏渲染、拖拽、菜单与写入：`packages/components/src/components/sidebar-updated-session-list.tsx`、`packages/components/src/components/loro-sidebar.tsx`、`packages/components/src/components/loro-app-sidebar.tsx`、`packages/components/src/components/sessions/session-chat-interface.tsx`、`packages/components/src/hooks/use-session-actions.ts`、`packages/components/src/atoms/doc-meta.ts`、`packages/components/src/atoms/sidebar-state.ts`
- MCP 与 CLI 成员查询 / Owner 指定：`apps/cli/src/mcp/lody-mcp-server.ts`、`apps/cli/src/lib/message-handler.ts`、`apps/cli/src/commands/session.ts`
- Storybook：`packages/components/src/stories/SidebarStatusView.stories.tsx`
