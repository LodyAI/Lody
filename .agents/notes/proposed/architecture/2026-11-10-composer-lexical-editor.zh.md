# 输入框编辑器：用 Lexical 替换 textarea 加显示层（PRD）

Status: proposed
Translation: current

[English](2026-11-10-composer-lexical-editor.md)

## 摘要

共享的网页 composer 用在 Electron 桌面端、浏览器、Capacitor 移动 App 和移动端网页上。它的结构是一个字形透明的原生 `<textarea>`，下面垫一个显示层 `<div>`，由显示层画出文字和 mention chip。光标属于 textarea，文字由显示层画，两层排版只要有一点差异，光标就会错位。2026-11-10 的报告就是这样：内容超出后 textarea 出现经典滚动条，显示层没有，两层换行点不同，光标落到正在输入的文字下面几行。owner 决定不再打补丁，在一次改动里把所有带 mention 的 composer 都换成同一个 Lexical 编辑器，交互和样式要与现在一致，用户无感知。发出去的消息格式和本地草稿格式逐字节不变，所以原生 iOS 和 Android 客户端不需要改动。本文是给其他 agent 实现用的方案，其中的内容都还没有实现，也没有验证。

## 1. 背景

### 1.1 现有结构

- `packages/components/src/ui/mention/mention-input.tsx` 渲染一个字形透明（`-webkit-text-fill-color: transparent`）的 `<textarea>`，负责编辑、光标和输入法。
- `mention-highlighter.tsx` 在它下面放一个绝对定位的显示层，画所有正文、chip 和选区。显示层复制 textarea 的字体、内边距和换行规则，并同步它的滚动位置和高度。
- 为了把 `@` / `/` / `$` 菜单放在光标处，`mention-input.tsx` 每次测量都要在 `<body>` 前面再插一个离屏克隆。
- chip 不能改变字符宽度：图标盖在文本里预留的空白字符（figure space）上（`components/mentions/mention-chips.tsx`）。
- `combined-mention-textarea.tsx`（约 1.2k 行）负责草稿恢复（hydration）、触发符、chip 样式解析和命令式插入。`ui/mention/` 目录约 3.8k 行。

### 1.2 为什么总出问题

原生 textarea 和显示层 div 是两套排版，必须在每一个换行点上都一致。但遇到滚动条、小数缩放、字体回退、chip 或输入法的预编辑文字（preedit）时，没法保证一致。同类问题的历史：#1128、#1140（菜单不跟光标）、#2366（chip 边界处的颜色和光标）、输入法光标吸附那次修复，以及 11-10 的滚动条换行问题。

**11-10 的复现**（Storybook `mentions-mentiontwolevelmenu--session-mention-rendering`，在显示滚动条的 Chromium 里）：

- **条件**：五行高的 composer 里放三段中英混排长文本。
- **宽度差**：有了滚动条，textarea 的内容宽度比显示层窄 8px。
- **结果**：宽度为 402、405、411、414、417、573、576、603、606、609px 时，textarea 的 `scrollHeight` 比显示层多 72px，也就是 3 行。
- **用户看到的现象**：光标落在正在编辑的文字下面几行。用户的录屏里，打拼音时光标和候选框都在正在编辑那一行的下一行。

补上滚动条宽度只能修这一个情况，同类问题还会再出，所以 owner 否决了这个补丁。

## 2. 用户与平台（按风险排序）

下面这些平台跑的都是同一个 React composer，都有风险：

| 平台                                              | 引擎                        | 主要风险                                                    |
| ------------------------------------------------- | --------------------------- | ----------------------------------------------------------- |
| Electron 桌面端（macOS / Windows / Linux）        | Chromium                    | 拼音/日文输入法、快捷键、菜单定位、自动增高                 |
| Android App（Capacitor WebView）和 Android Chrome | Chromium WebView            | Gboard 组字和联想、软键盘上推、底部停靠菜单、`enterkeyhint` |
| iOS App（Capacitor WKWebView）和 iOS Safari       | WebKit                      | 拼音输入法、自动更正、选区拖柄、软键盘上推                  |
| 桌面浏览器                                        | Chromium / WebKit / Firefox | 同桌面端                                                    |

