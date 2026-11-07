# Inbox 已置顶分组

跟踪 [#45](https://github.com/Innei/lody-ios/issues/45)。上游 catalog 顺序缺口：[LodyAI/Lody#782](https://github.com/LodyAI/Lody/issues/782)。

## 问题

置顶只做两件事：组内 `byActivity` 先 pin，行内副标题黄钉。会话仍待在原来的动态桶或项目卡片里。钉多了之后，已置顶和普通历史混在一起。

官方 mobile `groupChats` 和桌面侧栏已经把 pinned 抽成顶部一组，组内仍按 `latestMessageAt`。`SessionMeta` 只有 `isPinned`，没有 `pinnedAt` / rank / 有序 id，所以顺序不能跨设备，也不能固定。

## 目标

Inbox 三种视图里，已置顶单独成组。两种原生 Group 形态对号入座，不新增列表控件。组内本机固定顺序；上游有字段后只换存储，不重做分组。

## 决定

| 项                                   | 选择                                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------- |
| 动态 / 对话成员                      | attention / live / unread 即使置顶也留在原组；已置顶只收已读历史                    |
| 动态 / 对话顺序                      | 需要你确认 → 已置顶 → 进行中 → 已完成·待查看 → 今天 / 昨天 / 一周内 / 上个月 / 更早 |
| 项目成员                             | 全部 `pinned && !archived` 离开项目卡片和末尾「对话」，进顶部已置顶                 |
| 项目 UI                              | outline 父行，针图标，可折叠，不封顶，没有「还有 N 个」，没有新建会话               |
| 组内顺序                             | 本机有序 id，新置顶在最上，不因新消息重排。不做拖拽                                 |
| 空组                                 | 不渲染                                                                              |
| 行内黄钉                             | 进了已置顶组也保留                                                                  |
| 搜索 / 项目详情 / Live Activity 总览 | 不加已置顶组，仍组内 pin 优先                                                       |
| 云端                                 | 仍只写 `isPinned`。顺序等 #782                                                      |

官方 mobile `groupChats` 在 date / project 两种 `groupBy` 下都会把**全部**置顶抽到顶部。iOS 动态视图有「需要你确认」操作队列，所以紧急组留人；项目视图没有这层，全部上提，和官方 project 模式一致。

## 分组

`inbox.ts` 按视图各写一条规则，不抽 policy 层，不把分组搬进 `NativeGroupedList`。

**动态 / 对话**（`inboxSections`，对话只是 `chatOnly`）

`inboxGroup`：`attention` / `failed` → `attention`；已置顶且不是 live、不是 unread → `pinned`；live → `live`；unread → `unread`；其余 → 时间桶。

`groups` 插入 `pinned`，排在 `attention` 之后、`live` 之前。

**项目**（`projectSections`）

先抽出全部置顶会话，按本机顺序做成 `id: 'pinned'` 的 outline section。其余项目 / 对话只渲染未置顶；徽章、「还有 N 个」、空项目 `0` 按抽走后的集合算。取消置顶后回所属项目（Chat 回「对话」）。

父行 id `toggle:pinned`。`consumeRowPress` 已处理 `toggle:` 前缀，只改展开、不进项目页。`projectIdOfRow('toggle:pinned')` 不得把 `pinned` 当成项目 id。

展开状态走现成 `inboxExpansion`，默认展开。

## 本机顺序（上游垫片）

云端仍只有 `isPinned`。顺序按 `userId + workspaceId` 存在本机 UserDefaults，和 Inbox 视图 / 折叠同类，经 LodyKit 读写。

对外只暴露一个可测函数，分组两边共用：

```
reconcilePinOrder(order, pinnedIds, activityAt) -> nextOrder
```

- `pinnedIds` 是该 workspace 全部 `isPinned` 会话（含归档）。已不在其中的 id 丢掉（取消置顶）。
- 尚未出现的 id 整批插到最前；一批内按 `activityAt` 降序，所以单次新钉一定在最上。
- 已在列表里的相对顺序不动，不因新消息重排。
- Inbox 画组时丢掉归档。归档但仍置顶的 id 留在有序列表里，取消归档后回到原位。
- 第一次打开：`order` 为空，现有置顶全部算未知，按活动时间排一次后冻结。
- 再钉同一条：当新钉处理，插到最前，不恢复旧位。

已置顶组的行顺序 = 有序列表的子序列（动态视图再滤掉仍留在紧急组的 id）。

`#782` 落地后只换 `reconcilePinOrder` 的数据源（catalog 的 `pinnedAt` / rank / 有序 id），分组和 UI 不动。在那之前不要为云端顺序预留抽象层。

## 文案

- zh：已置顶
- en：Pinned
- key：`inbox.section.pinned`

## 验证

- `inbox.test.mjs`：动态组顺序与成员资格；项目全部置顶上提；空组隐藏；新钉在前且不因 `lastMessageAt` 变化重排；取消置顶回原组；归档隐藏仍保留顺序；其它设备新钉视为未知并前置。
- Debug Inbox 夹具加一条已读置顶，插在「需要你确认」和「进行中」之间。
- `verification/ui/inbox.py` 更新 header 顺序；`home.py` 项目视图确认顶部 outline，项目卡片里不再出现该会话。

## 不做

- 拖拽 / 编辑模式 / 拖动手柄
- 写 flock 顺序字段
- 改 `NativeGroupedList` 手势
- 搜索、项目详情、Live Activity 总览加已置顶组
- 项目视图再拆「需要你确认」组
