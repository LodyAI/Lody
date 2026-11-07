# Lexical Swift 编辑器 + 富文本 Composer

日期：2026-09-29

## 目标

1. 把 Lody composer 换成 Lexical 模型的富文本编辑器。输出 Markdown，节点可以扩展。
2. 同一套 Swift 实现以后要接入 haklex（`@haklex/rich-headless`，Lexical 0.49）。JSON 必须和它兼容，haklex 文档在 iOS 上来回一次不能丢数据。
3. 先放在 lody-ios 仓库里（`packages/lexical-swift`），稳定后再拆成独立仓库。

## 前置验证（spike，2026-09-29）

`/tmp/LexicalTK2` 验证了以下几点：lexical-ios 的 TextKit 1 耦合只集中在约 5 个文件；换成 TextKit 2 只改了 11 个文件（+231/−25）；全程 `textLayoutManager != nil`；真实拼音输入法、格式、列表、decorator 和 Markdown 导出都和 TK1 基线一致，渲染只差约 1pt 行高。

spike 还发现一个上游 bug：`decoratorPositionCache` 只在 decorator 新增时写入，之后在它前面编辑，缓存的位置就过期了。定位 decorator 必须改用 `editor.rangeCache[key]`。

## 范围

M1 包含：

- 包本身；
- haklex 契约测试；
- T0 节点；其余 haklex 节点先做成原样透传的占位；
- 聊天、新建会话、Share Extension 三处 composer 同时替换。

不在 M1：

- Markdown 导入。原因：haklex 以 JSON 为准，它的 27 个 transformer 的 `replace` 都是 NOOP；Lody 的原生草稿直接存 editor state。
- HTML 导入导出、Table 节点、只读视图、LiteXML。
- T1/T2 节点的原生渲染。
- 格式工具栏。

## 包结构：`packages/lexical-swift`

通过 `plugins/withMarkdownView.js` 的 `spm_pkg :path` 接入 Podfile，方式和 `packages/chat-kit` 一样。LodyKit podspec 用 `spm_dependency` 引用。这个包只放原生库代码，不包含 RN bridge。