**不受影响**：仓库内的原生客户端 `apps/mobile/ios`（Lexical Swift 的 `ChatComposerView`）和 `apps/mobile/android`（Compose `BasicTextField`）。它们保留自己的 composer，只读取网页 composer 发出的内容，而这个格式不变。

## 3. 目标

1. 由同一个元素负责显示和编辑文字。在第 2 节的所有平台上，光标、选区、输入法预编辑和 chip 都始终在正在编辑的字上。
2. 第 6 节的每项交互都与现在一致或更好，第 7 节的每项视觉都与现在完全一致。
3. 同样的输入，发出的 `text` 和 `spans` 与现在逐字节相同。当前版本写下的草稿在新版本里能恢复。
4. 删除 textarea、显示层、光标克隆和 textarea 的高度测量。不留兜底、开关或第二个绘制层。

## 4. 不做

- 网页端富文本（加粗、列表、Markdown 快捷键）。新编辑器为以后留了余地，但这次不做。
- 改动原生 iOS / Android composer、运行时的发送链路或消息 schema。
- 跨设备同步草稿，或者和 iOS 共用 Lexical JSON。
- 改造不带 mention 的普通 textarea：
  - 排队消息的行内编辑、提问卡片；
  - 文档选段编辑器、可视化批注 composer；
  - diff 评论草稿、引导页的第一个任务；
  - 定时任务的纯文本提示词、Agent Role 表单；
  - `chat-composer.tsx` 里的粘贴文本/引用编辑器，以及首页崩溃后的兜底输入框。

## 5. 反目标（「能用」也算失败的情况）

- 中文、日文或 Gboard 输入出现任何退化：
  - 丢字、重复字或字序错乱；
  - 组字过程中光标跳动；
  - 同一段输入提交两次；
  - 组字中按回车就发出了消息，或者选中了菜单项。
- 同样的草稿，Agent 收到的内容有任何变化。
- 留一个隐藏的 textarea、做一个假装是 `HTMLTextAreaElement` 的 ref、用运行时开关同时保留两套实现，或者再加一个绘制层。
- composer 增高时打乱对话的阅读位置（违反 `conversation-scroll` 契约），或者切换会话时 composer 明显加载变慢。

## 6. 交互要求

每一条都是验收标准。「同现在」指 `ui/mention/AGENTS.md`、`components/mentions/AGENTS.md`、`.agents/docs/ui-mentions.md` 以及下文提到的 Spec 里记录的行为。

### 6.1 文本编辑

- **I1 光标在字上**：输入、输入法预编辑、选区和光标始终在正在编辑的字上，包括：
  - 长中文、长英文和中英混排；
  - 内容超出后、在输入框内滚动后、窗口缩放和应用缩放后；
  - chip 位于行首、行中、行尾时。
- **I2 换行**：Shift+Enter 和各平台的换行规则同现在。换行在字符串里是 `\n`，不能变成新段落、序列化出 `\n\n`。
- **I3 回车发送**：回车发送、Mod+Shift+Enter 反转、移动端 `enterKeyHint` 的动作、「输入法组字时不发送」这些规则都不变（见 `session-chat-input-area.tsx`）。
- **I4 撤销重做**：Cmd/Ctrl+Z、Shift+Cmd/Ctrl+Z、Ctrl+Y 以及 `historyUndo`/`historyRedo` 输入类型都可用。chip 和文字一起撤销、一起重做。撤销历史里还引用着的内容继续保留（`onHistoryRetainValues`）。
- **I5 占位符**：只在内容为空时显示，颜色同现在，并且不计入高度。空输入框上的提示建议照样覆盖显示，并撑开输入框，按 Tab 采纳。
- **I6 拼写检查和自动更正**：拼写检查保持关闭，和现在一样，不会多出波浪线。移动端的自动更正和联想不能破坏 chip。
- **I7 只读和禁用**：语义同现在，包括发送期间的 `preservePromptFocus`（保留焦点但阻止输入）。

### 6.2 Mention 和 chip

