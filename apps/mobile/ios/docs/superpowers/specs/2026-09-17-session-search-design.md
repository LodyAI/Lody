# 会话搜索：Inbox 正文摘录 + 会话内 find

跟踪 [#44](https://github.com/Innei/lody-ios/issues/44)。上游列表同样不扫正文；有用的是打开会话后的 transcript find。本仓两头都没有「按内容找」的入口。

## 问题

Inbox `searchSections` 只对 catalog 标题和项目名做本地子串匹配。`Session` 没有消息体。打开过的会话会把展示 envelope 写进 SQLite KV（`session:[user,workspace,id]`），长按预览读这份缓存，但列表搜索不用它。会话页没有 find。

用户按说过的话搜，结果永远空。KV 不是领域库，也不该为此改成 `entries` / `items` 表。catalog 仍是整包投影；消息真相源仍是 Loro，打开会话才 bootstrap。

## 目标

同一期交付两套入口，检索由原生做：

1. Inbox / iPad 侧栏：会话仍是一行。正文命中时副标题换成摘录。点进去打开 find 条，不自动弹键盘；定位当前历史窗口内最后一个可导航的命中行。折叠内容不展开；没有可导航命中时保留默认的最新 result 位置。
2. 会话内：更多菜单「查找」打开 UIKit find 条。只搜当前已加载的散文。

正文只覆盖这台设备打开过、且成功写入 session 缓存的会话。标题、项目名、路径、分支仍覆盖 catalog 里的全部会话。零命中时把这条边界写进空状态。

## 决定

| 项             | 选择                                                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Inbox 命中形态 | 会话一行；仅当标题/项目/路径/分支都未命中、正文命中时，副标题换成摘录                                                            |
| 点进会话       | 带上 `findQuery`，定位窗口内最后一个可导航命中；否则保留最新 result 位置。find 条打开，键盘不弹                                  |
| 索引范围       | 与上游 `session-chat-search.ts` 一致：`text` 与 `thought`。不索引 tool、plan checklist、subagent、system_notice、文件/图片元数据 |
| 未缓存会话     | 不后台拉历史。空结果说明内容搜索只覆盖本机打开过的会话                                                                           |
| 入口           | 更多菜单「查找」；Inbox 带词则自动打开 find 条                                                                                   |
| 存储           | KV 快照不动。写入 session 缓存时抽出散文到旁路表。不用 FTS5、Spotlight、`UIFindInteraction`                                      |
| 匹配           | Foundation `localizedStandardContains`（大小写/变音/中文按系统 locale）                                                          |
| 未加载历史     | 不计入 find 总数，不自动翻页；窗口外命中不跳转，保留最新 result 位置。用户加载更早页时重跑计数                                   |
| 折叠内容       | Inbox 仍搜索全部 `text` / `thought`；会话内只导航展开的正文行，不展开过程、不打开过程页                                          |

## 所有权

原生拥有：抽取、旁路表、Inbox 检索、会话内 find 条、高亮与滚动。

RN 拥有：`UISearchController` 输入（现有 SearchBar）、用 catalog 画行（菜单、pin、归档、徽章）、`sessionNav` 打开会话、更多菜单项。

JS `searchSections` 不再做匹配。它只消费原生 hits，从 catalog 生成现有 `NativeListRow`。`inboxSections` 的 `keyword` 路径保持不搜正文（非搜索态列表不走它）。

Debug 无登录场景必须走同一套原生写入和检索：`writeLocalValue('session:…')` 也要重建旁路表，不能只挂在 `DataRuntime.writeSession` 上。

## 旁路表

仍在 `catalog.sqlite`，与 KV 同库，不另开文件。

```sql
CREATE TABLE IF NOT EXISTS session_prose (
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (user_id, workspace_id, session_id, entry_id, item_id)
);
```

重建时机：在 `LocalStore.write` 统一处理 `session:` 前缀，`writeSession` 复用该路径。解析 `session:` 后的 JSON 数组 `[userId, workspaceId, sessionId]`。先删该会话全部行，再从 envelope `entries` 插入非空散文。KV 更新与旁路表重建放在同一个 SQLite 事务内，任一步失败均回滚。value 不是合法 envelope 则删行不插入（预览空态）。`clear()` 同一事务清空 KV 和 `session_prose`。

抽取函数单一来源，只收集 `type == "text" || type == "thought"` 且正文去空白后非空的项。用户消息按现有纯文本显示语义保留；助手 Markdown 使用当前 MarkdownParser 的解析树抽取可读文本，换行归一成 `\n`。正文索引和摘录不保留粗体等格式标记、链接 destination、图片 source 等元数据；保留链接标签、行内代码、代码块正文及表格单元格文字。相邻 inline token 连续拼接，块和单元格之间保留分隔，避免跨格式漏匹配或跨块拼出假命中。不用正则去 Markdown 语法。

Markdown token 边界：当前 MarkdownView 4.3.2 的 `strong` / `emphasis` 是容器，`link` 的 destination 与 children 分离；原生 cell 实际绘制解析后的 Markdown，并非源字符串。抽取必须发生在 `FileMarkdownView.content` 装饰前：该装饰会注入 `\u{F0000}lody-file:` + destination，再在绘制时替换为图标占位符；这些内部标记、占位符及 math replacement identifier 都不能进入索引或摘录。

高亮不复用源字符串或索引字符串偏移。在实际显示的文本 run 上按相同匹配语义求范围，再转换为该 run 的 UTF-16 `NSRange`；跨 inline 格式的命中要覆盖对应的连续显示文本，代码块／表格按各自文本视图定位。现有 `highlightMaps` 是代码语法高亮数据，不是搜索的源文本到显示文本映射。

单条 session 缓存仍受 12 MiB 写入上限。写失败则不更新旁路表，保留上一份。

纯文本抽取落在通用的 `Text/MarkdownPlainText.swift`，入口为 `MarkdownPlainText.string(_:)`；不依赖 ChatRow 或 UIKit，后续检索、摘要等正文提取复用它。`SessionProse` 只负责 envelope 的范围与角色规则。旁路表直接复用主键的用户／工作区／会话前缀索引，不重复建同前缀索引。

### 存量缓存回填

首次 `searchInbox` 在 `LocalStore.queue` 上检查持久化的索引版本标记；未完成时，逐条读取已有 `session:` KV，复用上述抽取与重建路径回填全部用户／工作区的缓存，不请求云端、不要求重新打开会话。逐条读取避免一次把所有 envelope 留在内存。

回填和完成标记在同一事务提交；数据库错误则回滚并让搜索走现有失败回退，下次检索重试。非法 key 或 envelope 跳过，不影响其他会话。普通启动读取不等待回填；首次内容搜索等待完成后才返回 hits，期间显示搜索中，不能提前显示无结果。完成后后续启动不重复回填。`clear()` 清除完成标记和索引，不能从旧任务恢复已清理的数据。

## Inbox 检索

`LodyKit.searchInbox(userId, workspaceId, query) -> InboxSearchHits`

```ts
type InboxSearchHits = {
  projectIds: string[];
  sessions: { id: string; snippet: string | null }[];
};
```

在 `LocalStore.queue` 上跑，不在主线程解析 JSON。

1. `query.trim()` 为空则返回空 hits。RN 此时走非搜索列表。
2. 读 `catalog:${userId}:${workspaceId}`。形状是 `{ catalog, syncedAt }`；缺 catalog 则项目/标题命中为空，正文仍可命中旁路表。
3. 项目：非 chat 项目，`name` 或 `rootPath` 命中。
4. 会话：`title`、项目名或聊天分组名（`LodyStrings` 的 `inbox.section.chat`，与 `sessionPlace` 相同）、`branchName`、所属项目 `rootPath` 任一命中 → `snippet: null`（副标题保持 `sessionPlace`）。
5. 否则若该会话旁路表任一 `text` 命中 → `snippet` 为第一处摘录（命中前后约 40 字，优先在空白处截断，空白压缩成单空格）。
6. 会话顺序与现在相同：命中集按 catalog 的 `byActivity`（RN 排序，原生只返回 id）。原生返回的 session 数组可不排序，RN 用 catalog 顺序滤出。
7. 已归档会话：搜索态包含，与现在一致。

RN 用 generation 丢弃过期结果。`searchInbox` 失败：toast，并回退到仅 catalog 标题/项目名的 JS 匹配（现 `searchSections` 逻辑抽出 `matchCatalog`），列表不得空白。

`useInboxModel`（Inbox 与 iPad 侧栏）在 `query.trim()` 有值时调 `searchInbox`，再 `searchSections(catalog, hits, accent)`。

摘录是普通 `subtitle` 字符串。不高亮、不用 attributed。

## 会话内 find

UIKit 条挂在 `LodyChatView` 上，不使用 Inbox 的 `UISearchController`，不包进 RN 键盘避让。

条上：输入、`当前 / 总数`、上一条、下一条、关闭。44 pt 触控。系统强调色高亮（当前命中与其他命中有对比），不用绿色。

`LodyChatView` 方法：

- `openFind(query: String, keyboard: Bool)` — 打开条；`keyboard == true` 时成为 first responder。
- `closeFind()` — 关掉条，清高亮。

更多菜单「查找」调 `openFind("", true)`。

Inbox 点入：`SessionNavIntent.open` 与 `SessionParams` 增加可选 `findQuery?: string`（只在内存，不进 URL）。`useBindSessionNav` 打开时传入。`SessionScreen` 在 `NativeChat` 上屏且已有 `preparedEntries` / `entriesJSON` 后调一次 `openFind(findQuery, false)`；原生等对应 rows 应用完成后执行首次定位。同一 `findQuery` 不因流式 revision 再调。

首次定位选择当前历史窗口内最后一个可导航的正文命中行。Inbox 索引包含折叠的 thought 和中间文本，但 find 不展开它们、不打开过程页，也不把过程摘要当正文命中。只有折叠内容或窗口外内容命中时，不做搜索跳转，保留会话默认的最新 result 位置；该兜底位置不是匹配结果，不虚增计数、不高亮。后续由用户按上／下一条导航。

匹配 `prepareHistory` 后当前窗口内展开的正文行（包括用户文本），文本语义与旁路抽取一致，使用 `localizedStandardContains`。工具行和折叠内容不进 find 结果与计数。空查询：无高亮，导航禁用。有查询无可导航命中：计数区「无结果」，导航禁用；这不否定 Inbox 对完整缓存的命中。Return 下一条。关闭清高亮。

实现时在窗口外定位的兜底分支保留下列注释：

```swift
// TODO: Extend the history window when supporting older search targets.
// ponytail: navigate expanded rows in this window only; otherwise keep the latest result.
```

用户点「更早的记录」加载后，若 find 条仍开着，重跑匹配并更新计数；不自动继续翻页。有更早页未加载时，不把总数说成全会话。

流式追加：更新高亮范围，不抢滚动，除非当前活动命中的那一行被替换。

## 文案

| key                          | zh-Hans                                                    | en                                                                                                |
| ---------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `search.field.placeholder`   | 保持「搜索项目或会话」                                     | 保持现有                                                                                          |
| `search.placeholder.noMatch` | 没有匹配的项目或会话。也可以搜索这台设备打开过的会话内容。 | No matching projects or sessions. Content search only covers conversations opened on this device. |
| `search.placeholder.idle`    | 保持现有（已写「包括已归档」）                             | 保持现有                                                                                          |
| `session.action.find`        | 查找                                                       | Find                                                                                              |
| 原生 find 占位               | 查找对话                                                   | Find in conversation                                                                              |
| 原生无结果                   | 无结果                                                     | No results                                                                                        |
| 原生计数                     | `{current} / {total}`                                      | `{current} / {total}`                                                                             |

零命中才用 `search.placeholder.noMatch`。有任意项目或会话行时不出现这句。

find 条字符串走 `LodyStrings`（UIKit）。菜单项走 RN locale。

## 失败与边界

- 旁路表与 KV 会话缓存以写入时刻为准。桌面继续聊过、手机未再打开：Inbox 正文可能过期；打开会话后 find 以当前 replica 为准。
- 从未打开过的会话：只有标题/项目/路径/分支能命中。
- 首次缓存因 12 MiB 上限没写成：没有正文行；已有旧缓存时保留旧索引。
- 升级前已有的 session 缓存在首次检索时回填；不要求重新打开或在线。
- Inbox 命中不保证 find 有可导航结果：折叠内容不展开，窗口外不翻页；无可导航命中时停留在最新 result。
- 账号/工作区隔离与现有 `session:` key 相同。
- 登出 `clear()` 后检索为空。
- 不把 Inbox 结果做成按消息多行。
- 不把整个列表搬进 Swift。

## 不做

- FTS5、Core Spotlight、`UIFindInteraction`
- 后台 bootstrap 全部会话历史
- 工作区全文（没打开过的会话）
- 列表 attributed 高亮
- 把 catalog / transcript 改成领域表
- 自动加载全部历史来凑 find 总数
- 搜索词进 URL / 深链

## 验证

不登录。Home Debug 已写入 `ui-design` 的 session 缓存（用户「设计首页」、助手「用项目分组。」、tool「读取」）。在此上扩：

Swift（`modules/lody-kit/verification`，与 `local-store` 同类）：

- 写入 envelope 后 `searchInbox` 能用「用项目分组」命中，`snippet` 含该句
- 搜 tool 标题「读取」不命中该会话
- 搜标题仍命中；标题命中时 `snippet == nil`
- 中文 `localizedStandardContains`（大小写英文字母）
- `clear()` 后正文不再命中
- 抽取：`text`/`thought` 进表，`tool_call`/`plan` 不进
- Markdown：粗体和跨 inline 格式的文字可命中；隐藏链接地址、文件链接内部 marker、图片 source 不命中；代码正文保留字面语法字符
- 旧数据库只有 session KV：首次搜索无需重写或联网即可命中；重复打开不重复回填；非法 envelope 不阻断；失败不写完成标记；用户／工作区结果隔离
- 写入／回填中途数据库失败：事务回滚，KV 与索引不出现半更新
- find 匹配：展开的正文命中、tool／折叠内容不计数、空查询无结果

UI（`verification/ui`，Home + Chat 预览，Inbox 与 iPad 侧栏都要跑到）：

- 标题/项目名照旧过滤
- 搜「用项目分组」出现该会话，副标题是摘录
- 搜「读取」不因 tool 标题出现
- 零命中看到内容搜索边界说明
- 点正文命中行：进会话、find 条带词、定位窗口内最后一个可导航命中、键盘不弹
- 仅 thought／已折叠中间文本命中：Inbox 有摘录，进入不展开过程，保留最新 result，find 不虚增计数
- 超过 50 个 entry 且仅早期正文命中：Inbox 有结果，进入不翻页、不跳转，保留最新 result；手动加载到该页后更新 find 结果
- Markdown 粗体、链接、跨格式文字、代码块和表格的高亮对齐显示文字；文件图标不带入内部 marker；流式更新与 cell 复用后无错位高亮
- 会话内更多 → 查找：焦点在输入框；上/下一条；关闭清高亮
- 只在已加载行计数

`pnpm check` 覆盖改过的 TS；`pnpm verify:native --case local-store` 通过 SwiftPM 使用现有 MarkdownParser 版本验证抽取和 SQLite 行为。Simulator 构建走 `pnpm verify:build` / `pnpm verify:simulator`，不另开 DerivedData。

## 相关

- 上游：`packages/components/src/lib/session-chat-search.ts`（只索引散文）
- 本仓：`LocalStore.swift`、`inbox.ts` `searchSections`、`useInboxModel.ts`、`sessionNav.ts`、`SessionScreen.tsx`、`LodyChatView.swift`、`ChatTranscript.swift`
- 父 issue：#29 / #13 / #7
