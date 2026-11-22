# 状态视图与 pin 分组进入所有手机端

日期：2026-11-21
Status: implemented
Translation: current

[English](2026-11-21-status-view-on-phones.md)

## 摘要

状态视图（进行中 / 稍后 / 已完成）、手动排序和 pin 分组原本只在桌面侧栏里有，原生 iOS 和
Android 列表各自用 Swift 和 Kotlin 实现了一套旧的状态分组。现在列表布局和写入规划由一份共享的
纯实现负责，桌面侧栏、手机 WebView 和原生客户端共用的 TypeScript runtime 都使用它，同一套测试
样例在每个使用方运行。手机端的操作与桌面对齐，包括拖拽排序和分组管理。原生客户端仍然完全不能
打开加密工作区，那是另一个项目；真机、原生客户端登录后的云端工作区、打包后的手机 App 都没有验证。

## 问题

- 分类本身是纯函数，但各区排序、到期唤醒与未读的补充、写入规则分散在桌面的三个 React 文件里，
  其他界面无法复用。
- 手机 WebView 列表没有状态分组，也不提供稍后、完成、移回进行中。
- 原生 runtime 的目录丢掉了 `orderKey`、`pinSectionId`、`snoozedUntil`、`settledAt` 和
  `focusRestoredAt`，从不读取 `pinSection` 行，没有同步的服务器时钟，发送时不清除稍后/已完成
  状态，新建时也不写 `orderKey`。Swift 和 Kotlin 各自实现了已废弃的「需要你 / 运行中 / 已完成」
  分组，Android 还没有 pin 和滑动操作。

## 决定

### 一份布局、一份写入规划、一套样例

`packages/shared/src/status-view/` 负责这些行为。模块之间只互相引用，外加
`../pinned-sections.ts` 和内置的分数索引，从不读取时钟或随机源
（[范围规则](../../../../packages/shared/src/status-view/AGENTS.md)）。抽取时保持桌面行为不变，
以桌面测试为准。

**布局** — `buildStatusViewLayout(input) → StatusViewLayout`。输入是可见会话（未归档、已按可见
范围过滤、包含的 Tab 并入其拥有者）及其元数据，宿主提供的两个事实 `isWorking` 和
`isWaitingPermission`，每行的权限 `canManage` 和 `canPrefer`；pin 分组及 `sectionsLoaded`、
`canManageSections`；每个分组被可见范围隐藏的行数；按服务器同步时钟取的 `nowMs`。输出就是跨端
JSON 契约：

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

折叠状态、「查看全部」和倒计时文字由各界面自己负责；模块导出默认值以及倒计时和预设时间的格式化函数。

**写入规划** — `planStatusViewCommand(state, command, env) → writes`。`state` 就是布局输入，可以
附带列表不显示的 `related` 行（其他可见范围、已归档），带上子对话的操作仍会作用到它们，但它们不影响
排序。`env` 提供 `nowMs` 和分数索引 jitter 用的随机字节来源。命令如下：

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

结果是一组会话元数据补丁，每个都带 `access: 'manage' | 'prefer'`，宿主据此套用对应的权限检查
（`null` 表示清除字段），以及 pin 分组行的写入或删除。状态无法满足的命令（未知行、缺少权限、已过去
的稍后时间）不规划任何写入，而不是只写一部分。移动命令给出落在哪一行前面，所以调用方的列表即使过期，
也按规划方的顺序解析。规划沿用桌面规则：每次移动一个带 jitter 的键，为落点上方没有键的行补键，在
进行中排序时为已到期的稍后条目落地真实的键，把行拖进进行中时一并恢复它的 opened-by 子对话，
`settledAt = max(now, lastMessageAt)`，取消 pin 保留 `orderKey`。

**测试样例** — `vectors/layout.json`（13 个用例）和 `vectors/commands.json`（38 个用例，固定的
`nowMs` 和随机字节）在 `packages/shared` 里运行，在 `packages/components` 里针对桌面和手机 WebView
的适配层运行，也在 iOS 和 Android 的 runtime 测试里运行。

### 各界面

- **桌面**：侧栏用自己的行构造布局输入，`useSessionActions().runStatusViewCommand` 在检查完所有受
  影响会话的权限后执行规划好的写入。被拒绝的拖拽会给出提示。加密工作区的 Guest 和已知的只读成员看不到
  状态操作。