| Product           | 内容                                                                                                                                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Lexical`         | 基于 lexical-ios fork，包括 core、TK2 frontend、List、Link + AutoLink、History、`TypeaheadPlugin`、`MarkdownShortcutPlugin`。删掉 ReadOnly（TK1）、HTML（SwiftSoup）、Table、InlineImage、Mentions                                             |
| `LexicalMarkdown` | 重写成按节点注册 transformer 的字符串导出器，语义同 Web 的 `$convertToMarkdownString`。去掉 swift-markdown 依赖（原来锁的是 `branch: main`）。提供两个 preset，见下文                                                                          |
| `HaklexNodes`     | haklex 的 T0 节点：heading、quote、list、link/autolink、code + code-highlight（包括 haklex 自定义的 code block 节点）、horizontal rule、mention（`{platform@handle}`）。其余约 30 种 haklex 类型用占位节点。另外包含 haklex 的 Markdown preset |

fork 后的源码保留上游 MIT LICENSE。`NOTICE` 里记录上游 commit。fork 的 target 使用 Swift 5 语言模式，新写的 target 使用 Swift 6。

### JSON 对齐 Lexical 0.49

- TextNode `format` 支持 0–10 位（包括 highlight、lowercase、uppercase、capitalize）。其中 8–10 位只保留在 JSON 里，渲染时不做大小写转换，因为 TK2 没有替换 glyph 的钩子。
- ElementNode 输出 `format`（对齐方式字符串）、`textFormat`、`textStyle`，不再写死 `""`。
- 所有节点都原样保留 NodeState 的 `$` 字段。haklex 的 `BlockIdPlugin` 用它存 `blockId`。
- 新增 `TabNode`、`HorizontalRuleNode`、`AutoLinkNode`，ListItem 支持 `checked`。
- 未知类型的节点：把 JSON 原样存下来，导出时原样写回。编辑器里显示为一个不可编辑的块级占位，标注节点类型。

### TK2 frontend

实现方式沿用 spike：

- `NSTextContentStorage` 包着原来的 `TextStorage`。
- 块级自定义绘制放在 `NSTextLayoutFragment`。
- `CustomDrawingHandler` 的第三个参数改成 `NSTextStorage`。
- decorator 在 `layoutSubviews` 里定位，并且 editor 每次 update 后都标记需要重新布局。

硬性约束：包内任何代码都不能访问 `UITextView.layoutManager`，访问一次就会永久退回 TK1。

`TextView` 去掉 `final`，把 `UITextViewDelegate` 的回调转发给外部 delegate。Lexical 自己占用了 `delegate` 属性。

### TypeaheadPlugin

移植 Web 的 `LexicalTypeaheadMenuPlugin` 和 `useBasicTypeaheadTriggerMatch`：

- 可以插入自定义 `triggerFn`，返回 `leadOffset`、`matchingString`、`replaceableString`；
- 事件有 open、query 变化、close；
- 选中候选项后回调 `replaceMatch(with: [Node])`。

插件本身不带 UI，菜单由宿主提供。

用法：

- Lody：`@`、`$`、`/` 三个 trigger。其中 `/` 只在文档开头生效，和现在的正则一致。菜单用 `ChatMentionPanel`。
- haklex 以后的 slash（插入块）和 mention（两步：先选 `@platform:`，再选 handle）也用这一层。

### Markdown 导出 preset

- `gfm`（Lody 用）：文本节点**原样输出，不转义**。用户输入的 `**` 等字符原样发出去，和现在一致。格式节点才加上对应语法。
- `haklex`：输出要和 `allHeadlessTransformers` + `$toMarkdown` 逐字节一致。语法举例：`||spoiler||`、`[name]{platform@handle}`。

## Lody 接入

### 输入框

`ChatComposerInput` 改为继承 Lexical 的 `TextView`。它在 `ChatComposerView` 里，三处宿主共用这一个文件。现有的粘贴拦截（附件、长文本转成文件）保留。普通粘贴仍然作为纯文本插入。

原来散落各处的约 25 处 `input.text` 调用，改成下面这组显式 API：

| API                                | 用途                                        |
| ---------------------------------- | ------------------------------------------- |
| `markdown`                         | 发送正文、排队项（`gfm` preset）            |
| `isBlank`                          | placeholder、发送按钮状态、stop 前判空      |
| `setPlainText` / `appendPlainText` | 快捷回复、Share 预填、RN 传来的文本、旧草稿 |
| `editorState` 读写                 | `pendingDraft`、`failedDraft`、内存中恢复   |
| `serializedJSON`                   | 写入 LocalStore                             |

这些调用不改，仍然作用在底层存储的字符和原生选区上：`ChatMentionPanel` 的定位、`selectedRange`、高度测量、`ChatSendHandoff` 的截图。

### Reference chip

新增 `LodyReferenceNode`（放在 LodyKit），是一个 inline decorator，显示为原生 chip。导出时生成的 token 和现在逐字相同，包括 `@path`、`$skill`、`/cmd`、`#number`、`@session:id`、`@role:id`。

这是对 `docs/mentions-design.md` 里"不引入第二套 range/chip 模型"这一决定的**有意调整**。那条决定要防的问题仍然有保障，理由有三：

- chip 是同一个编辑器模型里的节点，不是和文本并行的第二套模型；
- chip 导出的仍然是带命名空间的 token；
- 发送前在 runtime 里展开 token 的逻辑、以及展开失败时保留草稿的规则，都不变。

### 草稿与数据流