- **M1 chip 是原子的**：点击、轻点、方向键和获得焦点都不能把光标放进 chip 内部。
  - 左右方向键和 macOS 的 Ctrl+B/F 一步跨过 chip；Cmd/Ctrl+方向键按词跳。
  - Backspace/Delete 连同 chip 后面的空格一起删。
  - 光标紧挨在那个空格后面时，Backspace 只删空格。
  - 拖出的选区可以跨过 chip，用于复制、替换和删除。
- **M2 触发符**：`@`、`$`/`￥`/`¥`、`/`/`、` 和 `#` 的规则同现在（`findTriggerCandidates`，以及 Spec `command-mention-triggers`、`skill-mention-triggers`）：
  - 触发符前面必须是空白或行首（`#` 例外）；
  - 查询词里不能有空白；
  - 只有整个输入框都是斜杠命令时才给出命令列表。
- **M3 菜单按键**：同现在：
  - Enter 或 Tab 选中；带修饰键的 Enter 交给调用方处理。
  - Tab 或右方向键进入下一级；Backspace 或左方向键一次退回 `ns:` 前缀。
  - Shift+Tab 关闭菜单，不影响模式切换。
  - 上/下/Home/End 移动高亮；Escape 关闭菜单并阻止事件继续冒泡。
  - 组件自身先于调用方处理按键。
- **M4 插入来源**：下面这些插入都沿用现有的唯一拼接规则（`applyMentionSplice`）和 `separate`、后缀语义，并且插入后获得焦点：
  - 菜单选择，包括导航项，以及带加载中/错误行的异步准备；
  - `onMentionInsert` 批量插入；
  - `mentionActionsRef`（`insertExternalMention`、`insertSessionMention`、`insertPathMentions`）；
  - 拖入目录、粘贴会话链接、插入引用。
- **M5 草稿恢复**：
  - 保存下来的区间是权威来源，重叠的区间丢弃。
  - 切换 `draftKey` 时重置编辑器。
  - 内容清空后保留焦点。
  - 同一次刷新里多个草稿恢复逻辑（hydrator）的结果要合并（`useFlushConsistentState`）。
- **M6 点击 chip**：点击 chip 触发 `onMentionClick`，粘贴文本和引用 chip 会打开各自的编辑器。
- **M7 菜单定位**：Spec `composer-mention-menu-placement` 的要求全部不变：
  - 菜单在换行、滚动、窗口缩放和应用缩放时都跟着光标。
  - 主 composer 优先在光标上方打开；行内编辑器和对话框编辑器优先在下方，不够时翻到上方。
  - `positionAnchor="composer"` 在整个打开期间锁定所在的一侧。
  - 菜单宽度遵守 `--mention-input-width`。
  - 移动端停靠面板在 `[data-mention-frame]` 上方。
  - 测量光标时不能触发整页重新计算样式。

### 6.3 剪贴板与拖放

- **C1 粘贴优先级**：遵守 Spec `composer-paste-precedence`：文件和图片作为附件；大段文字变成粘贴 chip；会话链接变成会话 chip；「改为附加图片」的提示保留。其余文字按纯文本插入，HTML 不解析进文档。
- **C2 复制展开**：复制时 chip 按现有规则展开（会话复制成 `[@Title](lody://session/…)`），跨过 chip 的选区也一样。
- **C3 拖放**：文件和图片拖放照旧由外层容器处理；拖入目录插入路径 chip。

### 6.4 焦点与全局键盘

- **F1 焦点行为**：现有的焦点行为保持不变：
  - 首页用 Cmd+L 切换焦点；
  - 点击容器时聚焦到编辑器；
  - 页面跳转、发送或关闭对话框（`finalFocus`）后焦点回到输入框；
  - 移动端发送后收起键盘。
- **F2 全局识别 composer**：识别 composer 的代码改用 `[data-lody-composer-input]`，不再判断 `tagName === 'TEXTAREA'`。涉及：
  - `lib/menu-focus.ts`；
  - `use-chat-landing-keyboard-nav.ts`；
  - `lib/commands/shortcuts.ts`；
  - 引导页导览的镜头定位；
  - 焦点作用域；
  - 键盘导航；
  - 移动端抽屉。
    列表导航仍然不能拦截文本输入框里的按键。
