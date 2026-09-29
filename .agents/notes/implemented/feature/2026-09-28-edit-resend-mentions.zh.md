# 编辑重发支持 Mentions

Status: implemented
Translation: current

[English](2026-09-28-edit-resend-mentions.md)

## 摘要

编辑最后一条用户消息之前用的是裸 `Textarea`，所以 `@` 提及、`$` skill、`/` 命令——
这些 Composer 已经支持的能力——在编辑器里静默失效；而已发送消息里已有的提及
在重发时会丢失 chip 高亮和展开逻辑。现在内联编辑器内嵌与 Composer 相同的
`CombinedMentionTextarea`，并由同一个 `useSessionMentionSource` Hook 提供来源
解析（该 Hook 同时驱动 Composer）。保存路径走同一份发送前展开逻辑
（`useMentionPromptExpansion`），因此重发的消息带有与新发送一致的改写文本和
transcript span。

## 决策与证据

之所以要共享而非复制第二个 Composer，是因为两点：`mentionSource` 的优先级
（Code Collab provider → local project → GitHub repo）原本是在
`SessionChatInputArea` 里手工拼的；`mention-expansion.ts` 里的发送前改写列表
是 `$skill`、`@session`、`@role` token 变为机器可读文本的唯一入口。复用两者
保证编辑器里 `@` 可见的集合与 Composer 完全一致——一旦分叉，编辑器可能展示
出发送路径根本无法展开的文件。

`useSessionMentionSource`（新增于 `hooks/`）负责 provider-vs-local-vs-GitHub 的
推导；Composer 传 `value.includes('@')` 来懒加载文件索引，而编辑器传 `true`，
因为编辑器一打开就带着上一条消息的全文，必须在首次渲染时就解析其中已有的
token。

编辑器在保存时上报 `{ text, mentions }`；`SessionChatStreamImpl` 通过
`useMentionPromptExpansion`（按 stream 挂载一次，而非按行）展开并在 trim 后
重新锚定 span，于是 `session-chat-interface.tsx` 的 `handleEditLastUser` 拿到的
就是与普通发送相同的展开文本 + span，并写入替换后的 text block。没有 mention
来源的表面（分享页、tour）不传 `editMentionContext`，编辑器退化为普通
textarea。

编辑器的菜单使用 `anchor="caret"`（`MentionTwoLevelMenu` /
`CombinedMentionTextarea` 新增 prop）而非 Composer 的 frame 停靠——会话内编辑器
的菜单必须像文本补全一样跟着光标走；Composer 的 `data-mention-frame` 停靠 +
`side="top"` 仍是底部输入框的默认。同一调用方通过 `menuMobileDocked={false}`
退出 <640px 的 `MentionMobilePanel` 停靠——那条面板按"composer 上方"算几何，只有
底部 Composer + 键盘场景才成立；会话中部时它会渲染到屏幕外，所以编辑器在移动端
也保留浮动 caret 弹层。

测试新调用方暴露了一个共享 primitive 的 bug：`MentionInput` 的菜单导航 keydown
把任何 `Enter` 都当作选择——吞掉了 Cmd/Ctrl+Enter（宿主的发送/保存）和
Shift+Enter（换行）。两者现在在 `preventDefault` 之前放行，与 input 已有的其他
Enter 修饰键行为一致。

## 验证

`pnpm --filter @lody/components typecheck` 与针对改动文件的 oxlint 均通过。
Storybook `AI GUI/UserMessageEditor` 新增 `WithMentions` story，注入了 GitHub
mention source、两个可提及的 Session 以及 stub 命令；用 Playwright 驱动
Storybook 确认：`@` 会弹出两级菜单（Files/Issues/PRs/Skills/Sessions/Agent
Commands），`/` 会弹出命令菜单（仅在整个输入为 `/` 开头时，与 Composer 规则
一致），菜单跟随光标，未启用 mention 的 story 不弹菜单。边界测试（光标跟踪、
Esc 分层、Cmd/Ctrl/Shift+Enter、删除触发符、自适应高度上限、句中 `/`、快速
开关、窗口 resize、CSS zoom、mention 内 `@`、readOnly）发现并修复了上面所述的
修饰 Enter 被吞的问题，其余行为与 Composer 语义一致。尚未在 Electron 应用里对
真实 Session 做端到端验证。