- LocalStore 里的草稿改为 envelope：`{"v":1,"lexical":<EditorState JSON>}`。读取时如果不是 envelope，就当作旧的纯文本草稿，用 `setPlainText` 填入。
- 编码计划要逐个列出所有原生草稿载体：聊天、新建会话、`ShareStore`。
- 发送给 RN、排队、Share inbox 的内容仍然是 Markdown 字符串，RN 侧不用改。
- RN 回传的 pending send 只有文本。所以在一次发送完成之前，原生侧用 `[sendID: EditorState]` 保存发出时的 editor state。`setPendingSend` 或 `restoreDraft` 时，如果 id 能对上，就恢复这份 state（格式和 chip 都在）；对不上就退回纯文本。

### 格式输入

只支持 Markdown 快捷输入，语义同 Web 的 `MarkdownShortcutPlugin`。T0 包括：`**x**`、`*x*`、`` `x` ``、`~~x~~`、`- `、`1. `、`> `、` ``` `。

不加工具栏。composer 空间很紧凑，加工具栏也和 HIG 冲突。

### Share Extension

在 `plugins/share-extension.rb` 里，把这个包的 product 作为 `LodyShare` target 的链接依赖。这里风险最高，计划里放在最前面单独验证。扩展里仍然不跑 WebView，不联网，不读 Keychain。

## 测试与验收

### 包级

通过 `xcodebuild test` 在模拟器上跑，接入 `verify:native --case lexical-swift`。

| 测试                 | 断言                                                                                                                                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| haklex 契约          | `fixtures/generate.mjs` 从 npm 拉固定版本的 `@haklex/rich-headless`，生成 fixture 后提交进仓库。每个 fixture 做一次 JSON 来回，结果要和原始 JSON deep-equal（包括 `$` 和占位节点）；`haklex` preset 的输出要和 `$toMarkdown` 逐字节一致 |
| gfm preset           | T0 表驱动；纯文本不转义                                                                                                                                                                                                                 |
| 不退回 TK1           | 经过 marked text、插入 decorator、粘贴之后，`textLayoutManager != nil`                                                                                                                                                                  |
| decorator 定位       | 在 decorator 前面插入文字后，它的 frame 跟着移动（覆盖上游 bug 的回归）                                                                                                                                                                 |
| Typeahead / 快捷输入 | 表驱动；trigger 用例对照 Web 的 `useBasicTypeaheadTriggerMatch` 测试                                                                                                                                                                    |

### Lody 级

1. 改动前，先从当前 build 采集 `verify:ui --case create-parity`；改动后用 `parity-diff.py` 对比，空 composer 的外观不能变。
2. 复用并按需扩展以下用例：`composer`、`mentions`、`mentions-production`、`user-mentions`、`paste-plain`、`quick-replies`、`send`、`send-handoff`、`send-queue`、`edit-message`、`outbox`、`share-probe`。
3. 新增 `composer-rich` 用例，覆盖：
   - 快捷输入和 chip 的显示，以及发送出去的 Markdown 正文；
   - 重启后恢复 envelope 草稿和旧纯文本草稿；
   - 上传失败后，草稿连同格式和 chip 一起恢复。
4. 跑 `pnpm check`、`pnpm bundle`，并做一次模拟器构建。

真实拼音键盘没法自动化，因为 verify:ui 只跑英文。这部分由包级的 marked text 程序化测试覆盖，再加一次在 spike 模拟器上的手动确认。

## 风险

| 风险                                         | 应对                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `LodyShare` 链接 SPM product 失败            | 第一步单独验证；失败就退回按源码引用编译                                                          |
| 某个 UIKit 私有路径触发退回 TK1              | 在 DEBUG 下断言 `textLayoutManager != nil`，并加包级测试                                          |
| upstream fork 维护负担                       | 只 fork 用得到的模块，NOTICE 记录基线 commit；不追上游的 Web 新功能，只对齐 haklex 契约需要的部分 |
| Lexical 自己的粘贴处理和 Lody 的粘贴拦截冲突 | 保持 `ChatComposerInput` 覆写的方法优先，普通粘贴走 Lexical 的纯文本路径                          |