- **F3 无障碍**：编辑器保留：
  - `role="combobox"`，以及 `aria-multiline="true"`；
  - `aria-expanded`、`aria-controls`、`aria-activedescendant`、`aria-autocomplete="list"`；
  - 标签、`aria-invalid` 和 `required` 语义。
    读屏器按 chip 的可见文字朗读。

### 6.5 移动端

- **P1 软键盘**：composer 随软键盘上推、mention 面板停靠在输入框上方、全高 composer 使用 `mobilePanelPlacement="bottom"`，这些都不变。
- **P2 Android 输入**：在 chip 旁边（行首、行中、行尾）用 Gboard 组字、联想、滑行输入、语音输入和表情键盘，都能正确插入文字。
- **P3 iOS 输入**：在 chip 旁边，拼音、自动更正替换、选区拖柄、长按放大镜和听写都正常。

## 7. 视觉要求

与现在完全一致，用户不能察觉到改动。实现方动手改代码前，先给下面列出的 Story 截「改动前」的图，浅色和深色各一套；PR 里附上改动前后的对比图。任何可见差异都算缺陷。

### 7.1 文字与输入框

- **V1 字体**：各变体的字体、字号、行高、内边距、颜色和占位符颜色保持不变（见 `chat-composer.tsx` 里的 `getChatComposerTextareaClassName` 和 `dialogTextareaClassName`）：

  | 变体    | 字号与行高            | 内边距      | 最小高度               |
  | ------- | --------------------- | ----------- | ---------------------- |
  | session | `text-sm leading-6`   | `px-1`      | 桌面 48px、移动端 24px |
  | landing | 同现在                | `px-0`      | 120 / 140px            |
  | sheet   | `text-base leading-7` | `px-5 py-4` | 同现在                 |
  | dialog  | 同现在                | `px-4 py-3` | 120px                  |

  所有变体都使用 `typography.prompt`、`text-input-foreground` 和 `placeholder:text-input-placeholder/85`。

- **V2 自动增高**：输入框从 `rows` 行开始增高，最多到 `maxRows`（默认 12）行加内边距，之后在框内滚动，使用全局的细滚动条。空输入框的高度要精确，输入第一个字时不能闪动。增高时保持对话的阅读位置。textarea 去掉后，原来的 textarea 高度测量代码一并删除。
- **V3 选区颜色**：选区使用系统的 `Highlight`/`HighlightText` 颜色，跨 chip 的选区也一样。

### 7.2 chip（基准：`components/mentions/mention-chips.tsx`）

- **V4 纯文字 chip**：普通 mention 只改文字颜色（`MENTION_CHIP_CLASS_NAME`），粘贴文本用中性色（`MENTION_NEUTRAL_CHIP_CLASS_NAME`）。`#issue`、`$skill`、`/command` 保留各自的前缀符号，不加图标。
- **V5 图标 chip**：file/dir 按路径显示单色文件或文件夹图标；session 用 `MessagesSquare`；agent_role 用 `UserRoundCog`，并保留 `combined-mention-textarea.tsx` 里的 Role 表情升级；pasted_text 用 `ClipboardList`；message_quote 用 `Quote`。图标大小为 `1.05em`。
- **V6 引用 chip**：引用 chip 使用填充底色：标签色以 8% 混在抬升背景上，圆角 `radius.mini`，跨行时 `box-decoration-break: clone`。
- **V7 外观不变**：chip 保持现在的外观和字符宽度，包括粘贴文本标签里的 figure space 留白。用户不能察觉到这次改动（owner，2026-11-10）。带旧版标签和 figure space 标签的草稿照现在的样子显示。
- **V8 选中的 chip**：选区里的 chip 要显示为选中状态。

### 7.3 基准 Story

