# 侧栏状态视图

Status: draft
Translation: current

[English](sidebar-status-view.md)

## 场景

当用户同时并行推进多个 Agent 对话时，按时间排序或按实时执行状态分桶（需要你 / 运行中 / 刚完成 / PR / 空闲）会导致侧栏条目频繁跳动，破坏空间记忆。用户需要稳定的手动顺序来管理当下工作，并清晰区分“进行中”与“稍后 / 已完成”的边界。

## 行为

### 侧栏「状态」视图

- 侧栏视图选项“按状态”统一更名为 **状态**（`Status`）。
- 顶部 **Pinned** 区保持独立，继续享受特殊待遇；Pinned 分组不混入下方的状态区。
- Pinned 区下方，状态视图将未归档、未固定的对话分为三层：
  1. **进行中（Focus）**：默认展开。按 `SessionMeta.orderKey`（与 Pinned 共用的 fractional index）手动固定排序，支持指针拖拽重排（复用 Pinned 的拖拽交互与落位动画）。新建的顶层对话会写入一个低于所有现有键的 `orderKey`，使其出现在「进行中」顶部；由其它对话打开的子对话（或子 Tab）创建时不写键，渲染为嵌套在其打开者之下，永远不会改变该打开者行的位置。尚无 `orderKey` 的对话排在有键对话之后并按 `session.id` 稳定升序排列，普通新回复不会导致跳位。不做键盘移动。
  2. **稍后（Later）**：默认折叠（显示条目数）。包含 `snoozedUntil > now` 的对话。展开后按 `snoozedUntil` 升序排列（最快唤醒的在前）。每行展示紧凑的倒计时提示（倒计时图标 + `3d`、`2h`、`45m`、`<1m`）。一旦 `now >= snoozedUntil`（统一采用服务端同步时钟），唤醒完全由 `snoozedUntil` 纯导出、不产生后台 CRDT 写入：对话自动回到「进行中」（超过 7 天的旧会话也会浮上来）、浮到「进行中」最前面（仍在 Pinned 下方），并由 `max(lastMessageAt, snoozedUntil)` 导出未读状态与展示时间；真实 `lastMessageAt`、用户手动拖拽的 `orderKey` 与重新设定的 `snoozedUntil` 不会被他端覆盖。
  3. **已完成（Settled）**：默认折叠（显示条目数）。包含手动标记为已完成（存在 `settledAt` 且之后无新消息）或最近 7 天无新消息（`now - lastMessageAt >= 7d`、非运行中、非等待审批，且 7 天内未被手动移回进行中）的对话。展开后按最近活动时间降序排列。收到更新消息（`lastMessageAt > settledAt`）时自动回到「进行中」。
- **opened-by 子对话交互**：每个对话均按自身元数据判定所属状态分组。当父对话 `A` 与子对话 `B` 位于同一状态分组时，`B` 缩进显示在 `A` 下方；在 `B` 的菜单中执行「稍后」「标记为已完成」或「移回进行中」仅修改 `B` 自身。`A`、`B` 位于不同分组时各自在所属分组中独立显示，回到同一分组后自动恢复缩进。菜单展示的状态与该行所在分组保持一致。

### 入口与交互

- 侧栏右键菜单与对话页顶部「…」菜单（对有写权限且未归档的会话）均提供：
  - **稍后（Later）** 子菜单：快捷预设（1 小时后、3 小时后、明天上午 9:00、下周一 9:00、自定义时间）；已延后时提供 **移回进行中（Move to Focus）**。
  - **标记为已完成（Settle）**（处于进行中或稍后时）或 **移回进行中（Move to Focus）**（处于已完成时）。
- 桌面端「进行中」与「稍后」的行在 hover 槽位提供一键 **标记为已完成**（取代其它视图在该位置的归档按钮）；「已完成」的行在该位置保持归档。「稍后」行的唤醒倒计时位于行最右侧，使用中性配色。
- 暂缓、标记为已完成或移回进行中时，若对话存在活跃 opened-by 子对话，会先询问是否对子对话执行相同操作——仅作用于当前对话，或整棵 opened-session 树。包含的 Tab 跟随其拥有者所在分区，不会被单独写入，与归档确认展示的子对话统计一致。将行拖入「进行中」时其 opened-by 子对话默认一并恢复、不再询问；仅被拖拽的行写入 `orderKey`。
- 向「稍后」或「已完成」的对话发送消息时，自动清除 `snoozedUntil` / `settledAt` 并回到「进行中」。
- 在「进行中」拖拽重排时，会为顶部已到期的稍后条目落地真实 `orderKey`，保证用户显式拖拽后的顺序稳定生效。把「稍后」「已完成」或置顶区（会取消 pin）的行拖入「进行中」时，它被恢复并落在松手位置的 `orderKey` 处；「移回进行中」则原地恢复；选择包含时，opened-by 子对话一起恢复。放置和恢复都不会消耗唤醒，只有打开对话、在其中发送消息或标记为已完成才会。被放置或恢复的行记下 `focusRestoredAt`，并保留已过期的 `snoozedUntil`，因此它停在被放置的位置，并保持未读直到被阅读；恢复时仍在未来的稍后时间会被清除。被唤醒的行只在已过期的 `snoozedUntil` 晚于 `focusRestoredAt` 时浮到「进行中」最前面，所以再次稍后的对话到期时会重新浮上来。

### 手机端

