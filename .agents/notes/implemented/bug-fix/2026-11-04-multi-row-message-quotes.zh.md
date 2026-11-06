# 跨回复行引用连续文本

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/2304

[English](2026-11-04-multi-row-message-quotes.md)

## 摘要

同一条回复的文本条目可能渲染在不同虚拟行中，仅比较选区两端的文本容器会错误拒绝连续选择。两端属于同一轮、且中间每一行都已挂载并包含可引用文本时，引用操作接受该选区，并从选中的渲染内容重建 Markdown 快照，让支持的格式在预览和发送给 Agent 时保留。跨轮或不完整的区间仍需分开选择，以免保存具有误导性的局部快照。

## 决策与限制

原有的[引用实现](../feature/2026-11-01-conversation-selection-quote-reintroduction.zh.md)将不同文本容器一律视为不同段落。检查相同的轮次标识和完整虚拟行区间，可以支持跨回复条目的普通连续选择，同时不把未挂载、加载中、工具或其他行假定为正文。选区保持机制仍负责加载和挂载行；引用操作在接受时再次检查区间。本次不增加来源导航，也不改变引用序列化。浏览器测试在 Storybook 中使用实际会话渲染器和输入组件；尚未验证实体触摸设备或 Safari。

## 后续调研：选区格式

本次修复的第一版使用 `Selection.toString()` 保存选区，因此引用包含渲染后的文字，而不是原始 Markdown。在一个包含加粗文字、超链接、列表、代码块和表格的合成 Chromium 选区中，返回的纯文本没有加粗标记、链接目标、列表符号和代码围栏；表格使用制表符与换行。这只是小型合成 DOM 的浏览器实验，并非对 Lody Markdown 渲染器、选区复制、公式或其他浏览器的完整测试。Lody 单独的公式剪贴板处理不会被引用操作调用。

[VS Code 的回复选区解析器](https://github.com/microsoft/vscode/blob/e576c7bbeb39772a1d1ebe472545def0d93e6d8b/src/vs/workbench/contrib/chat/browser/responseSelectionResolver.ts)同样获取 `Selection.toString().trimEnd()`；其[引用操作](https://github.com/microsoft/vscode/blob/e576c7bbeb39772a1d1ebe472545def0d93e6d8b/src/vs/workbench/contrib/chat/browser/responseSelectionSideChatController.ts)再将文字包装为 Markdown 引用块。这里检查的是该操作的源码，不能代表 VS Code 单独的“复制为 Markdown”功能。11 月 4 日只读检查本机 ChatGPT/Codex 桌面版 26.1027.61615 的打包文件 `overlay-40c64ef1bda5.js` 和 `app-initial-18b189e867e7.js`，发现选区转文本会特殊处理公式和表格文本，并有普通 Range 文本回退；这种文本遍历不能证明它重建原始 Markdown，也没有进行实际应用交互验证。[GitHub 文档](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax#quoting-text)介绍了选中文字引用和整条评论引用，但未说明其格式保真度。

GitHub 单独开源的 [`quote-selection` 实现](https://github.com/github/quote-selection/blob/f3934361ed0d35b4aaf85b81aa942fce27d223a7/src/index.ts)提供 `MarkdownQuote`，克隆所选 DOM 并插入 Markdown 语法；基础的 `Quote` 则读取选区纯文本。这证明了一个可参考的实现方式，并不能证明 GitHub 当前部署了哪个版本或所有部分选区都能完全还原。Codex CLI 的[选区复制实现](https://github.com/openai/codex/blob/a33fb9751c1e468b0062aae63e8f06e9d75e2376/codex-rs/tui/src/markdown_copy.rs)在渲染时保留语义标记，复制选区时重新生成配对完整的 Markdown。源码明确区分了这种方式与通过 `/copy` 获取完整回复原始源码写法。这个剪贴板功能不能证明桌面引用发送了什么。

后续实现将所选 DOM 转换为 Markdown，保留部分选中的祖先格式，并将支持的链接、列表、表格、代码和公式转换为一个快照。它重建语义而非切取原始 Markdown：分隔符选择、空白、不支持的控件及部分表格结构可能不同。转换器排除界面控件，并将部分公式选区扩展为完整公式；转换失败会提示，而不会悄悄发送纯文本。现有 v1 引用快照和序列化保持兼容。行为测试覆盖转换与会话输入，浏览器测试使用实际渲染器；实际 Agent 请求以及 Safari／触摸设备尚未验证。

DOM 与 Markdown 转换器通过限定依赖范围的 override 共用 `@types/hast` 3.0.5。原锁定的 3.0.5/3.0.4 组合在转换边界上的扩展节点类型不兼容，会同时阻断组件和 Electron 编译。验证使用冻结锁文件安装，因为已有安装可能恰好让两个包共用同一类型版本，而提交的锁文件仍将它们分开。