- `ChatComposer.stories.tsx`：全部 Story，重点是 `SessionMentionStress`、`SessionMentionWideDark`、`SessionLongPrompt`、`LandingWithPastedText`、`DialogMentionStress`、`SessionPromptSuggestion*`。
- `MentionChips.stories.tsx`：`PlainHighlight`、`IconChips`、`IconChipsDark`。
- `MentionTwoLevelMenu.stories.tsx`：`SessionMentionRendering`、`FloatingInComposer`、`MainComposerAboveFrame`、`MainComposerRoleCatalogAtCaret`、`FloatingComposerAtTop`、`PreparedShortcut`、`SkillCategoryMobile`。
- `MessageQuotes.stories.tsx`、`SessionChatInputArea.stories.tsx`、`MobileChatLandingScreen.stories.tsx`、`ChatLandingView.stories.tsx`、`ScheduleMentions.stories.tsx`、`DraftSessionChatInterface.stories.tsx`。

## 8. 技术方案

### 8.1 已定

- **D1 编辑器**：使用 Lexical（`lexical`、`@lexical/react`、`@lexical/history`、`@lexical/utils`，以及 `@lexical/plain-text` 或一个等效的最小纯文本插件）。
  - 在 `packages/components` 里锁定一个当前稳定版的精确版本，并更新 `pnpm-lock.yaml`。
  - 网页端不和 iOS 共用 Lexical JSON（iOS 的测试样本锁定在 0.49），所以两边版本不必一致。
- **D2 文档结构**：根节点下只有一个 `ParagraphNode`，里面只放 `TextNode`、`LineBreakNode` 和 Lody 的 mention 节点。回车和粘贴都不能产生第二个段落。
- **D3 字符串边界**：composer 对外的模型保持不变：纯字符串，加上以 UTF-16 计、左闭右开的 `Mention` 区间 `{start, end, value, kind}`。
  - 偏移量只在两个纯函数里计算：`toComposerValue(editorState) → {text, mentions}` 和 `fromComposerValue({text, mentions}) → nodes`。
  - mention 节点序列化后，正好是现在插入的那段文本：`@path`、`#123`、`$skill`、`/cmd`、会话/Role token、粘贴文本的标签和引用文本。
  - 不合法或重叠的区间，按 `sanitizeMentionRanges` 现在的规则丢弃。
- **D4 调用方控制**：字符串仍由调用方控制。
  - 外部传入的值和编辑器当前的序列化结果不同时，重建编辑器内容，并按偏移量恢复光标。
  - 值相同时什么都不做。
  - 输入法组字期间，不应用任何外部写入。
- **D5 显式句柄**：所有 `forwardRef<HTMLTextAreaElement>` 一律换成 `ComposerInputHandle`：
  - `focus(options)`、`blur()`、`element`（即 contenteditable 元素）；
  - `getText()`、`getSelection() → {start, end}`、`setSelection(start, end)`；
  - `isComposing()`。
    由类型检查强制第 9 节列出的所有调用点迁移。之后不再有代码读 `.value`、`.selectionStart`、`setSelectionRange` 或 `scrollHeight`。
- **D6 保留**：`Mention` 根组件（菜单状态、触发符、注册表、异步准备、插入、`onNavigateBack`、按最新写入值合并的更新逻辑）、`mention-input-core.ts`（区间运算）、菜单和面板、草稿恢复逻辑，以及 chip 样式解析。
- **D7 删除**：`mention-input.tsx` 里的 textarea、光标克隆和相关胶水代码；`mention-highlighter.tsx`；`chat/textarea-measurement.ts`；textarea 的自动增高逻辑；没有调用方的 `FileAtMentionTextarea`。
- **D8 菜单锚点**：锚点取折叠后的 DOM 选区 range 的矩形，空行时退回按行高计算；floating-ui 的 `contextElement` 用编辑器元素。
- **D9 消息格式**：发出的消息格式不变：一个 `text` 输入块，加上严格校验的 `MessageTextSpan[]`，仍由现有的 `useMentionPromptExpansion` 生成。
- **D10 草稿存储**：本地草稿存储不变（字符串、粘贴草稿、mention 区间、引用草稿），不做迁移。
- **D11 上线方式**：一次性上线，不加运行时开关；第 10 节全部通过后才合入。

### 8.2 由第 1 步的测试来定：mention 节点类型

