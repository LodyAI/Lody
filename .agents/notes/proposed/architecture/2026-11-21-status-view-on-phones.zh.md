# 各手机端接入状态视图与 pin 分组

日期：2026-11-21
Status: proposed
Translation: current

[English](2026-11-21-status-view-on-phones.md)

## 摘要

状态视图（进行中 / 稍后 / 已完成）、手动排序和 pin 分组目前只存在于桌面侧栏。手机 WebView 列表只能按
项目或日期分组，pin 分组只能显示；原生 iOS 和 Android 列表跑的是一套旧的状态分组，Swift 和 Kotlin 各写
一份，而且它们拿到的会话目录丢掉了这个视图需要的五个字段。本文提议把列表布局和写入规划各收成一份共享
的纯实现，由桌面侧栏、手机 WebView 和原生客户端共用的 TypeScript runtime 一起使用，并用同一组测试样例在
每个使用方上运行。手机端获得完整操作，包括拖拽排序和分组管理。本文内容尚未实现，也未经验证。原生
客户端目前仍然打不开加密工作区，那是另一个项目，也是这次唯一接受的限制。

## 问题

- 分类是纯函数（`packages/components/src/lib/sidebar-status-group.ts`），但各区内的排序在
  `sidebar-updated-session-list.tsx`（`buildSidebarUpdatedBuckets`），到期唤醒后的活动时间和未读在
  `loro-app-sidebar.tsx`，写入规则在 React hook `use-session-actions.ts`。其他界面都无法复用。
- 手机 WebView 列表（`components/mobile/mobile-chat-list.tsx`）没有状态分组，行上也没有任何「稍后」
  「标记为已完成」「移回进行中」的入口。
- 原生客户端的会话来自 `apps/mobile/ios/packages/cloud-runtime`（`protocol/catalog.ts` 的
  `projectRows`）。它丢掉了 `orderKey`、`pinSectionId`、`snoozedUntil`、`settledAt`、
  `focusRestoredAt`，不读 `pinSection` 行，没有同步过的服务器时钟，发消息时不清除稍后 / 已完成状态，
  新建会话时也不写 `orderKey`。Swift（`InboxSections`、`HomeStatusGroup`）和 Kotlin（`ChatListModel`）
  各自实现了已经废弃的 Needs you / Running / Finished 分组。Android 另外还没有 pin、没有滑动操作，
  runtime 快照也比 iOS 旧。

## 决定

### 一份布局、一份写入规划、一组样例

`packages/shared` 里的两个纯模块负责全部行为：不依赖 React、DOM、时钟，随机数只能由外部注入。这次
抽取不改变行为，桌面侧栏现在的渲染结果和测试就是标准答案。

**布局** — `buildStatusViewLayout(input) → StatusViewLayout`。

输入：可见会话（未归档，已按可见范围过滤，包含的 Tab 照旧并入其拥有者），每个会话带元数据里的时间戳
和排序键，外加宿主提供的两个事实 `isWorking`、`isWaitingPermission`，以及宿主提供的两个权限
`canManage`、`canPrefer`；pin 分组和 `sectionsLoaded`；每个分组被可见范围隐藏的行数；按服务器同步
时钟取的 `nowMs`。

输出（可序列化为 JSON，这个形状就是跨端契约）：

```ts
type StatusViewLayout = {
  pinned: Array<{
    sectionId: string | null; // null 表示默认分组
    name: string | null;
    rows: StatusViewRow[];
    hiddenCount: number;
  }>;
  focus: StatusViewRow[];
  later: StatusViewRow[];
  settled: StatusViewRow[];
  canManageSections: boolean; // 新建、重命名、排序、删除 pin 分组
  /** 仅因时间流逝，布局最早会发生变化的时刻。 */
  nextChangeAt: number | null;
};
type StatusViewRow = {
  id: string;
  tier: 'pinned' | 'focus' | 'later' | 'settled';
  children: StatusViewRow[]; // 显示在这一行下面的 opened-by 子对话
  activityAt: number; // max(lastMessageAt, 已到期的 snoozedUntil)
  unread: boolean;
  snoozedUntil: number | null; // 该行位于「稍后」时有值
  woken: boolean; // 稍后到期、浮在「进行中」顶部
  canManage: boolean; // 稍后 / 已完成 / 移回进行中 / 在进行中排序
  canPrefer: boolean; // pin、取消 pin、pin 位置
};
```

折叠状态、「查看全部」的折叠和倒计时文字仍由各个界面自己负责；共享模块导出默认值，以及倒计时和预设
时间的格式化函数。

**写入规划** — `planStatusViewCommand(state, command, env) → writes`。`state` 是布局读取的同一份
元数据快照；`env` 提供 `nowMs` 和分数索引 jitter 用的随机字节来源。结果是一组会话元数据补丁，以及
pin 分组行的写入或删除。命令如下：