手机 WebView 布局和原生 iOS、Android 客户端显示与桌面侧栏相同的 Pinned 区和相同的三个状态区，顺序也相同。三者都已实现；设计、限制和验证情况见[手机端笔记](../.agents/notes/implemented/architecture/2026-11-21-status-view-on-phones.zh.md)。

- 所有界面都用同一份共享实现来推导列表和规划写入。原生客户端只显示共享 runtime 算好的布局，自己不对这些列表做排序或分类。
- 长按弹出完整操作菜单，按住不放并移动就变成拖拽：在「进行中」排序，或把「稍后」「已完成」的行拖进「进行中」。每一种拖拽结果都有对应的菜单项和无障碍操作。
- 左滑时，「进行中」和「稍后」的行提供「标记为已完成」和「稍后」，「已完成」的行提供归档。「稍后」打开底部面板，包含预设和自定义日期时间。标记为已完成和稍后之后给出带「撤销」的提示。对话页的「…」面板提供同样的状态操作。
- 原生客户端原有的状态分组（需要你、运行中、刚完成、PR、空闲）由这三个区取代。
- 原生客户端没有实时的会话在线状态，按已同步的状态判断对话是否在运行或等待审批。因此已稍后或已完成的对话正在等待审批时，或七天没有消息的对话正在运行时，它在原生端可能短暂落在不同的区。

## 数据归属与排序

- 将尚未上线的 `SessionMeta.pinOrderKey` 重命名为 `SessionMeta.orderKey`（使用 `@loro-dev/fractional-index` 规范大写十六进制键）。Pinned 与进行中共用 `orderKey`；取消固定时清除 `pinSectionId`，但保留 `orderKey`。
- 在 Meta Flock 的 `SessionMeta` 上新增三个可选字段（在工作区成员间共享；修改共享状态与进行中顺序均需要编辑权；按用户私有的状态排序不在本期范围内）：
  - `snoozedUntil?: number`（毫秒时间戳）
  - `settledAt?: number`（毫秒时间戳；写入 `max(serverNow, lastMessageAt)` 避免时钟偏差）
  - `focusRestoredAt?: number`（毫秒时间戳；用于覆盖 7 天无消息自动沉降，自该时间起 7 天内保持在进行中）
- 正在等待人类权限审批的对话无论是否处于暂缓或已完成，都会强制归入 **进行中（Focus）**。
- 7 天自动归入已完成与稍后到期唤醒均由服务端同步时钟与元数据时间戳纯计算得出（derived state），避免后台 CRDT 写风暴与多端互相覆盖。
- 不新增 room，不新增文档类型。

## 兼容性

- 所有新增字段均为 `SessionMeta` 可选字段，旧客户端忽略后仍正常展示对话。
- `pinOrderKey` 尚未上线，重命名为 `orderKey` 无需数据迁移。

## 不在范围内

- 进行中列表的键盘排序移动。
- Agent 托管未读抑制与 MCP 成员目录/Owner 指定工具（留待独立改动）。
- 个人私有的排序布局与基于 LoroDoc 的 Today 大纲编辑器（留待后续实验特性阶段）。
- 原生 iOS / Android 客户端上的加密工作区：它们目前完全打不开加密工作区。手机 WebView 支持。
- 原生客户端上的实时会话在线状态。

## 证据

实现：

- 共享 schema、排序与未读汇总：`packages/shared/src/schema.ts`、`packages/shared/src/pinned-sections.ts`、`packages/shared/src/live-activity-summary.ts`
- 状态布局、写入规划、倒计时与测试样例：`packages/shared/src/status-view/`
- 已读回执：`packages/components/src/lib/session-read-receipt.ts`
- 侧栏渲染、拖拽、菜单与写入：`packages/components/src/components/sidebar-updated-session-list.tsx`、`packages/components/src/components/loro-sidebar.tsx`、`packages/components/src/components/loro-app-sidebar.tsx`、`packages/components/src/components/sessions/session-chat-interface.tsx`、`packages/components/src/hooks/use-session-actions.ts`、`packages/components/src/atoms/doc-meta.ts`、`packages/components/src/atoms/sidebar-state.ts`
- Storybook：`packages/components/src/stories/SidebarStatusView.stories.tsx`
- 手机：`packages/components/src/components/mobile/`（WebView）；原生共享 runtime 和列表在
  `apps/mobile/ios`、`apps/mobile/android` 子模块里。

已执行的验证：测试样例（13 个布局用例、38 个命令用例）在 `packages/shared/tests/status-view.test.ts`
里运行，也在 `packages/components` 的桌面和手机适配层、iOS 和 Android 的 runtime 测试里运行；Storybook
端到端测试 `packages/components/tests/e2e/sidebar-status-focus-drop.spec.ts`（5 个用例）；手机
WebView 在 iOS 模拟器和 Android 模拟器上的 Storybook，以及在 Chromium 里用真实触摸输入操作；原生列表
用离线测试数据，在 iOS 26.5 和 27.0 模拟器以及 Pixel 8 / Android 16 模拟器上验证。没有验证：真机、
iOS 16.4–17.3 运行环境、原生客户端登录后的云端工作区、Android 对 staging 的 `/api/time` 读取、桌面应用
写入真实副本、真实的加密 Guest 会话和托管网关接受加密写入、设备上的 VoiceOver、Capacitor 打包后的 App。
已知缺口：在 iOS 和 Android 上，队友本地项目里的对话不提供状态操作，因为原生 runtime 读不到项目是否
共享；桌面在项目共享时提供。详见[手机端笔记](../.agents/notes/implemented/architecture/2026-11-21-status-view-on-phones.zh.md#验证)。
