# 关联对话图标让 MCP 创建的对话始终可达

Status: implemented
Translation: current

[English](2026-09-24-session-relations-chip.md)

## 摘要

通过 `lody_session_create` 创建的对话和 Tab 过去只以对话流中的“已创建对话”卡片出现，卡片会随内容滚走，几轮之后用户就找不到这个对话派生了什么、又来自哪里。现在输入框信息栏里多了一个关联对话图标（图标加已创建数量）；点击后在信息栏上方弹出面板，依次列出父对话、分割线、以及每个已创建的对话或 Tab（Agent 图标、标题、类型）。第一版用的是一条独立固定栏，因多占一整行高度而被放弃。对话流中的卡片作为记录保留，但精简为一行可点击的条目。已用 jsdom 行为测试和 Storybook 截图验证，尚未在打包后的桌面应用中实际跑过。

## 决策

- 数据来源是 `SessionMeta.openedBySessionId`。MCP 创建的 Tab 同时带有 `parentSessionId` 和 `openedBySessionId`，所以新增的 `createdSessionsAtomFamily` 会保留它们（不同于服务 `⋯` 菜单、会丢掉 Tab 的 `openedSessionsAtomFamily`）。侧边对话已在右侧面板，因此排除；已归档的与其他活动关系列表一样排除。
- 类型为 `parentSessionId ? Tab : 对话`。Tab 行以 `{ sessionId: root, tabSessionId }` 导航，其他工作区里的 Tab 也能精确恢复。
- 该图标和 Preview 一样是 cluster 区的普通操作，不会进入 stage：stage 只容纳一个摘要项，导航列表没有摘要形态。`info-chip.tsx` 中的 `PopoverActionChip` 是可复用的形态（单击切换一个 `side="top"`、与信息栏其他弹层同样外观的 popover）。
- 放弃的方案：信息栏上方的独立固定栏（第一版）。它始终可见，但让输入框上方的界面占用翻倍。
- 只要任一方向存在就显示，而不只是有子对话时：没有子对话的被创建对话也需要一条固定的回到父对话的路径。数字只统计已创建的对话。
- 渲染开销：页面只读取一个布尔值（`useHasCreatedSessions`，对已创建列表的 `selectAtom`）来决定是否传入该图标，因此原本为空的信息栏仍会隐藏。列表本身由图标这个叶子组件订阅；子对话状态变化频繁，对话页不应因此重渲染。
- `SessionRelationCard`（创建对话的进度/完成卡片，以及“由…自动创建”开头卡片）改为一个 `h-8` 的整行按钮。操作文案移入可访问名称 `"<操作>: <标题>"`，选择器按前缀匹配；回复预览或错误信息仍内联并截断显示。

## 验证与局限

`tests/session-relation-card.test.tsx` 在真实元数据 store 上渲染该图标、打开弹层，检查包含（独立对话 + Tab）、排除（侧边对话、已归档）、分割线以及 Tab 的精确导航目标。`Sessions/SessionRelationsChip` stories 覆盖关闭/打开状态。尚未在打包应用中用真实的 MCP 扇出验证。