- **首选**：行内 `DecoratorNode`，通过 `getMentionChip` 渲染 chip。它天然是原子的，也是 Lexical 里最常见的 mention 做法。
- **备选**：token 模式的 `TextNode`，用 class 加样式，也就是 iOS 已经上线的 `ChatReferenceNode` 的做法。它少了 `contenteditable=false` 的元素块，但图标只能用纯 CSS 实现。
- **判定**：用 10.3 节的输入法用例，分别在 chip 位于行首、行中、行尾时测试。测试环境是 Chromium（CDP `Input.imeSetComposition`）、WebKit、Android 模拟器上的 Gboard、iOS 模拟器上的拼音。Decorator 通过就用它，不通过就用 token 文本。结果和证据记进本文。两种方案下，序列化契约（D3）都一样。

### 8.3 留给实现方

- 组件和文件的命名；`CombinedMentionTextarea` 是否改名。
- 撤销用 Lexical 自带的历史，还是在字符串边界上沿用现有的快照栈，只要满足 I4。
- `rows` 和最小高度用什么 CSS 来表达。
- 现有测试怎么拆分成纯单元测试和 Playwright 测试。

## 9. 需要迁移的调用方

- `chat/chat-composer.tsx`：session、landing、sheet、dialog 四种变体；自动增高；提示建议；复制；删除引用时的光标位置。
- `sessions/session-chat-input-area.tsx`：引用插入位置的光标跟踪、粘贴文本插入、粘贴与拖放、命令式句柄、`finalFocus`，以及 `chat/submission/` 下的发送后焦点辅助函数。
- `chat/chat-landing.tsx` 和 `chat/chat-landing-view.tsx`：Cmd+L、粘贴文本插入、移动端新建对话面板、粘贴处理。
- `schedules/schedule-mention-form.tsx` 和 `schedule-view.tsx` 里 `renderPrompt` 的类型；`schedules/scheduled-message-editor.tsx`。
- `ai-gui/user-message-editor.tsx`（编辑重发：`rows=1`，Escape 取消，Mod+Enter 保存，引用 chip，自动增高）。
- `settings/prompt-shortcuts-setting.tsx` 和 `prompt-shortcut-form.tsx`。
- F2 列出的全局选择器。
- 要废弃的规则：把 `ui/mention/AGENTS.md`、`components/mentions/AGENTS.md`、`.agents/docs/ui-mentions.md` 和 `mention-chips.tsx` 文件头注释里针对 textarea 的规则，改写成描述新编辑器的内容；更新 Spec `composer-mention-menu-placement` 的 Evidence 链接。

## 10. 验证与验收

### 10.1 消息格式黄金样本（替换之前先录）

用现有实现录下 `{草稿 → text, spans}` 样本，覆盖：

- 每一种 mention；
- 引用和粘贴文本；
- 中文、emoji 代理对、换行；
- 位于行首行尾和相邻的 chip；
- 带旧版标签和带 figure space 标签的粘贴草稿。

新 composer 必须逐字节复现这些样本。这是原生客户端兼容的证据。

### 10.2 单元测试（vitest，纯函数）

- 序列化往返和偏移量性质。
- 区间清理。
- 基于序列化文本的触发符识别。

### 10.3 浏览器测试（Storybook 上跑 Playwright）

在 Chromium 和 `LODY_E2E_BROWSER=webkit` 两个环境下运行。下面这些 spec 针对新编辑器重写：

- `composer-mention-placement`、`message-quotes`、`composer-submission-focus`、`interface-typography`。

新增的测试：

- 显示滚动条时输入超出高度的中文长文本，检查光标矩形落在对应偏移的字的矩形上；
- 通过 CDP 模拟输入法组字：预编辑、提交、取消，以及组字时按回车；
- chip 边界和删除；
- 撤销与重做；
- 粘贴优先级和复制展开；
- 自动增高与阅读位置；
- 菜单定位。

原来用 `setNativeValue`、`setSelectionRange` 驱动 textarea 的组件测试（17 个文件），改为通过句柄驱动，或迁到 Playwright。浅层测试直接删掉，不要搬过来。

### 10.4 真机验收

每一行录一段短视频附在 PR 里。

