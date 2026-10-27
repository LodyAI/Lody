# Composer 提示建议

Status: implemented
Translation: current

[English](2026-10-27-prompt-suggestion-composer-ui.md)

[统一 ACP 下一条提示建议](2026-10-27-prompt-suggestions.zh.md)的后续。

## 摘要

经过协商的提示建议管线会按会话交付参考性的下一条提示文本，但 composer 之前没有展示它的位置。
本次改动在空草稿上内联显示最新建议：桌面端是字面 `Tab` 键帽加淡色文本，移动端是“应用”控件。
接受只会把建议写入普通的受控草稿并聚焦光标，不会发送，也不会消费来源建议；因此清空草稿后建议会再次出现。
Composer 仍只负责展示：会话级订阅 hook 与工作区传输由本次改动之外的部分拥有，所以端到端生成仍未验证。

## 交互契约

- `ChatComposer` 接收 `promptSuggestion: string | null | undefined`。只有当前草稿严格为空、composer
  可用且建议非空时才显示。null、空字符串和纯空白都不显示；禁用、归档和提交中的 composer 也隐藏。
- 桌面端只在草稿为空、未按修饰键、非 IME 组合输入，且 Tab 的默认行为尚未被其他处理器占用时接受。
  接受会通过 `onPromptChange` 写入完整文本，再聚焦输入框并把光标放到末尾；绝不调用发送路径。
- 移动端只显示“应用”按钮，不响应键盘接受。除该控件外，提示层不接收指针事件，因此点击建议文本
  或输入区其他位置仍会正常聚焦输入框。
- 提示完全由 prop 推导，没有本地“已消费”状态。输入文字会隐藏它，清空会恢复同一段文本，
  接受也不会删除上游最新值。
- 每个挂载的 `SessionChatInputArea` 都把自己的会话 ID 传给 hook，因此保活的 tab 各读各的会话，
  UI 不在对话之间共享建议状态。

## 验证

- [新增 composer 测试](../../../../packages/components/tests/chat-composer-prompt-suggestion.test.tsx)
  覆盖桌面／移动展示、空值与纯空白抑制、Tab 接受与光标位置、已有文字、Shift+Tab、IME、禁用状态、
  移动端仅“应用”接受、点击穿透聚焦，以及清空后恢复建议；5 项通过。
- 在提供的 hook 存在时，既有 `chat-composer-focus`、`chat-composer-autoresize` 和
  `session-chat-input-submission` 测试通过（65 项）。
- Storybook 的 `SessionPromptSuggestion` 与 `SessionPromptSuggestionMobile` 覆盖桌面提示和
  移动端“应用”状态，静态 Storybook 构建成功。用 Playwright 在 900×600 与 420×700 下验证了
  桌面 Tab 写入草稿／光标位置与提示隐藏、移动端点击穿透聚焦、Tab 不写入、“应用”写入草稿／
  光标位置与提示隐藏，且控制台无错误。
- `@lody/components` 类型检查只报依赖方错误：提供的 hook 引用了其所属改动新增的 runtime 方法，
  隔离检出中的 core 子模块缺 `@agentclientprotocol/sdk` 类型。本提交预期在 hook／runtime 提交之后
  cherry-pick。
- 没有可用真实模型，因此真实 ACP 建议生成与完整应用视觉检查仍未验证。

## 证据

- [Composer 提示实现](../../../../packages/components/src/components/chat/chat-composer.tsx)
- [会话接线](../../../../packages/components/src/components/sessions/session-chat-input-area.tsx)
- [测试](../../../../packages/components/tests/chat-composer-prompt-suggestion.test.tsx)
- [Stories](../../../../packages/components/src/stories/ChatComposer.stories.tsx)
