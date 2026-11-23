# 已固定对话的分组与排序

Status: draft
Translation: current

[English](pinned-session-sections.md)

## 场景

工作区里长期存在一些事务性对话，例如每周检查 mirror 更新、自动升级依赖的定时任务对话。
它们被 pin 之后与其他 pin 对话混在一起，并按最近更新时间不断换位。用户希望手动决定
pin 对话的顺序，并把它们放进自己命名的分组（pin section）里，例如“例行维护”。

## 行为

- sidebar 的 pin 区由一个默认的“已固定”区和任意多个用户分组组成。默认区始终在最上面，
  不能重命名、删除或拖动；已有用户分组且默认区为空时不显示默认区。新 pin 的对话进入默认区最上方。
- 用户可以新建、重命名、删除分组，并拖动分组标题调整分组之间的顺序。每个分组标题的菜单都有
  “新建分组…”，用来新建空分组；用户分组的菜单还可以重命名和删除。
- pin 对话用指针拖起：拖动时显示抓手光标，并有一张悬浮的卡片跟随；拖到对话或新建对话输入框上
  仍然会插入引用。拖到 pin 区外松手，卡片会飞回原位。
- 拖动对话经过某个分组时，落点处的卡片会滑开让出一个空位，被拖卡片原来的位置会收起；
  松手后对话正好落在这个空位里：卡片用约 100ms 从松手处滑入空位，位置和背景色都不跳变，
  鼠标再次移动前不显示 hover 高亮。
- 用户可以拖动 pin 对话，在分组内调整顺序或移到另一个分组；拖到分组标题上会放到该分组最上方。
  把未 pin 的对话拖进 pin 区会在该位置 pin 它。右键菜单也提供“移动到分组”（放到该分组最上方）
  和“新建分组…”。
- 桌面端用户分组的标题菜单提供“在此分组新建对话”。它打开新建对话页，页面在项目选择旁显示该分组，
  并保留页面上已选的项目。从这里开始的对话会 pin 到该分组最上方；取消勾选该分组则不 pin。
  若分组在此期间被删除，对话落在默认区。
- 删除分组不会取消 pin：其中的对话回到默认区。
- 取消 pin 会清除该对话的分组（`pinSectionId`），但保留其 `orderKey` 以维持状态视图中的手动顺序；再次 pin 时会生成新的 `orderKey` 并回到默认区最上方。
- 每个分组可以单独折叠，折叠状态只保存在本机。
- 「置顶」标题的「可见分组」菜单列出所有分组，包括默认分组。勾选的分组会显示，
  切换时菜单保持打开。隐藏默认分组时，其会话列表收起，「置顶」标题保留菜单入口。
  可见性只保存在本机。用「移动到分组」把会话移入隐藏的分组时，该分组会重新显示。
- 视图范围隐藏某个分组的全部对话时，该分组仍留在原地；展开时会在列表下方注明隐藏的对话数。
- opener 子对话仍挂在根对话下面，跟随根对话移动，不单独排序。
- 手机上，手机 WebView 和原生 iOS、Android 客户端的行为一致
  （[手机端笔记](../.agents/notes/implemented/architecture/2026-11-21-status-view-on-phones.zh.md)）：长按后移动变成拖拽，可以给 pin 对话排序并跨分组
  移动；把未 pin 的对话拖进 pin 区就是 pin；行菜单提供“移动到分组”和“移到最前”；每个分组标题的
  菜单提供新建分组、重命名、上移、下移和删除。

## 数据归属

分组和顺序与 `isPinned` 的可见范围相同：同步到所有设备，工作区成员看到同一份 pin 布局。

- **分组定义** 存放在 workspace Flock 的新行家族 `['pinSection', sectionId]`，值为
  `{ name, orderKey }`。一个分组只有一行，重命名和拖动只写这一行；删除分组就是删除这一行。
- **对话位置** 存放在会话元数据（meta Flock）上，与 `isPinned` 并列，新增两个可选字段：
  `pinSectionId` 和 `orderKey`。拖动一个对话只写这一个对话的元数据。
- `pinSectionId` 缺失或指向不存在的分组时，对话显示在默认区。分组目录还没读到时，标了分组的对话先不显示，避免它先出现在默认区、再跳进自己的分组。不会因为分组被删除而批量改写对话。

不新增 room，不新增文档类型。workspace Flock 已在加密工作区中作为受保护内容同步。

## 排序

