# 对话界面按会话的 key 可以放在哪里

Status: proposed
Translation: current

[English](2026-09-23-session-surface-key-boundary.md)

## 摘要

`session-detail.tsx` 用 `key={tabSession.id}` 挂载每个对话界面，因此切换会话会卸载并重新挂载整个
`SessionChatInterface`。把 key 下移可以让 React 复用与会话无关的外壳，但 key 之下所有依赖重新挂载的状态，
都会把上一个会话带进下一个会话。本文记录这些状态在哪里、哪些操作可能指向错误的会话、复用能省多少，以及
保证会话隔离的边界。

## 证据

在生产预览上用 React DevTools 钩子统计（在已缓存的对话之间键盘切换 10 次），按最近的区域统计每次切换的挂载：

| 区域 | 组件 | DOM 节点 |
| --- | --- | --- |
| `SessionChatStreamView`（对话行） | 944 | 380 |
| 输入区（`ChatComposer`、提及输入框、输入区） | 120 | 37 |
| `SessionChatInterface` 本身 | 43 | 9 |
| `SessionInfoBar` | 36 | 29 |
| `SessionHeaderMenu` | 34 | 5 |
| `DesktopRunConfigMenu` | 26 | 7 |

对话本体必须重新挂载（内容不同，Virtua 的尺寸缓存、滚动控制器和读取窗口都按会话）。可复用的外壳约 260 个组件、
约 90 个 DOM 节点，约占挂载工作的五分之一。对话本体中每次切换挂载约 21 行；行上的 Tooltip、Popover 和右键菜单
（`SessionForkDestinationPopover`、`AssistantTurnFooter`、`AssistantTurnConfigInfoButton`、`UserMessageRowView`、
`AgentFileLink`）展开为约 360 个 Radix 组件，只在悬停或点击时才有用。

## 发现

**根源泄漏：`useSessionDoc` 滞后一次渲染。** 它的 store、history、`ready`、队列和 `syncState` 只在 effect 中变化。
被复用的实例会有一次渲染用新 `session` 搭配旧文档；其写入回调已使用新 id。运行配置、MCP id、持久 Agent Role
（其 effect 随后把旧快照写进新会话的 atom）、当前回复 id（停止和引导）、待处理权限、队列和内容同步状态都由它派生。
store 带有 `sessionId`，渲染时的一次检查即可堵住。

**依赖重新挂载的状态**（复用时会泄漏）：

- `SessionChatInterface`：`pendingRemoteHtmlFileName`（确认后会为旧会话的文件打开新会话的浏览器）、
  `renameDialogTarget`、`isPrActionPending`、`isResolvingConflicts`、`pendingOwnerUserId`、
  `conversationPreparationSignalRef`；搜索状态以及发送中/计划决策状态由 effect 晚一次提交才重置。
- Hook：`useSessionMcpSelection` 只在持久化的 id 变化时清除覆盖值，两个会话持久化相同（常常为空）的 id 时，
  旧的 MCP 选择会随新会话的回合发出。`useCapacityAutoRetry` 会把待触发的定时器改指向新会话的 `dispatchPrompt`。
  `useGitHubPrDetails` 在 IndexedDB 返回前显示旧 PR 的检查（并启用 Merge）。`useAutoReview` 有一次提交显示旧的运行。
- 输入区：`agentRoleEditor`、`ChatComposer` 的预览/拖放状态、`uncontrolledMentionValues`，以及附件、运行配置、
  权限和用量菜单的打开状态。
- 异步续行：`await` 之后，`dispatchPrompt` 的调用方读取共享的输入框 ref（新会话的 Agent Role），
  `anchorChatToMessage` 滚动新会话的对话流，失败路径写入新会话的 `inputActionState` / `directDispatchInFlightRef`。

**已经隔离的部分：** 每个写入都在调用时指向 `session.id` 或绑定到它的 `useSessionDoc` 回调；
`SessionChatInputArea` 在渲染中重置草稿、附件和引用；上传显式传入目标会话；`<Mention key={draftKey}>` 隔离了
textarea 的 DOM、撤销栈和输入法；`useAcpSessionConfigSelectionState` 与 `useMessageSelection` 在渲染中隔离；
`SessionHeaderMenu`、对话流和分享界面都有 key。

桌面工具栏实例（`hideMessageArea`）没有 key、会跨切换存活。它按会话的 UI 状态（端口确认、改名目标、
PR、冲突和所有者的待处理标志）现在记录所属会话，只在该会话下读取；`useGitHubPrDetails` 在当前 PR 的缓存读取
或请求完成前不返回数据。

## 提议

1. 暂时保持 key 不动。复用外壳只省约五分之一的挂载工作，而且需要先修好上面每一项。
2. 先做更大且隔离的收益：行上的 Tooltip、Popover 和右键菜单改为在首次悬停、聚焦或点击时挂载，而不是随每一行挂载
   （已完成：`ui/interaction-arm.tsx`）。
3. 如果仍想复用外壳，按以下顺序下移 key：
   - `useSessionDoc` 在渲染中把 `loadedStore.sessionId !== sessionId` 视为未加载。
   - `SessionChatInterface` 的泄漏项移入已有的、重置操作状态的渲染阶段代码块；两处 `useEffect([session.id])`
     重置也移到那里。
   - `useSessionMcpSelection`、`useCapacityAutoRetry`、`useGitHubPrDetails` 和 `useAutoReview` 在渲染中按会话重置或隔离。
   - 异步续行在 `await` 之前读取 Agent Role，并在会话已变化时放弃 UI 写入。
   - 保留 key：对话流、`<Mention key={draftKey}>`，以及每个持有会话状态的对话框或菜单。