| 平台                                          | 必须通过                                                                |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| Electron 桌面端（macOS）                      | 第 6、7 节全部要求，使用 macOS 拼音输入法                               |
| Android 模拟器（Chrome 或 Capacitor WebView） | Gboard 拼音和英文联想、滑行输入和语音输入、软键盘上推、停靠菜单、发送键 |
| iOS 模拟器（Safari 或 Capacitor）             | 拼音、自动更正、选区拖柄、软键盘上推、停靠菜单                          |
| 原生 iOS App                                  | 能打开、显示并编辑新网页 composer 发出的、包含各类 chip 的消息          |
| 原生 Android App                              | 同原生 iOS App                                                          |

### 10.5 仓库检查

`pnpm check`、`pnpm format`、`pnpm check:public-boundary`（因为新增了依赖）、`pnpm run docs check`。

## 11. 交付计划

整个改动作为一个 PR 合入。开发时可以拆成栈式 PR，但要一起合入，保证 main 上任何时候都不会同时存在两套 composer 实现。步骤：

1. 录黄金样本和基准截图（10.1、7.3）。
2. 在 Storybook 里做出编辑器组件、序列化函数，并跑节点类型的判定测试（8.2）。
3. 替换组件内部实现，迁移所有调用方（第 9 节），删除旧代码（D7）。
4. 重写测试和文档（第 9 节、10.2、10.3）。
5. 真机验收（10.4），由非作者复审后合入。

## 12. 风险

| 风险                                          | 缓解                                                    |
| --------------------------------------------- | ------------------------------------------------------- |
| Android Gboard 在不可编辑的行内元素旁组字出错 | 8.2 的判定测试、token 文本备选方案、真机验收            |
| WebKit 下 chip 位于行首或行尾时光标异常       | 判定测试，以及 WebKit 的 Playwright 测试                |
| 编辑器和字符串模型之间的偏移量对不上          | 只用一套纯函数序列化，加性质测试和黄金样本              |
| 调用方迁移量大                                | 由类型检查强制迁移（D5），一个 PR 跑全量检查            |
| 包体积                                        | Lexical 核心加 React 绑定体积不大；在 PR 里报告体积变化 |

## 13. Owner 决定（2026-11-10）

- 换成稳定的编辑器框架，可以用 Lexical；不再打补丁，滚动条宽度补丁不合入。
- 风险集中在网页 composer 覆盖的平台：桌面端，以及 Android（Android 实际跑的就是这个网页 composer），另外还有 iOS 的网页壳。仓库内的原生客户端不改代码，只保证兼容。
- 交互和样式必须与现在一致或更好。
- 当天稍后 owner 收紧了要求：用户要对这次改动完全无感知，所以不做任何视觉「改进」（V7）。随后 owner 让本 agent 亲自实现这份 PRD。
- 本文就是 PRD，由其他 agent 实现。

## 14. 考虑过的其他方案

- **保留显示层，逐个修不一致**：owner 否决，因为同类问题会一直存在。
- **直接用 ProseMirror**：能力相当。选 Lexical 是因为 iOS 已经在用 Lexical 模型，而且 owner 同意了。
- **Tiptap**：在 ProseMirror 上再加一层富文本抽象，这个纯文本 composer 用不上。
- **做一个兼容 textarea 的 ref 外壳**：这是隐藏的兜底方案，否决。

## Evidence

- **现有组件**：`packages/components/src/ui/mention/`（`mention-input.tsx`、`mention-highlighter.tsx`、`mention-root.tsx`、`mention-input-core.ts`）。
- **Composer**：`packages/components/src/components/mentions/combined-mention-textarea.tsx`、`mention-chips.tsx`、`packages/components/src/components/chat/chat-composer.tsx`。
- **消息格式**：`packages/shared/src/message-schemas.ts`、`message-text-spans.ts`、`message-quote.ts`。
- **原生客户端**：
  - iOS：`apps/mobile/ios/packages/LodyKit`（`ChatComposerView`、`ChatReferenceNode`），以及 `apps/mobile/ios/docs/superpowers/specs/2026-09-29-lexical-swift-composer-design.md`；
  - Android：`apps/mobile/android`（`chat/ChatScreen.kt`、`chat/MentionPresentation.kt`）。
- **复现**：按 1.2 节所述测得。补丁被 owner 否决，没有提交。