```ts
type StatusViewCommand =
  | { type: 'snooze'; sessionId: string; until: number; includeOpened: boolean }
  | { type: 'settle'; sessionId: string; includeOpened: boolean }
  | { type: 'moveToFocus'; sessionId: string; includeOpened: boolean }
  | { type: 'setPinned'; sessionId: string; pinned: boolean }
  | {
      type: 'move'; // 拖拽落位、「移到分组」、「移到最前」
      sessionId: string;
      to: { area: 'focus' } | { area: 'pinned'; sectionId: string | null };
      beforeId: string | null; // 落在哪一行前面；null 表示末尾
    }
  | { type: 'createSection'; sectionId: string; name: string }
  | { type: 'renameSection'; sectionId: string; name: string }
  | { type: 'deleteSection'; sectionId: string }
  | { type: 'moveSection'; sectionId: string; beforeId: string | null }
  | { type: 'touchOnSend'; sessionId: string } // 清除 snoozedUntil / settledAt
  | { type: 'newSessionOrder'; sessionId: string }; // 进行中顶部；opened-by 子对话和 Tab 不写
```

会话补丁带 `access: 'manage' | 'prefer'`，宿主据此套用对应的权限检查；`null` 表示清除字段。`state`
可以附带列表不显示的 `related` 行（其他可见范围、已归档），带上子对话的操作仍会作用到它们，但它们不影响
排序。状态无法满足的命令（未知行、缺少权限、已过去的稍后时间）不规划任何写入，而不是只写一部分。

移动命令给出的是「落在哪一行前面」而不是下标，所以调用方手里的列表即使过期，也能按规划方当前的顺序
解析。规划沿用现在的规则：每次移动只生成一个带 jitter 的键，为落点上方没有键的行补键，在进行中排序
时为已到期的稍后条目落地真实的键，把行拖进进行中时一并恢复它的 opened-by 子对话，
`settledAt = max(now, lastMessageAt)`，取消 pin 保留 `orderKey`。

模块位于 `packages/shared/src/status-view/`，样例在其中的 `vectors/` 目录。

**测试样例** — `{输入, 期望布局}` 和 `{状态, 命令, 固定的 env, 期望写入}` 的 JSON 文件放在共享模块
旁边。它们在 `packages/shared` 里运行，在 `packages/components` 里针对桌面和手机 WebView 的适配层
运行，也在 iOS 的 runtime 测试和 Android 的 runtime 测试里运行。

### 原生只负责显示，由共享 runtime 决定内容

共享模块和 vendor 的分数索引库按固定的 Lody 提交原样复制进 `cloud-runtime`，带来源记录和哈希；这个
runtime 的会话分享文件已经是这样做的。runtime 需要：

- 保留那五个被丢掉的字段，并持续读取 workspace Flock，让 `pinSection` 行不需要 App 触发就能到达；
- 用 `/api/time` 按往返中点估算和服务器的时间差，算法与 `packages/shared/src/time-sync.ts` 一致，
  估算出来之前退回本机时钟；
- 在会话目录快照里加入 `statusView: { mine: StatusViewLayout; team: StatusViewLayout }` 和
  `pinSections`，让布局和行数据一起到达，冷启动时也能从目录缓存恢复；并在 `nextChangeAt` 和回到前台
  时重新发布；
- 提供一个方法 `statusViewCommand({ workspaceId, command })`，按它当前的副本做规划并写入，另外提供
  `snoozePresets()`。只加一个方法，可以让 Android 的 capability 列表不超出上限；
- 派发消息时应用 `touchOnSend`，新建会话时应用 `newSessionOrder`。

Swift 和 Kotlin 不再对这些列表做任何排序或分类。按时间和按项目分组仍用原生代码；所有分组方式下的
Pinned 区，以及整个状态分组，都来自这份布局。原生旧的状态分组删除。

### 手机交互（WebView、iOS、Android）

| 手势            | 结果                                                   |
| --------------- | ------------------------------------------------------ |
| 点按            | 打开对话                                               |
| 长按            | 弹出完整操作菜单；按住不放并移动就变成拖拽             |
| 左滑            | 进行中、稍后的行：标记为已完成、稍后。已完成的行：归档 |
| 右滑            | pin 或取消 pin                                         |
| 分组标题 ⋯      | 新建分组、重命名、上移、下移、删除                     |
| 对话页「…」面板 | 稍后、标记为已完成、移回进行中                         |

- 拖拽可以在进行中排序，在 pin 分组内排序和跨分组移动，把行拖进 Pinned 区完成 pin，把稍后或已完成的
  行拖进进行中完成恢复。列表在屏幕边缘自动滚动；起拖和越过每一行时有震动反馈。落下后本地先保持新
  顺序，直到写入读回；拖拽进行中暂停应用远端的顺序变化。
