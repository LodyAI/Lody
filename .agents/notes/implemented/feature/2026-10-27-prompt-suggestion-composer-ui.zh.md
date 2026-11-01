# Composer 提示建议

Status: implemented
Translation: current

[English](2026-10-27-prompt-suggestion-composer-ui.md)

[统一 ACP 下一条提示建议](2026-10-27-prompt-suggestions.zh.md)的后续。

## 摘要

经过协商的提示建议管线会按会话交付参考性的下一条提示文本，但 composer 之前没有展示它的位置。
本次改动在空草稿上以幽灵文本显示最新建议，文本前面桌面端是字面 `Tab` 键帽，移动端是“应用”控件。
接受只会把建议写入普通的受控草稿并聚焦光标，不会发送，也不会消费来源建议；因此清空草稿后建议会再次出现。
Composer 仍只负责展示：会话级订阅 hook 与工作区传输由本次改动之外的部分拥有，所以端到端生成仍未验证。

## 交互契约

- `ChatComposer` 接收 `promptSuggestion: string | null | undefined`。只有当前草稿严格为空、composer
  可用且建议非空时才显示。null、空字符串和纯空白都不显示；禁用、归档和提交中的 composer 也隐藏。
- IME 组合输入期间隐藏提示。mention 输入框把预编辑文本留在本地，到 `compositionend` 才写入
  `promptValue`，只判断“草稿为空”会让提示盖在中文／日文预编辑文本上。composer 跟踪
  `compositionstart`/`compositionend`（失焦时也清除标记）；取消组合且草稿仍为空时提示重新出现。
- 桌面端只在草稿为空、未按修饰键、非 IME 组合输入，且 Tab 的默认行为尚未被其他处理器占用时接受。
  接受会通过 `onPromptChange` 写入完整文本，再聚焦输入框并把光标放到末尾；绝不调用发送路径。
- 提示使用输入框自身的字号和行高，从输入起点开始显示；最多换行三行，超出后省略。`Tab` 键帽或
  “应用”控件放在文本之前，与第一行垂直居中，避开右侧的发送按钮。提示整体略微右移，空输入框的光标在它前面闪烁，不会被键帽盖住。自动增高的空 composer 会撑高到提示高度（不超过
  `maxRows`），换行的提示不会盖住底栏；提示消失后恢复行数下限。原先截成一行，移动端用户看不全就要决定是否采用。
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
- Storybook 的 `SessionPromptSuggestion`、`SessionPromptSuggestionMobile` 及其 `Long` 变体覆盖桌面提示、
  移动端“应用”以及换行／截断状态，静态 Storybook 构建成功。用 Playwright 在 900×600 与 420×700 下验证了
  桌面 Tab 写入草稿／光标位置与提示隐藏、移动端点击穿透聚焦、Tab 不写入、“应用”写入草稿／
  光标位置与提示隐藏，且控制台无错误。
- 多行布局新增自动增高用例：撑高到提示高度、受 `maxRows` 限制、隐藏后收回。Playwright 在 900×420 与
  390×520 下实测提示和输入框行高同为 24px，一至三行时高度一致。
- 合入所属 hook/runtime 后，`@lody/components` 类型检查通过。
- 没有可用真实模型，因此真实 ACP 建议生成与完整应用视觉检查仍未验证。

## 证据

- [Composer 提示实现](../../../../packages/components/src/components/chat/chat-composer.tsx)
- [会话接线](../../../../packages/components/src/components/sessions/session-chat-input-area.tsx)
- [测试](../../../../packages/components/tests/chat-composer-prompt-suggestion.test.tsx)
- [Stories](../../../../packages/components/src/stories/ChatComposer.stories.tsx)