- **手机 WebView**：首页列表的状态分组（没有保存过分组选择时的默认值）以及每种分组里的置顶区，都通过
  同一个命令执行器渲染同一份布局（[mobile README](../../../../packages/components/src/components/mobile/README.md#status-grouping)）。
- **原生**：`cloud-runtime` 按固定的 Lody 提交逐字节复制共享模块，附带来源记录和哈希。它投影这五个
  字段，持续读取工作区 Flock 以获得 `pinSection` 行，用 `/api/time` 的往返中点估算服务器时钟（未知时
  用设备时钟），并在目录里发布 `statusView: { mine, team, nowMs, sectionsLoaded }` 和
  `pinSections`。它在 `nextChangeAt` 和回到前台时重新发布。一个方法
  `statusViewCommand({ workspaceId, command, scope? })` 基于当前副本规划并写入，返回 `{ writes }`，
  0 表示被拒绝或无事可做；`snoozePresets()` 返回预设时间。`start` 接受 `workspaceReadOnly`。
  runtime 在消息发出时执行 `touchOnSend`，在新建会话时执行 `newSessionOrder`。Swift 和 Kotlin 从不
  对这些列表排序或分类（[跨平台规则](../../../../apps/mobile/docs/rules/cross-platform.md)）；按时间
  和按项目的分组保留原生代码，旧的原生状态分组已经移除。

### 手机交互（WebView、iOS、Android）

| 手势            | 结果                                           |
| --------------- | ---------------------------------------------- |
| 轻点            | 打开对话                                       |
| 长按            | 完整操作菜单；按住时移动就变成拖拽             |
| 向左滑          | 进行中和稍后的行：完成、稍后。已完成的行：归档 |
| 向右滑          | pin 或取消 pin                                 |
| 分组标题 ⋯      | 新建分组、重命名、上移、下移、删除             |
| 对话页「…」面板 | 稍后、完成、移回进行中                         |

拖拽可以在进行中排序，在 pin 分组内和分组之间移动，把行拖进置顶区就 pin 住，把稍后或已完成的行拖进
进行中就恢复它。列表在边缘自动滚动，在写入读回之前保持拖放后的顺序，拖拽期间冻结外来的重排。每个拖拽
结果也都有对应的菜单项和无障碍操作（上移、下移）。稍后打开一个面板，里面是四个预设和自定义日期时间；
过去的时间会被拒绝。完成和稍后会给出撤销提示，子对话的询问与桌面一致。分组用上移、下移调整顺序，而不是
拖动标题。折叠状态和所选分组只保存在设备上；稍后和已完成默认折叠，已完成超过 20 行时折叠。

## 备选方案

- **用 Swift 和 Kotlin 各自重写规则，再用共享样例约束。** 否决：三份排序、唤醒和写入规划的实现会
  逐渐不一致，而原生客户端本来就运行着负责同步的共享 TypeScript runtime。
- **由 runtime 发出下标差异（Element X 的做法）。** 暂时否决：目录本来就是完整快照，可 diff 的数据源
  和带 key 的 Compose 列表会自己计算动画，丢失一次差异还需要重置协议。
- **在原生代码里生成排序键。** 否决：键的生成、jitter 和同值裁决集中在一处；原生只发送落点前面那一行。
- **手机上单独的「调整顺序」编辑模式（带拖动柄）。** 作为 WebView 长按拖拽不可用时的后备方案保留。
  在测试过的浏览器里不需要它；还没有在打包后的 App 里试过。
- **这次就支持原生加密工作区。** 推迟为独立项目：原生客户端在任何内容打开之前就拦下加密工作区，启用它
  需要密钥托管、配对、恢复、账本和受保护的 Streams 编解码。布局和写入规划位于解密之上，届时不需要改动。

## 影响与限制

- 原生没有会话在线状态通道。runtime 从目录里的持久状态（`status`、`awaitingUserSince`）推导
  `isWorking` 和 `isWaitingPermission`，桌面用实时在线状态。对于正在等待审批、但处于稍后或已完成的
  对话，以及沉默七天但正在运行的对话，两边的列表可能短暂不同。
- 状态操作使用完整的会话管理权限检查。在加密工作区的手机 WebView 上，本人在其他成员共享机器上的对话
  不提供状态操作：手机发现不了那台机器（`isSessionEditableToUser`），所以这些行是 `readOnly`。pin
  仍然可用。要允许这类写入，需要的是手机所缺的可移植机器共享读取，而不是放宽检查。
- 在 iOS 和 Android 上，队友本地项目里的对话（包括含本地成员的项目组）不提供状态操作：这个项目是否
  与团队共享属于服务端的访问状态，runtime 读不到，而机器的 Flock 也会列出私有项目（runtime
  `status-view.ts` 里的 `sessionPermissions`）。对话作者仍然可以 pin。桌面在项目与该成员共享时提供
  这些操作。
- WebView 上的加密工作区不需要特殊处理：仓库内没有任何一层过滤会话元数据字段或工作区 Flock 的行族。
  非拥有者成员加密写入 `pinSection` 行和新会话字段，已在房间层测试
  （`apps/electron/src/main/services/e2ee-runtime.test.mjs`）；托管网关是否接受，从本仓库无法查看。
- Android 在前台打开对话时把它标为已读，所以到期唤醒对话的未读状态在那里也会清除。
- 放置和恢复都不会消耗唤醒，只有打开、发送或标记为已完成才会。在进行中排序时，被唤醒的行落地真实排序键，并把 `focusRestoredAt` 记为唤醒时间；恢复到进行中（从「稍后」「已完成」或置顶区拖入、移回进行中，以及跟随的 opened-by 子对话）时把 `focusRestoredAt` 记为当前时间，只清除仍在未来的稍后时间。无论哪种情况，已过期的 `snoozedUntil` 都会保留，所以这一行停在被放置的位置，并保持未读直到被阅读。不需要新字段：`focusRestoredAt` 只由这些放置和恢复写入，而稍后命令总把 `snoozedUntil` 设在未来，所以再次稍后的对话到期时会重新浮上来。早于这条规则的桌面版本（LodyAI/Lody#3077 之前）会把放置过的被唤醒行重新浮到最前面；两种数据都有效。
- 在所有手机界面上，长按菜单在原地松手时打开，按住后移动过则不打开菜单；iOS 16.4–17.3 无法用代码弹出
  菜单，保留系统上下文菜单，按住移动时仍会变成拖拽。
- 已知的小缺口：iOS WebView 没有触感反馈，Chrome 在首次轻点之前拒绝震动。

## 验证

已验证：

- 测试样例（13 个布局用例、38 个命令用例）在 `packages/shared` 里运行，在 `packages/components` 里
  针对桌面和手机的适配层运行，也在 iOS 和 Android 的 runtime 测试里运行。
- 桌面：进行中拖放的 Storybook 端到端测试
  （`packages/components/tests/e2e/sidebar-status-focus-drop.spec.ts`，5 个用例）。
- 手机 WebView：Storybook 里的列表、手势、面板和拖拽，分别在 iOS 模拟器的 Safari 和 Android 模拟器的
  Chrome 里打开，并在 Chromium 里用真实触摸输入操作。
- 原生 Android：在 Pixel 8 / Android 16 模拟器上用离线测试数据，完成列表、菜单、滑动和拖拽的 23 项交互
  检查，并在最终版本上做了冒烟测试。
- 原生 iOS：在 iOS 26.5 和 27.0 模拟器上用离线测试数据，浅色和深色，运行 `home-status` 和
  `home-status-drag` UI 回归（折叠的分区、稍后预设、稍后和完成的撤销、在过期目录下保持并读回的「移到
  最前」、按住拖拽在进行中排序以及把 pin 行移进空分组、原地长按菜单、两个方向的滑动），并验证拖拽时的
  边缘滚动。

都没有验证：真机；iOS 16.4–17.3 运行环境；原生客户端登录后的云端工作区；Android runtime 对 staging
的 `/api/time` 读取（只通过 Mac 的端口转发到达过）；桌面应用写入真实的仓库副本（而不是测试和
Storybook）；真实的加密 Guest 会话，以及托管网关接受新的加密写入；VoiceOver 在设备上触发上移和下移
（处理函数已测试：每次只发送一个带正确 `beforeId` 的 `move`）；Capacitor 打包后的 App，WebView 列表只
在浏览器里测过。

## 证据

- 预期行为：[状态视图](../../../../specs/sidebar-status-view.zh.md)、
  [pin 分组](../../../../specs/pinned-session-sections.zh.md)。
- Pull request：LodyAI/Lody#3063（共享布局、写入规划、桌面）、LodyAI/Lody#3065（手机 WebView）、
  LodyAI/lody-ios#130（共享 runtime）、LodyAI/lody-ios#131（iOS 列表）、LodyAI/lody-android#25
  （Android 列表和桥接）；评审修复见 LodyAI/Lody#3093、#3096、#3098，LodyAI/lody-ios#137、#138，
  LodyAI/lody-android#33。
- 共享列表的先例：matrix-rust-sdk 的 `RoomListService` 在共享代码里计算排好序的房间列表，再交给
  Swift 和 Kotlin。
- 阅读过源码的交互参考：Telegram（置顶对话和文件夹）、Bluesky `SavedFeeds`（拖动柄、可访问的上移和
  下移）、Tasks.org（长按变拖拽）、Proton Mail（稍后面板）；Apple 关于每个拖拽都要有菜单替代的指南。