分组和对话都用 fractional index 字符串排序，使用 Loro 的 TS 实现
`@loro-dev/fractional-index`（与 Rust `loro_fractional_index` crate 逐字节兼容）。该包尚未发布到 npm，
因此先按 MIT 许可证原样 vendor 进 `packages/shared`，记录上游 commit `8932e46ef197`；发布后改为正常依赖。
每次移动只为被移动的一项生成一个介于前后邻居之间的新键，并带随机 jitter，
使两台设备同时插入同一位置时不会产生相同的键。键相同时按 id 排序，保证所有客户端顺序一致。

没有 `orderKey` 的已 pin 对话（包括本功能上线前 pin 的对话）排在同一区内有键的对话之后，
彼此之间仍按最近更新时间排序。不做迁移。

## 兼容性

- 只新增可选字段和一个新行家族，不改变任何已有字段的格式。
- 旧客户端解析 workspace Flock 时会忽略不认识的 `pinSection` 行，仍把所有 pin 对话按时间显示为
  一个平铺列表。
- 旧客户端取消 pin 时不会清除 `pinSectionId` / `orderKey`；新客户端只在 `isPinned` 为 true 时
  读取这两个字段，因此残留值无害。之后在新客户端上重新 pin，会被重新放回默认区。

## 不在范围内

- 定时任务运行结果自动进入某个分组。需要固定位置的事务性任务使用复用同一对话的投递方式
  （`own_session` / `existing_session`），pin 一次即可。
- 个人私有的 pin 布局（不同成员看到不同分组）。
- 原生 iOS / Android 客户端上的加密工作区：它们目前完全打不开加密工作区。手机 WebView 支持。

## 权限

有工作区写权限的成员都可以新建、重命名、删除和拖动分组，加密工作区也一样；只读成员只能查看，界面不向他们提供分组管理入口。
成员已经会写 workspace Flock（例如创建私有 Agent Role）；如果某条写入路径拒绝有写权限的成员写
`pinSection` 行，那是需要修复的缺口，而不是进一步收窄分组管理的理由。

## 证据

实现：

- 布局与移动规划：`packages/shared/src/pinned-sections.ts`；vendor 的排序库：
  `packages/shared/src/vendor/loro-fractional-index.ts`
- `pinSection` 行与未知家族处理：`packages/shared/src/workspace-flock.ts`
- 会话字段：`packages/shared/src/schema.ts`；pin 写入：
  `packages/components/src/hooks/use-session-actions.ts`
- 目录快照与写入：`packages/components/src/lib/workspace-catalog-room.ts`、
  `packages/components/src/lib/workspace-catalog-write.ts`
- 指针拖拽与引用投递：`packages/components/src/components/pinned-rows-dnd.ts`、
  `packages/components/src/lib/pinned-drop-settle.ts`、`packages/components/src/lib/session-mention-drag.ts`
- 侧栏：`packages/components/src/components/sidebar-pinned-sections.tsx`、
  `sidebar-updated-session-list.tsx`、`loro-app-sidebar.tsx`；在分组中新建对话：chat 路由的
  `pinSection` 参数、`components/chat/pin-section-target-pill.tsx`、`lib/session-submission.ts`；移动端：
  `packages/components/src/components/mobile/mobile-chat-list.tsx`
- 加密内容选择：`packages/shared/src/workspace-streams-content.ts`
- 定时任务投递方式：`packages/shared/src/schedule-types.ts`

已执行的验证（单元测试与 jsdom 测试，未在运行中的应用里验证）：
`packages/shared/tests/pinned-sections.test.ts`、`packages/shared/tests/workspace-flock.test.ts`、
`packages/components/tests/workspace-catalog-write.test.ts`、
`packages/components/tests/loro-sidebar-pinned-section.test.tsx`、
`packages/components/tests/sidebar-navigation-model.test.ts`、
`packages/components/tests/mobile-chat-list-preview-cap.test.tsx`、
`packages/shared/tests/status-view.test.ts`。Storybook 端到端测试
（`packages/components/tests/e2e/sidebar-status-focus-drop.spec.ts`）：把对话移到另一个分组、拖动
分组标题调整分组顺序。非拥有者成员加密写入 `pinSection` 行已在加密房间层测试
（`apps/electron/src/main/services/e2ee-runtime.test.mjs`）；托管网关的准入未覆盖。手机端见
[手机端笔记](../.agents/notes/implemented/architecture/2026-11-21-status-view-on-phones.zh.md#验证)。
