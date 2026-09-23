# 粘贴会话 URL 转为 `session://` mention 链接

Status: implemented
Translation: current

[English](2026-09-18-session-mention-uri-and-paste.md)

## 摘要

以前把 Lody 对话 URL 粘进输入框只会得到一段普通链接，而 session mention 发送前又会
展开成一句只带 session id 的英文 MCP 指令——agent 只能自行猜测如何拉历史，用户也没有
「就要纯链接」的明确逃生口。现在输入框会把单独一条本应用会话 URL 转成 session
mention（Cmd/Ctrl+Shift+V 除外），发送前的重写改为 `[@Title](session://<sessionId>)`，
不再写那句指令。Lody MCP 在 server instructions 与 `lody_session_history` 中说明该格式，
并同时接受裸 id 与 `session://` URI。约束是只认应用 base origin；外站链接与夹杂其他文字
的粘贴仍按普通文本处理。

## 决策与证据

- 发给 agent 的形态是 markdown 链接，而不是英文祈使句。
  `buildSessionMentionPrompt` 产出 `[@Title](session://<id>)`，优先用 live 会话标题，
  否则回退到 composer 里的 slug；标题中的方括号会转义，避免打断链接。Transcript
  chip 仍用 span label 画 slug；复制气泡保留展开后的 `session://` 链接，以便在 Lody
  外仍可寻址。
- 粘贴识别看 base URL，而不只看路径形状。
  [`parseAppSessionUrl`](../../../../packages/components/src/lib/session-app-url.ts)
  只接受 origin 属于当前页或 `getAppShareOrigin()`（配置了则用 `VITE_SITE_URL`）、
  路径为 `/{workspace}/sessions/{sessionId}` 的绝对 URL。带空白的剪贴板文本与非会话
  应用路径保持原样。Cmd/Ctrl+Shift+V 跳过转换，让用户刻意粘成普通链接。
- 插入落在光标处（或替换选区），通过 `MentionInsertRequest.replaceEnd` 与
  `insertSessionMention(sessionId, { at, replaceEnd })`。未知、自身或已 mention 的
  会话返回 false，粘贴回落到普通文本——不会凭空造出地址列表解析不了的 mention。
- 解引用契约由 Lody MCP 持有。Server `instructions` 要求对
  `[@Title](session://…)` 调用 `lody_session_history`；`resolveMcpSessionId` 会剥掉
  `session://` 前缀，两种写法都可用。工具描述与 `sessionId` schema 文案写同一规则，
  避免只读工具说明、忽略 instructions 的客户端漏掉约定。
- Composer 复制必须走与发送相同的重写。`ChatComposer` 跟踪 live mention ranges，
  在 copy 时跑 `getExpandedClipboardTextForSelection`，因此选中 `@slug` session
  mention 时剪贴板是 `[@Title](session://…)`，而不是 chip 文本。pasted-text 展开
  共用同一 helper。

## 验证与限制

- [`session-app-url.test.ts`](../../../../packages/components/tests/session-app-url.test.ts)
  覆盖允许的 origin、保留 search/hash、拒绝外站，以及纯链接粘贴快捷键。
- [`mention-session-source.test.ts`](../../../../packages/components/tests/mention-session-source.test.ts)
  与 [`mention-prompt-spans.test.ts`](../../../../packages/components/tests/mention-prompt-spans.test.ts)
  断言重写产出 `session://` 链接、有标题时优先用标题，并转义标签中的方括号。
- [`composer-clipboard.test.ts`](../../../../packages/components/tests/composer-clipboard.test.ts)
  覆盖 session rewrite 的选区展开、部分选中 slug 仍整段展开，以及无展开项时回落
  浏览器原生复制。
- [`lody-mcp-server.test.ts`](../../../../apps/cli/tests/lody-mcp-server.test.ts)
  断言 `resolveMcpSessionId` 接受裸 id 与 `session://` URI，并仍可回退到当前会话。
- 粘贴转换已接到会话与首页输入框，但没有渲染组件的 paste 事件测试；真实浏览器剪贴板
  与打包后 Electron 的修饰键粘贴未在此验证。
