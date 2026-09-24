# 关联对话栏让 MCP 创建的对话始终可达

Status: implemented
Translation: current

[English](2026-09-24-session-relations-bar.md)

## 摘要

通过 `lody_session_create` 创建的对话和 Tab 过去只以对话流中的“已创建对话”卡片出现，卡片会随内容滚走，几轮之后用户就找不到这个对话派生了什么、又来自哪里。现在在输入框信息栏正上方固定一条关联对话栏：收起时与信息栏同高，概括已创建数量和父对话；展开后依次列出父对话、分割线、以及每个已创建的对话或 Tab（Agent 图标、标题、类型）。对话流中的关系卡片作为记录保留，但精简为一行可点击的条目（标签、标题、状态、箭头），因为这条栏已是固定索引。已用 jsdom 行为测试和 Storybook 截图验证，尚未在打包后的桌面应用中实际跑过。

## 决策

- 数据来源是 `SessionMeta.openedBySessionId`。MCP 创建的 Tab 同时带有 `parentSessionId` 和 `openedBySessionId`，所以新增的 `createdSessionsAtomFamily` 会保留它们（不同于服务 `⋯` 菜单、会丢掉 Tab 的 `openedSessionsAtomFamily`）。侧边对话已在右侧面板，因此排除；已归档的与其他活动关系列表一样排除。
- 类型为 `parentSessionId ? Tab : 对话`。Tab 行以 `{ sessionId: root, tabSessionId }` 导航，其他工作区里的 Tab 也能精确恢复。
- 只要任一方向存在就显示，而不只是有子对话时：没有子对话的被创建对话同样需要一条固定的回到父对话的路径，栏头摘要会同时写出两者。
- 它是信息栏上方的独立栏，而不是信息栏里的一项。信息栏的 cluster/stage 模型只展示一个 staged 项，没有展开列表的形态；硬塞进去会破坏该约定。
- 展开列表向上生长，最高 `max-h-64` 并自带滚动，切换行不会在指针下移动。
- 已创建列表的订阅放在 `CurrentSessionRelationsBar` 叶子组件里：子对话状态变化频繁，对话页不应因此重渲染。

- `SessionRelationCard`（创建对话的进度/完成卡片，以及“由…自动创建”开头卡片）改为一个 `h-8` 的整行按钮。操作文案移入可访问名称 `"<操作>: <标题>"`，选择器按前缀匹配；回复预览或错误信息仍内联并截断显示。

## 验证与局限

`tests/session-relation-card.test.tsx` 在真实元数据 store 上渲染该栏，检查包含（独立对话 + Tab）、排除（侧边对话、已归档）、分割线以及 Tab 的精确导航目标。`Sessions/SessionRelationsBar` stories 覆盖收起/展开状态。尚未在打包应用中用真实的 MCP 扇出验证。