- 每一种拖拽结果都有对应的菜单项（稍后、标记为已完成、移回进行中、pin、移到分组、移到最前）和无障碍
  操作（上移、下移）。
- 「稍后」打开底部面板：四个预设各自显示实际时间，自定义日期时间选择在同一个面板里，不能选过去的
  时间。标记为已完成和稍后之后给出带「撤销」的提示。「是否同时作用于 opened-by 子对话」的询问与桌面
  一致。
- 分组用上移、下移调整顺序，不拖标题。
- 折叠状态和选择的分组方式只保存在本机。稍后和已完成默认折叠，已完成超过 20 行时折叠。手机 WebView
  列表新增「状态」分组，并作为新安装的默认值。

## 备选方案

- **在 Swift 和 Kotlin 里各自重写规则，用共享样例约束。** 否决：排序、唤醒和写入规划有三份实现就会
  走样，而原生客户端本来就运行着一份负责同步的共享 TypeScript runtime。
- **由 runtime 发送下标增量（Element X 的做法）。** 暂不采用：会话目录现在就是整份快照，diffable data
  source 和带 key 的 Compose 列表会自己计算动画，而增量一旦丢失还需要一套重置协议。
- **在原生代码里生成排序键。** 否决：键的生成、jitter 和并列时的比较规则只保留一处，原生只告诉
  runtime 落在哪一行前面。
- **手机上单独的「排序」编辑模式加拖动手柄。** 只作为 WebView 的后备方案：如果长按拖拽在真实的
  WKWebView 或 Android WebView 上不可用才启用。优先让各手机端使用同一套手势。
- **在这次改动里做原生加密工作区。** 推迟为独立项目：原生客户端在打开任何内容之前就拦住了加密
  工作区，要打开需要密钥保管、配对、恢复、账本和受保护的 Streams 编解码。布局和写入规划位于解密之上，
  到时不需要改动。

## 影响与限制

- 原生没有会话级的在线状态通道。runtime 从持久化的目录状态（`status`、`awaitingUserSince`）推导
  `isWorking` 和 `isWaitingPermission`，桌面用的是实时在线状态。两种情况下列表可能短暂不同：已稍后或
  已完成的对话正在等待审批；七天没有消息的对话正在运行。
- 只读成员不应该看到分组管理和状态操作；现在桌面会显示这些入口，而加密上传会静默失败。
- 状态操作使用完整的会话管理权限检查。已追查：在加密工作区的手机 WebView 上，用户自己在其他成员
  共享机器上的对话会被拒绝，因为手机发现不了那台机器（`isSessionEditableToUser`）；其他成员在那里的
  对话根本不会列出。权限检查保持不变：要允许写入，需要手机目前没有的可移植机器共享读取，而不是放宽
  检查。这些行按同一判断已经是 `readOnly`，所以手机列表不会对它们提供稍后、标记为已完成或移回进行中；
  置顶仍然可用。
- WebView 上的加密工作区不需要特殊处理：仓库内没有任何一层按会话元数据字段或 workspace Flock 行
  家族做过滤。非 owner 成员加密 `pinSection` 行和新的会话元数据字段已有房间级测试
  （`apps/electron/src/main/services/e2ee-runtime.test.mjs`）；托管网关的准入逻辑无法从本仓库检查。
- Android 没有标记已读的命令；在 Android 上打开被唤醒的对话能否清除未读，尚未验证。

## 交付

1. Lody：共享布局、写入规划和样例；桌面侧栏切换到它们上面，行为不变；只读成员的入口限制。
2. Lody：手机 WebView 的列表、手势、面板和分组管理；新字段和新行在加密传输下的测试。
3. lody-ios：runtime 的字段、workspace Flock 持续读取、时钟、布局、命令方法、发送和新建时的写入；
   然后是 iOS 列表。
4. lody-android：更新 runtime 快照、桥接命令、Kotlin 列表。
5. Lody：子模块指针、Spec 证据，以及「原生客户端不得自行排序这些列表」的跨端规则。

第 1 步发布共享模块和样例之后，第 2 到 4 步并行推进。验收时，对同一个测试工作区，比较桌面、手机
WebView、iOS 和 Android 各自列表的 id 顺序。

## 证据

- 桌面行为与 Spec：[状态视图](../../../../specs/sidebar-status-view.zh.md)、
  [pin 分组](../../../../specs/pinned-session-sections.zh.md)。
- 共享列表的先例：matrix-rust-sdk 的 `RoomListService` 在共享代码里算好排序后的房间列表，再交给
  Swift 和 Kotlin。
- 读过源码的交互参考：Telegram（置顶会话和文件夹）、Bluesky 的 `SavedFeeds`（手柄拖拽，无障碍的上移
  下移）、Tasks.org（长按后移动变成拖拽）、Proton Mail（稍后面板）；以及 Apple 关于「每个拖拽都要有
  菜单替代」的指引。
