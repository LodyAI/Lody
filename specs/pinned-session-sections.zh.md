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
- 用户可以新建、重命名、删除分组，并拖动分组标题调整分组之间的顺序。
- 用户可以拖动 pin 对话，在分组内调整顺序或移到另一个分组；拖到分组标题上会放到该分组最上方。
  把未 pin 的对话拖进 pin 区会在该位置 pin 它。右键菜单也提供“移动到分组”（放到该分组最上方）
  和“新建分组…”。
- 删除分组不会取消 pin：其中的对话回到默认区。
- 取消 pin 会清除该对话的分组和顺序；再次 pin 时回到默认区最上方。
- 每个分组可以单独折叠，折叠状态只保存在本机。
- opener 子对话仍挂在根对话下面，跟随根对话移动，不单独排序。
- 移动端布局显示非空分组和顺序，但不提供拖动和分组管理。

## 数据归属

分组和顺序与 `isPinned` 的可见范围相同：同步到所有设备，工作区成员看到同一份 pin 布局。

- **分组定义** 存放在 workspace Flock 的新行家族 `['pinSection', sectionId]`，值为
  `{ name, orderKey }`。一个分组只有一行，重命名和拖动只写这一行；删除分组就是删除这一行。
- **对话位置** 存放在会话元数据（meta Flock）上，与 `isPinned` 并列，新增两个可选字段：
  `pinSectionId` 和 `pinOrderKey`。拖动一个对话只写这一个对话的元数据。
- `pinSectionId` 缺失或指向不存在的分组时，对话显示在默认区。不会因为分组被删除而批量改写对话。

不新增 room，不新增文档类型。workspace Flock 已在加密工作区中作为受保护内容同步。

## 排序

分组和对话都用 fractional index 字符串排序，使用 Loro 的 TS 实现
`@loro-dev/fractional-index`（与 Rust `loro_fractional_index` crate 逐字节兼容）。该包尚未发布到 npm，
因此先按 MIT 许可证原样 vendor 进 `packages/shared`，记录上游 commit `8932e46ef197`；发布后改为正常依赖。
每次移动只为被移动的一项生成一个介于前后邻居之间的新键，并带随机 jitter，
使两台设备同时插入同一位置时不会产生相同的键。键相同时按 id 排序，保证所有客户端顺序一致。

没有 `pinOrderKey` 的已 pin 对话（包括本功能上线前 pin 的对话）排在同一区内有键的对话之后，
彼此之间仍按最近更新时间排序。不做迁移。

## 兼容性

- 只新增可选字段和一个新行家族，不改变任何已有字段的格式。
- 旧客户端解析 workspace Flock 时会忽略不认识的 `pinSection` 行，仍把所有 pin 对话按时间显示为
  一个平铺列表。
- 旧客户端取消 pin 时不会清除 `pinSectionId` / `pinOrderKey`；新客户端只在 `isPinned` 为 true 时
  读取这两个字段，因此残留值无害。之后在新客户端上重新 pin，会被重新放回默认区。

## 不在范围内

- 定时任务运行结果自动进入某个分组。需要固定位置的事务性任务使用复用同一对话的投递方式
  （`own_session` / `existing_session`），pin 一次即可。
- 个人私有的 pin 布局（不同成员看到不同分组）。
- 原生 iOS / Android 客户端。它们忽略新字段，不受影响。

## 权限

有工作区写权限的成员都可以新建、重命名、删除和拖动分组，加密工作区也一样；只读成员只能查看。
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
- 侧栏：`packages/components/src/components/sidebar-pinned-sections.tsx`、
  `sidebar-updated-session-list.tsx`、`loro-app-sidebar.tsx`；移动端：
  `packages/components/src/components/mobile/mobile-chat-list.tsx`
- 加密内容选择：`packages/shared/src/workspace-streams-content.ts`
- 定时任务投递方式：`packages/shared/src/schedule-types.ts`

已执行的验证（单元测试与 jsdom 测试，未在运行中的应用里验证）：
`packages/shared/tests/pinned-sections.test.ts`、`packages/shared/tests/workspace-flock.test.ts`、
`packages/components/tests/workspace-catalog-write.test.ts`、
`packages/components/tests/loro-sidebar-pinned-section.test.tsx`、
`packages/components/tests/sidebar-navigation-model.test.ts`、
`packages/components/tests/mobile-chat-list-preview-cap.test.tsx`。分组标题拖动和 E2EE 写入准入未覆盖。
