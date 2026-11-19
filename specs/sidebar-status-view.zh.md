# 侧栏状态视图与 Agent 托管未读抑制

Status: draft
Translation: current

[English](sidebar-status-view.md)

## 场景

当用户同时并行推进多个 Agent 对话时，按时间排序或按实时执行状态分桶（需要你 / 运行中 / 刚完成 / PR / 空闲）会导致侧栏条目频繁跳动，破坏空间记忆。同时，由 Agent 自主创建并运行的子对话不应弹未读红点或桌面通知打扰人类，用户也需要清晰区分“当下正在推进的”与“可以稍后再看或已收尾的”对话边界。

## 行为

### Agent 托管与未读抑制

- `SessionMeta.userId` 保持为全仓唯一的人类归属与权限标识。
- 在 `SessionMeta` 上新增可选布尔字段 `agentManaged?: boolean`，标记该对话当前由 Agent 托管、无需主动提醒人类读取。
- 当 `agentManaged` 为 `true` 时，抑制该对话的人类未读提示（侧栏/标签页未读圆点、窗口角标、桌面通知与未读汇总计数）。运行中与等待权限审批等实时阻塞标识仍保持可见，避免审批卡死被静默吞掉。
- Agent 通过 MCP 创建对话（`lody_session_create`、`lody_session_create_many`）时可传入 `agentManaged: boolean`；省略时默认继承当前父对话的 `agentManaged` 值（默认为 `false`）。
- `lody_session_list` 在原有 `ownerUserId` 旁同步返回 `agentManaged`。
- 当人类向一个 `agentManaged` 对话发送消息时，自动清除 `agentManaged`（置为 `false`），恢复后续回复的未读提醒（同时清除暂缓/收尾状态使其回到进行中）；有写权限的用户也可在对话更多菜单中手动切换。

### 侧栏「状态」视图

- 侧栏视图选项“按状态”统一更名为 **状态**（`Status`）。
- 顶部 **Pinned** 区保持独立，继续享受特殊待遇；Pinned 分组不混入下方的状态区。
- Pinned 区下方，状态视图将未归档、未固定的对话分为三层：
  1. **进行中（Focus）**：默认展开。按 `SessionMeta.orderKey`（与 Pinned 共用的 fractional index）手动固定排序，支持指针拖拽重排（复用 Pinned 的拖拽交互与落位动画）。尚无 `orderKey` 的对话排在有键对话之后并按最近活动时间排序。不做键盘移动。
  2. **稍后（Later）**：默认折叠（显示条目数）。包含 `snoozedUntil > now` 的对话。展开后按 `snoozedUntil` 升序排列（最快唤醒的在前）。每行展示紧凑的倒计时提示（倒计时图标 + `3d`、`2h`、`45m`、`<1m`）。一旦 `now >= snoozedUntil`，无需额外写入即可自动回到「进行中」。
  3. **已收尾（Settled）**：默认折叠（显示条目数）。包含手动收尾（存在 `settledAt` 且之后无新消息）或最近 7 天无新消息（`now - lastMessageAt >= 7d`、非运行中、非等待审批，且 7 天内未被手动移回进行中）的对话。展开后按最近活动时间降序排列。收到更新消息（`lastMessageAt > settledAt`）时自动回到「进行中」。

### 入口与交互

- 会话右键/更多菜单提供：
  - **稍后（Later）** 子菜单：快捷预设（今天稍后 +3h、明天上午 9:00、下周一 9:00、自定义时间）；已延后时提供 **移回进行中（Move to Focus）**。
  - **收尾（Settle）**（处于进行中时）或 **移回进行中（Move to Focus）**（处于已收尾时）。
  - **标记为 Agent 托管 / 接管并开启未读** 切换项。
- 将「稍后」或「已收尾」中的对话拖入「进行中」时，自动清除暂缓/收尾状态（超过 7 天无消息的记录 `focusRestoredAt`），并落在松手位置的 `orderKey` 处。

## 数据归属与排序

- 将尚未上线的 `SessionMeta.pinOrderKey` 重命名为 `SessionMeta.orderKey`（使用 `@loro-dev/fractional-index` 规范大写十六进制键）。Pinned 与进行中共用 `orderKey`；取消固定时清除 `pinSectionId`，但保留 `orderKey`。
- 在 Meta Flock 的 `SessionMeta` 上新增四个可选字段（与 `isPinned` 一致，在工作区成员间共享；按用户私有的状态排序不在本期范围内）：
  - `agentManaged?: boolean`（需写权限修改）
  - `snoozedUntil?: number`（毫秒时间戳）
  - `settledAt?: number`（毫秒时间戳；写入 `max(serverNow, lastMessageAt)` 避免时钟偏差）
  - `focusRestoredAt?: number`（毫秒时间戳；用于覆盖 7 天无消息自动沉降，自该时间起 7 天内保持在进行中）
- 正在等待人类权限审批的对话无论是否处于暂缓或收尾，都会强制归入 **进行中（Focus）**；opener 子对话跟随其可见根对话的状态分组。
- 7 天自动收尾与暂缓到期唤醒均由 `now` 与元数据时间戳纯计算得出（derived state），避免离线多端产生后台 CRDT 写风暴。
- 不新增 room，不新增文档类型。

## 兼容性

- 所有新增字段均为 `SessionMeta` 可选字段，旧客户端忽略后仍正常展示对话。
- `pinOrderKey` 尚未上线，重命名为 `orderKey` 无需数据迁移。

## 不在范围内

- 进行中列表的键盘排序移动。
- 个人私有的排序布局与基于 LoroDoc 的 Today 大纲编辑器（留待后续实验特性阶段）。
- 原生 iOS / Android 客户端。

## 证据

实现：

- 共享 schema 与排序：`packages/shared/src/schema.ts`、`packages/shared/src/pinned-sections.ts`、`packages/shared/src/live-activity-summary.ts`
- 状态分类与倒计时：`packages/components/src/lib/sidebar-status-group.ts`、`packages/components/src/lib/session-read-receipt.ts`
- 侧栏渲染、拖拽、菜单与写入：`packages/components/src/components/sidebar-updated-session-list.tsx`、`packages/components/src/components/loro-sidebar.tsx`、`packages/components/src/components/loro-app-sidebar.tsx`、`packages/components/src/hooks/use-session-actions.ts`、`packages/components/src/atoms/doc-meta.ts`、`packages/components/src/atoms/sidebar-state.ts`
- MCP 与 CLI 创建/查询：`apps/cli/src/mcp/lody-mcp-server.ts`、`apps/cli/src/commands/session.ts`
- Storybook：`packages/components/src/stories/SidebarStatusView.stories.tsx`
