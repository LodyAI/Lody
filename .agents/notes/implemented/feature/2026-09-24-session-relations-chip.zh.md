# 关联对话树让 MCP 创建的对话始终可达

Status: implemented
Translation: current

[English](2026-09-24-session-relations-chip.md)

## 摘要

通过 `lody_session_create` 创建的对话和 Tab 过去只以对话流中的“已创建对话”卡片出现，卡片会随内容滚走，几轮之后用户就找不到这个对话派生了什么、又来自哪里。现在输入框信息栏里有一个关联对话图标；点击后在信息栏上方展开面板，显示当前对话所在的完整对话树：所有祖先与后代，每个对话一行、其 Tab 并排成胶囊，每项末尾显示与侧边栏相同的实时状态标记。先前的方案（独立固定栏、扁平的父/子列表）已被替换；对话流中的卡片作为记录保留，但精简为一行可点击条目。已用单元测试、jsdom 测试和 Storybook 截图验证，尚未在打包后的桌面应用中实际跑过。

## 决策

- 数据来源是 `SessionMeta.openedBySessionId`。纯函数 `lib/session-relation-tree.ts` 从当前行向上走到最顶层的未归档创建者，再包含其所有后代，因此从树中任何成员打开看到的都是同一棵树。树的边连接“行”（根对话）：创建者若是 Tab，会通过侧边栏的 `resolveSidebarOpenerRowId` 归到其根对话，但不受侧边栏一层深度的限制。
- 一行由一个根对话及其顶部 Tab 组成，Tab 以等宽胶囊并排，与用户在该对话中看到的标签栏一致。已关闭的 Tab 与标签栏一样隐藏，除非是当前对话（从已关闭 Tab 打开的对话仍挂在该行下）；侧边对话和已归档对话被排除，因此已归档的创建者会终止向上查找。遇到环时在第一个重复行停止。
- 末尾的类型标签（父对话 / 对话 / Tab）改为实时状态：复用侧边栏的 `SessionRowStatusIndicator`（等待 > 运行中 > 未读），状态在各处读起来一致；树的形状本身已表明哪些是 Tab。
- Tab 胶囊以 `{ sessionId: root, tabSessionId }` 导航，其他工作区里的 Tab 也能精确恢复。
- 该图标和 Preview 一样是 cluster 区的普通操作，不会进入 stage：stage 只容纳一个摘要项，树没有摘要形态。`info-chip.tsx` 中的 `PopoverActionChip` 通过解析外层 `[data-info-bar-surface]` 的 Radix `virtualRef` 锚定到整条信息栏，面板看起来是信息栏向上展开。曾尝试用 React context 传递信息栏的 ref，后已移除：它为唯一的使用者在整条信息栏外包了一层 Provider。
- 放弃的方案：信息栏上方的独立固定栏（第一版），因让输入框上方的界面占用翻倍；扁平的父对话 + 已创建列表（第二版），因每个方向只显示一层。
- 渲染开销：页面只读取一个布尔值（`useHasSessionRelations`，对活动对话列表的 `selectAtom`）来决定是否传入该图标，因此原本为空的信息栏仍会隐藏。树在图标这个叶子组件中构建；相关对话状态变化频繁，对话页不应因此重渲染。
- `SessionRelationCard`（创建对话的进度/完成卡片，以及“由…自动创建”开头卡片）改为一个 `h-8` 的整行按钮。操作文案移入可访问名称 `"<操作>: <标题>"`，选择器按前缀匹配；回复预览或错误信息仍内联并截断显示。

## 验证与局限

`tests/session-relation-tree.test.ts` 覆盖：从每个成员得到同一棵树、Tab 作为创建者、归档/侧边对话排除、已关闭 Tab 规则、环（含自引用）以及乱序输入下按创建时间排序。`tests/session-relation-card.test.tsx` 在真实信息栏中打开该图标，检查各行、当前标记以及 Tab 的精确导航目标。`Sessions/SessionRelationsChip` stories 用伪造的实时状态渲染这棵树。尚未在打包应用中用真实的 MCP 扇出验证。Tab 顺序按创建时间，而非用户在本地调整过的标签顺序。
