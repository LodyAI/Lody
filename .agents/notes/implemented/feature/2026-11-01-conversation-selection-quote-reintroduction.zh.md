# 会话选区引用：撤回经过与重新引入

Status: implemented
Translation: current
PR: [#2191](https://github.com/LodyAI/Lody/pull/2191)

[English](2026-11-01-conversation-selection-quote-reintroduction.md)

## 摘要

会话文字引用于 2026 年 10 月 23 日通过 #1801 合入，次日因选区/滚动抖动反馈和交互问题被撤回。旧实现复用的粘贴文本路径已能在 Lody 历史中保留显示范围，但没有标识被引用的来源消息。新的实现把只读快照作为输入框中的原子 inline 单元，并统一投影为普通 ACP 文本交给各 Agent。专用显示 span 负责 Lody 历史与受支持编辑入口中的恢复，机器兼容性通过显式能力协商处理。七条 Agent 路径已有源码证据；完整 Agent 目录仍需按版本验收运行时，报告中的抖动也尚未复现。

## 证据与时间线

以下日期使用 Asia/Shanghai。本记录仅使用公开 Issue、PR 讨论和源码，不包含捕获的对话或用户数据。

| 日期              | 证据与意义                                                                                                                                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9 月 20 日        | [#830](https://github.com/LodyAI/Lody/pull/830) 建立原生会话选区保留能力。[所属笔记](../../implemented/bug-fix/2026-09-20-conversation-text-selection.zh.md)解释选区行走廊、历史租约和正文/折叠保持，解决的是连续选择和复制，没有批注入口。                               |
| 10 月 18 日       | [#1649](https://github.com/LodyAI/Lody/pull/1649) 合入文档选区反馈与图片批注，后续会话引用复用了其输入框暂存路径。                                                                                                                                                        |
| 10 月 21—22 日    | [#1781](https://github.com/LodyAI/Lody/issues/1781) 提出选择段落、填写可选批注、累计多段后一起发送。Issue 建议精细指针使用选区旁编辑器，窄屏/粗指针使用输入框操作条打开底部面板。22 日提交的 [#1801](https://github.com/LodyAI/Lody/pull/1801) 实际统一使用输入框操作条。 |
| 10 月 23 日 13:49 | #1801 以 [24f09670d](https://github.com/LodyAI/Lody/commit/24f09670d80ee6d1665089816bd9cb6daf1f5d85) 合入，并关闭 #1781。                                                                                                                                                 |
| 10 月 24 日 10:04 | [#1848](https://github.com/LodyAI/Lody/pull/1848) 以 [00849074b](https://github.com/LodyAI/Lody/commit/00849074b9e1933261c552ccb672665f83b5bd74) 合入，整体撤回功能、测试、story 和双语笔记。最初的 PR 正文只说明撤回哪个 PR。                                            |
| 10 月 26 日       | [原作者追问](https://github.com/LodyAI/Lody/pull/1848#issuecomment-6413120201)称 0.108.0/0.108.1 中找不到功能，询问撤回原因，并要求明确处理已关闭的 Issue。这是用户反馈，本次没有独立检查这些发行版二进制。                                                               |
| 10 月 28 日       | [维护者回复](https://github.com/LodyAI/Lody/pull/1848#issuecomment-6457419496)明确提到选中文字后向下滚动会抖动，且需要内部重新讨论交互设计，没有附诊断轨迹或具体根因。                                                                                                    |
| 11 月 1 日        | 公开 `main` 的 [aa0d011f5](https://github.com/LodyAI/Lody/tree/aa0d011f58ea50d8aa9f5497514e7b499a696b38) 中没有会话引用组件、辅助模块或输入框接口，#1781 仍关闭。限定范围的公开 PR 搜索未找到替代实现；搜索没有结果不能排除使用其他名称开展的工作。                       |

## 被撤回的功能实际做了什么

[捕获逻辑与操作条](https://github.com/LodyAI/Lody/blob/24f09670d80ee6d1665089816bd9cb6daf1f5d85/packages/components/src/components/ai-gui/selection-quote.tsx#L60-L190)监听文档选区变化。只有原生 Range 的共同祖先能找到所属会话行，且该行的 turn 存在于当前界面的 `ConversationView` 中，才接受文字。空选区和超过 50,000 字符的选区会被忽略。跨兄弟虚拟行的选区无法通过这项共同祖先查找；跨消息累计引用需要分次选择并接受。

选中文字后，主输入框上方显示预览、取消和“引用并评论”按钮。操作条没有每段引用独立的批注编辑器。接受后调用 `addSelectionQuote`，通过 [`insertLargePastedTextAtSelection`](https://github.com/LodyAI/Lody/blob/24f09670d80ee6d1665089816bd9cb6daf1f5d85/packages/components/src/components/sessions/session-chat-input-area.tsx#L1593-L1611) 和 `append: true` 暂存为粘贴文本 chip，标签使用截短的引文。同一草稿可以累计多个 chip，问题则是输入框中的普通文字。

[格式化模块](https://github.com/LodyAI/Lody/blob/24f09670d80ee6d1665089816bd9cb6daf1f5d85/packages/components/src/lib/conversation-selection-quote.ts#L7-L22)只携带 `{ text }`。以下是发送时展开的合成示例：

```text
Why is this step needed?

Message selection
Selected content:
> The renderer retains selected rows.
> It releases them when selection ends.
```

最终使用普通文本输入块，没有被引用消息 ID、来源范围、版本或单独绑定的批注。不过，用户正文旁会保留粘贴文本显示 spans，因此已发送历史仍能把引文折叠为通用粘贴文本 chip。事实更正：此前把“发给 Agent 的提示展开为文字”混同成了“Lody 中所有显示结构消失”。真正缺失的是聊天来源引用的语义与导航，并非通用 chip 的持久化能力。

[合入前的一次修复](https://github.com/LodyAI/Lody/commit/ea66701ba64b64f63b56494aee5ff8acf8cfe2ac)给 chip 标签补了方括号，避免图标槽位盖掉引文首尾字符。该修复已经包含在 #1801 中，不能把它当成导致撤回的未修复缺陷。

## 抖动：已确认事实与待验证机制

维护者反馈确认了抖动现象和重新讨论交互的需要。公开讨论没有确认另一项后端、持久化或发送失败问题。

源码给出两处具体调查方向：

1. [操作条的插入位置](https://github.com/LodyAI/Lody/blob/24f09670d80ee6d1665089816bd9cb6daf1f5d85/packages/components/src/components/sessions/session-chat-interface.tsx#L7079-L7099)与输入框同处普通布局流。条件挂载会增加有内边距的控件，窄屏还让预览独占一行，因此出现和消失会在用户选择文字时改变弹性会话视口的可用空间。这是符合现象的可疑触发点，没有被本次调研证明为根因，也不能据此断言存在振荡反馈环。
2. 为避免 pointerdown 与 click 之间丢失引文，捕获状态会保留到原生选区折叠之后。操作条外的 pointerdown 清除它，之后有效的 selectionchange 又能重新捕获。因此需要在真实浏览器中联合验证滚动条操作、原生拖选自动滚动与布局变化。本次源码检查不能证明反馈当时实际发生了哪种事件序列。

被撤回的[专项测试](https://github.com/LodyAI/Lody/blob/24f09670d80ee6d1665089816bd9cb6daf1f5d85/packages/components/tests/conversation-selection-quote.test.tsx)使用 jsdom，覆盖格式、界面归属、粘滞捕获、关闭和交接；输入框测试覆盖 chip 展开与发送拒绝。这些测试不测视口几何，也不执行原生拖选自动滚动。#1801 声明验证过 Chromium 交互和真实 agent 链路，但没有提供该功能的自动滚动验收用例，且明确未验证 iOS/Safari 时序。

## 设备 Codex 实现对照

11 月 1 日只读检查了 `/Applications/ChatGPT.app/Contents/Resources/app.asar`，应用标识为 `com.openai.codex`，版本为 `26.1021.31345`。只检查安装包中的实现，提取的第三方文件保留在临时目录，没有把第三方源码、应用记录或捕获的对话加入仓库。原始 `composer-content-75731baf379a.js` 的 SHA-256 为 `827127a23cef7a9043815453ad52eecc5095c3b32155d07b651fcab2254745b6`。

相关模块位于安装包的 `webview/assets/`：

| 模块                                                    | 观察到的职责                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `overlay-56db5fb6ebc3.js`                               | 原生选区归属、克隆范围/文字、指针生命周期、可见边界与通过 portal 定位的工具条。 |
| `composer-thread-reference-drop-target-3af03ff5f4a8.js` | 将 Work/Codex 工具条动作接到回答批注创建，是否开放取决于当前界面和后端。        |
| `annotation-editor-77a8f76bc999.js`                     | 可选的富文本评论编辑器、暂存/直接发送模式、草稿保留与关闭处理。                 |
| `composer-content-75731baf379a.js`                      | 来源标记、锚定批注编辑器、输入框附件摘要、编辑/删除/导航和提交交接。            |
| `app-initial-feb30b196d11.js`                           | 批注/来源构造、草稿数组、提示格式化、载荷 schema 验证与历史恢复。               |
| `subagent-activity-chip-group-a0fc2223efe0.js`          | 已完成回答的批注目标，以及回答中的内联批注引用、预览与导航。                    |

### 捕获与布局

工具条在按住指针拖选时隐藏，在 pointerup/pointercancel 后重新计算。选区、滚动和尺寸更新通过 `requestAnimationFrame` 调度；选区两端需属于目标界面，且排除可编辑内容。工具条使用 fixed/absolute portal，根据可见选区矩形、裁剪边界、视口限制和会话 footer 下边界定位，不在会话普通弹性布局中插入额外工具条。

回答批注构造器捕获选中文字；能够映射到回答 Markdown 目标时，来源包含 `messageId`、`startOffset`、`endOffset`。另有 DOM 锚点，记录 selector、文字偏移和范围文字，服务于本地定位。创建草稿时分配 ID，追加到 `responseTextAnnotations`；可选评论单独保存在 `annotation`，而非混在无关的主输入框正文中。这些锚点是捕获时的位置，不能据此推断可在任意消息编辑后继续正确定位。

评论编辑器和来源编号标记都位于 fixed portal 层。原生选区清除后，用 CSS Custom Highlight 保留范围高亮，不额外包裹消息文字节点改变布局。编辑器结合选区几何、滚动/尺寸观察、fixed 浮动定位和碰撞处理。评论既可以暂存到下一次输入框发送，也可以直接提交；直接发送被接受时，只清除仍与捕获状态一致的那条批注。检查到的渲染路径明确把已完成、非 commentary 的回答标记为可交互目标。

### 结构化 UI 与文本传输互相独立

检查到的 Work 回答批注路径，在输入框中呈现附件摘要，包含编号选区、原文、可选评论，以及编辑/删除/来源导航回调。这些记录与问题正文分别存储。它证明存在结构化上下文单元，**不能据此称为在富文本任意光标位置插入了批注 atom**，也不能把 CSS `display: inline-block` 当成功能的数据模型。

安装包还存在独立的 `selectedTextAttachments` 路径，服务于简单文字片段和其他来源，其通用界面可用选区数量 pill 聚合多个片段。本次检查的 Work 工具条回调创建的是 `responseTextAnnotations`，两条路径不能混成同一种引用实现。

在 agent 边界，回答批注投影为 `{ text, annotation, source }`，编码为 JSON，放在回答批注标题下的 `<response-annotations>` 分隔标记中；本地草稿 ID 和 DOM 定位锚点不进入这项投影。外围格式化逻辑要求 assistant 按从 1 开始的批注索引关联回答。这是具有明确可恢复格式的文本传输，不是把 Markdown 引用文字直接粘进用户问题。

历史读取器通过 schema 解析该 JSON，恢复 `responseAnnotations` 并带入渲染记录。回答中的 `:codex-annotation{index="1"}` 指令会渲染为内联引用，带选区/评论预览及可选来源导航。因此，检查到的实现能在提交和展示之间保留可识别的引用/评论单元，同时仍让模型输入使用文字，不要求专用二进制或非文本输入块。带分隔标记的文本格式本身仍是持久化契约，Lody 若采用，需要一起处理验证、历史重放和渲染。

已读取的[官方远程工作文章](https://developers.openai.com/blog/mastering-codex-remote-for-engineering)确认支持选中会话文字后开启旁聊，但没有说明上述实现细节；这些结论来自固定版本的设备安装包。原生界面自动化拒绝访问 Codex 自身，因此没有实时点击、截图或浏览器验收结果。源码及能力分支存在，也不能证明所有账号或模式都开放了对应控件。

## 聊天引用的完整链路与跨 Agent 兼容

本节只讨论：从已有聊天消息选中原文，在当前输入框中形成 inline 引用块，接着写问题，再交给选中的 Agent。其他引用功能不能作为这项交互已实现的证据。源码检查固定到公开 Lody `aa0d011f58ea50d8aa9f5497514e7b499a696b38`、仓库锁定的适配器和托管运行时清单中的来源提交。

### 已有的显示与历史基础

当前输入框有通用 `PastedTextDraft`，包含 `id`、完整 `text`、`displayText` 和占位文字的 `start`/`end`，其预览编辑器可以修改捕获文字。[`buildPastedTextRewrites`](https://github.com/LodyAI/Lody/blob/aa0d011f58ea50d8aa9f5497514e7b499a696b38/packages/components/src/lib/pasted-text-draft.ts#L232-L260)将占位文字替换为完整内容，同时生成 `pasted_text` span，保留展开后的范围、显示标签和草稿 ID；提交时正文和 spans 一起保存。

```mermaid
flowchart LR
    D[输入框占位文字与完整草稿] --> E[展开后的用户正文与显示范围]
    E --> H[Lody 历史正文与显示范围]
    H --> B[已发送消息中的可折叠 chip]
    E --> P[实际执行提示文字]
    P --> A[ACP 文本提示]
    A --> N[选中的 Agent 运行时]
```

[`inputBlocksToHistoryItems` 与 `historyItemsToInputBlocks`](https://github.com/LodyAI/Lody/blob/aa0d011f58ea50d8aa9f5497514e7b499a696b38/packages/shared/src/session-input.ts#L546-L622)保留并校验这些 spans；[`MessageTextWithChips`](https://github.com/LodyAI/Lody/blob/aa0d011f58ea50d8aa9f5497514e7b499a696b38/packages/components/src/components/mentions/message-text-chips.tsx#L174-L239)据此显示原 chip 标签，点击后展开全文。#1801 当时已有这条能力：执行时引用展开为文字，但用户历史仍可保留通用 chip 的显示元数据。此前“提交后所有块结构都会消失”的判断不准确。

这仍不等于专用聊天引用模型。[span 类型与字段](https://github.com/LodyAI/Lody/blob/aa0d011f58ea50d8aa9f5497514e7b499a696b38/packages/shared/src/message-text-spans.ts#L31-L72)没有会话引用 kind、来源消息身份或单独绑定的问题/批注，`target` 中的草稿 ID 也不是被引用的历史消息 ID。新增引用 kind 或元数据，需要同时修改清洗逻辑与严格的[输入 schema](https://github.com/LodyAI/Lody/blob/aa0d011f58ea50d8aa9f5497514e7b499a696b38/packages/shared/src/message-schemas.ts#L212-L239)，不能临时塞一个未声明字段。来源导航是可选的额外保证，不是快照引用的前提。

### 所有 Agent 之前的共同执行边界

[`resolveSessionExecutionInputBlocks`](https://github.com/LodyAI/Lody/blob/aa0d011f58ea50d8aa9f5497514e7b499a696b38/packages/shared/src/session-input.ts#L505-L523)使用实际执行的提示文字，用户原始正文与 spans 另供历史/编辑使用。CLI 的 [`buildAcpPromptBlocks`](https://github.com/LodyAI/Lody/blob/aa0d011f58ea50d8aa9f5497514e7b499a696b38/apps/cli/src/lib/message-handler.ts#L2438-L2537)读取文字，不读取显示 spans；[`AgentClient.prompt`](https://github.com/LodyAI/Lody/blob/aa0d011f58ea50d8aa9f5497514e7b499a696b38/apps/cli/src/agent/agent-client.ts#L2720-L2763)将 ACP 内容块交给选中的 Agent。如果引用只存在于显示元数据，模型不会得到相应上下文，原文必须进入执行序列化。

已检查以下 Provider 路径。这些是源码层面的传输观察，不是已经请求商业 Provider 成功的验收结果：

| Agent            | ACP 文本的实际处理                                                                                                                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Codex            | [`buildPromptItems`](https://github.com/LodyAI/acp-extension-codex/blob/304d594ee59d7ee69c1cd22d9b6b163b639329cf/src/CodexAcpClient.ts#L1618-L1647)映射为原生文本输入，`text_elements: []`。                                                                 |
| Claude           | [`promptToClaude`](https://github.com/LodyAI/acp-extension-claude/blob/3f9997d1f2a357136065ae30f8302fa9f0e7f6e4/src/acp-agent.ts#L11285-L11306)构造 SDK 用户文本块；MCP 斜杠命令改写是另外的分支。                                                           |
| Kimi             | [`acpBlocksToContentParts`](https://github.com/LodyAI/acp-extension-kimi/blob/743c6641b89870dbd0596d1726ae4d34d42844e2/packages/acp-server/src/convert.ts#L26-L32)将文字复制为原生用户内容块。这里使用 Lody 托管运行时清单指定的提交，而非不同的子模块指针。 |
| Pi               | [`promptContent`](https://github.com/LodyAI/acp-extension-pi/blob/918b3d61eca1dfac91668c3aaead9d6928fd4b7d/src/connection.ts#L809-L839)把文本块连接为原生 message；普通 prompt 和 steer 复用这一转换。                                                       |
| DeepSeek Harness | [`admitAcpPrompt`](https://github.com/LodyAI/acp-extension-dsh/blob/c5c384ce7e8403f5f0847d106e0082c009cb4c44/src/adapter.ts#L1061-L1089)将 ACP 文字合并为原生文本块。                                                                                        |
| Grok             | [包装层](https://github.com/LodyAI/acp-extension-grok/blob/2fc653bde0b1cc2570c9da308d4585526ed55591/src/proxy.js#L870-L879)原样转发 `session/prompt` 给运行时；没有检查运行时内部的模型请求。                                                                |
| Devin            | [包装层](https://github.com/LodyAI/acp-extension-devin/blob/15c12e1cbbe98f5ae78aed9701080340c544665e/src/proxy.ts#L241-L251)转发 prompt 消息给运行时；没有检查运行时内部的模型请求。                                                                         |

当前内置目录还包含 Bub 和 DimCode。在固定 main 的 `packages/shared/src/ai.ts` 与 `apps/cli/src/setting.ts` 中，Bub 使用用户设备的 `bub acp`，内置 DimCode 使用设备的 `dimcode acp`，都不是锁定的托管运行时产物。另一个 DimCode 注册表条目指定 `dimcode@0.5.12 acp`。注册表/自定义配置还可以选择其他 ACP 实现与版本。这些路径只有宿主边界证据，没有检查外部文字转换或完成运行时验收。

这些路径都没有把 Lody 输入框节点或显示 spans 作为原生引用传输。聊天引用的共同格式化应位于共享 ACP 边界之前，而非 Codex 适配器中。文字传输兼容，不能证明引用语义、模型理解或桌面批注 UI 兼容。

### 编辑与历史恢复的限制

当前[进入编辑的代码](https://github.com/LodyAI/Lody/blob/aa0d011f58ea50d8aa9f5497514e7b499a696b38/packages/components/src/components/ai-gui/view.tsx#L4163-L4171)取展开后的用户全文，[编辑器](https://github.com/LodyAI/Lody/blob/aa0d011f58ea50d8aa9f5497514e7b499a696b38/packages/components/src/components/ai-gui/user-message-editor.tsx#L107-L116)从当前 mention 范围重新计算 spans，没有接收原来的粘贴草稿。因此，原文在这个入口中保留，但“编辑重发后仍是引用块”不是已有保证。会话的编辑重发入口目前还受支持的内置 Codex/Claude 与可用 fork 边界限制，并非所有 Agent 都开放。

[兜底历史重放](https://github.com/LodyAI/Lody/blob/aa0d011f58ea50d8aa9f5497514e7b499a696b38/packages/shared/src/replay-prompt-builder.ts#L169-L174)读取 `item.text`，并受重放字数预算约束，不读取显示 spans。如果引用只保存在来源 ID 或 span 中，就需要显式补充重放行为。从 Provider 原生历史导入、没有 Lody spans 的消息，也不能假定能恢复自定义引用 chip。原生 resume 与 Lody 的兜底重放是两条路径，是否包含引用原文不能依赖当前由哪个 Agent 接收。

据此可以明确工作边界：适当复用通用 chip 的落位、正文展开与历史显示，再定义聊天引用快照/序列化，以及编辑/恢复行为。这些证据不能证明只改工具条或只改 Codex 请求就完成了功能。

## 实验实现

实验基于公开 main `dddbe5873444941f60623569931d2ba9413ba3e8`（10 月 30 日），与较旧且有修改的主工作区隔离。前面的传输调研仍固定到明确引用的 11 月 1 日源码；本次没有修改适配器源码或版本。[契约草案](../../../../specs/conversation-message-quotes.zh.md)记录建议的持久性/兼容性保证，仍未批准。

`MessageQuoteAction` 在松开指针后捕获一段连续渲染正文/代码并克隆原生 range。portal 不进入会话布局；拖选时隐藏，滚动/缩放时重新定位，生命周期由所属界面与可见性控制。跨区域选区会说明可以分次添加摘录。超过 50,000 个 UTF-16 单元时明确拒绝，不截断。快照反映渲染后的原生选文，不是 Markdown 源码导出，也不调用剪贴板单独的 KaTeX 转换。

输入框在实际使用过的最后光标位置插入引用，尚无有效位置则追加。插入通过 mention 原语的共同 splice，让已有内部 mention 和外部原子一起移动。内部草稿标记区分只读聊天快照与可编辑粘贴文本，原语仍把两者视为外部持有的原子范围。引用有带底色的 inline 标签、完整只读预览与显式移除。只有出现引用后才启用有界的正文/范围撤销；输入法暂态和只读提交投影不进入历史，被删除的不可变快照仍供撤销使用。已有的用户消息编辑入口会恢复引用范围与快照，不扩大其他 Agent 的编辑能力。

传输/历史类型为 `message_quote`，包含 `quoteVersion: 1`、显示标签，`target` 保存引用 ID；继续使用已有文本输入块。边界保留在格式化引文内部，展开和恢复 inline 原子不会向相邻用户正文插入换行。v1 的精确表示为：

```text
<message-quote>
Quoted message (context):
> First source line
> Second source line
</message-quote>
```

只解码经过显式标记且合法的 v1 span，不猜测任意 Markdown；损坏/未知元数据保留可读的展开正文。同一冻结正文经过已有共享执行边界，包括受支持的队列/steer、重试和兜底重放，继续适用重放预算。不要求原生 Agent 引用对象或生成式批注指令。新增结构化输入要求目标机器声明 `messageQuotes` v1，包括编辑重发；缺少支持时保留草稿并说明需要升级，中央当前能力声明包含该版本。

含引用的草稿按带版本的工作区/会话 localStorage key 保存完整展开正文、spans 与经过位置映射的已提交 mention 身份，沿用已有输入框的设备本地存储模型。挂载时还原引用/粘贴原子、准确的行内间距与已提交 mention 身份，内存中的编辑优先。只读待提交投影不清空草稿范围，拒绝后会重新水合。被删除的快照载荷随编辑历史中的实际引用存活。存储失败时明确提示复制/发送，不谎称持久化成功。拒绝提交保留草稿，接受只清理没有被新编辑替换的提交代次。本次没有新增托管操作、附件、历史 writer 或来源消息跳转。

### 取舍与归属

原样恢复旧布局条会保留其 UX 与几何问题。沿用通用粘贴文本的传输身份不能区分只读引用快照，也缺少经过验证的还原。只发消息 ID 会依赖 Provider 历史和重放上下文，快照则自带完整内容。照搬 Codex 批注模型会引入本功能不需要的独立批注流程和模型输出契约。

已有原生选区保留决策继续有效，仍负责行区间、历史加载租约与呈现冻结；通用粘贴文本仍可编辑，并保留原阈值。本次复用这些边界，没有取代相关决策，其所属文档保留原事实。

## 验证与限制

- `session-chat-input-submission.test.tsx` 使用真实会话输入区验证光标落位、原子删除/撤销/重做、拒绝提交、机器缺少支持及持久化引用输入恢复；`message-copy.test.ts` 覆盖受支持编辑入口的重建；`pasted-text-draft.test.ts` 覆盖有序快照、Unicode/代码/空行、重复存储往返与损坏元数据；`path-mention-insert.test.tsx` 验证外部原子插入后原有 mention 的范围。
- 共享 `history-writer.test.ts` 的引用用例跨真实 SessionMirror/HistoryWriter 与快照导出/导入边界，再检查执行正文和无效显示元数据，验证的是实际持久化，而非 mock 回调观察。
- `tests/e2e/message-quotes.spec.ts` 在合成 Storybook 场景中使用生产选区、输入框、消息流和气泡组件。Chromium 测试测量原生选文前后视口几何/位置，验证引用与问题交错、应用主题下不透明的引用遮盖层、只读预览、移除、撤销/重做及窄屏拒绝后保留草稿。场景中的控制器不等于运行中的桌面 daemon 或商业模型请求。
- 七条 Agent 路径的源码转换证据见前文，Bub/DimCode、注册表/自定义路径仍需按具体安装版本验证运行时。没有宣称全部 Agent 的真实请求、触屏/Safari 真机、桌面发行版、Issue 修改、PR 或人类设计批准已经完成。没有 Lody spans 的原生导入历史保持展开文字；v1 提供快照预览，不提供稳定的来源消息导航。
