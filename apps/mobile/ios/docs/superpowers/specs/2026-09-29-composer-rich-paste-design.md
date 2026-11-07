# Composer 富文本粘贴

日期：2026-09-29

## 目标

旧的粘贴逻辑是为纯文本输入框写的：除附件外一律只读纯文本。composer 换成 Lexical 富文本后，粘贴要保留来源的格式，输入框里看到的就是会发出去的 Markdown。

导入能力放在 `packages/lexical-swift`，行为对齐 Web 版 Lexical（`@lexical/html`、`@lexical/markdown`），haklex 以后直接复用。Lody 专属的策略（附件、长文本转文件、上限）留在 LodyKit。

## 已定的决策

| #    | 问题                           | 决定                                                                                                                                                         |
| ---- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1   | 粘贴后输入框里的格式           | 全部转成富文本；"粘贴为纯文本"是逃生口，原样插入                                                                                                             |
| Q2   | 纯文本什么时候按 Markdown 解析 | 只解析带 `net.daringfireball.markdown` 类型的内容（Lody 自己复制的消息、声明该类型的编辑器）；其他纯文本原样插入，代码和日志不会被改坏                       |
| Q3   | composer 表达不了的内容        | 降级成"发出去仍然正确的文字"：表格 → GFM 表格文本，HTML 里的图片 → alt 文本，`hr` → `---`，颜色字号丢弃。转换表按 preset 注册，haklex 注册全量节点后保留结构 |
| Q4   | 长粘贴和 32,000 上限           | 都按"这次粘贴导出的 Markdown 长度"计算；长的富文本或 Markdown 转成 `Text.md`，纯文本转成 `Text.txt`；toast 的撤销把节点插回                                  |
| 方案 | HTML 怎么变成节点              | 方案 2：移植 Web 的 DOM 导入（`$generateNodesFromDOM`），HTML 直接生成节点；Markdown 另走 `$convertFromMarkdownString`。两条路径和 Web 一一对应              |

放弃的方案：先把 HTML 转成 Markdown 再统一导入（多一次往返，转义有风险，Markdown 表达不了的格式会丢，和 haklex 的 `importDOM` 不对齐）；`NSAttributedString(html:)`（主线程跑 WebKit，标题、列表、表格结构丢失）。

## 现有行为的去留

| 现有行为                                                | 去留                                                              |
| ------------------------------------------------------- | ----------------------------------------------------------------- |
| 剪贴板上的文件、图片、视频转成附件；webarchive 不算附件 | 保留，仍然最先判断                                                |
| 超过 2000 字或 15 行转成 `Text.txt`，toast 可撤销       | 保留，改按 Markdown 长度判断，并区分 `Text.md` / `Text.txt`（Q4） |
| 其余一律读纯文本、`insertText`                          | 替换为本设计的导入管线                                            |
| 编辑菜单的"粘贴为纯文本"                                | 保留，只取纯文本、原样插入                                        |
| 32,000 上限按屏幕字符计算                               | 改按发送的 Markdown 长度计算（Q4）                                |
| Lexical 复制写入的 `x-lexical-nodes` 不当附件           | 保留（iOS 26 实际不保存这一项，见上一份 spec 的裁定）             |

## 组件

### 包内（`packages/lexical-swift`）

**`LexicalHTML`（新 product，对应 `@lexical/html`）**

- `DOMDocument`：用系统自带的 `libxml2` 模块（`import libxml2`，无新依赖）的 `htmlReadMemory` 解析，选项 `HTML_PARSE_RECOVER | HTML_PARSE_NONET | HTML_PARSE_NOERROR | HTML_PARSE_NOWARNING`，不开 `HTML_PARSE_HUGE`。只输出最小 DOM 树（标签、属性、子节点、文本），其他代码不接触 libxml2。
- `generateNodes(fromHTML:preset:)`：移植 `$generateNodesFromDOM`，必须在 `editor.update` 里调用。按标签查转换表；命中的生成节点，没命中的透传子节点；移植 `forChild`（`<b>` 让子文本加粗）；连续行内节点包进段落。
- 转换表用 preset，与 `MarkdownExporter` 的 preset 设计一致。和 Web 的差异：Web 是每个节点类的 `static importDOM()`，这里用集中的表，避免给 lexical-ios 已有的节点类逐个补协议，效果等价。
  - `HTMLImport.gfm`：`p`、`h1`–`h6`、`blockquote`、`pre`/`code`、`ul`/`ol`/`li`（含 checkbox）、`a`、`b`/`strong`、`i`/`em`、`s`/`del`、`u`、`mark`、`br`；代码识别照搬 `CodeNode.importDOM`（`pre`、带 monospace 字体和 `white-space: pre` 的 `div`、GitHub 代码表格）；兜底 `table` → 每行一个 `| a | b |` 段落，`img` → alt 文本，`hr` → `---`。
  - `HTMLImport.haklex`：M2 在 gfm 上加 haklex 节点的转换，替换兜底。

**`LexicalMarkdown` 加导入（对应 `$convertFromMarkdownString`）**

- 移植 `MarkdownImport.ts`。`MarkdownTransformer` 各 case 补上导入用的正则和 replace，导入导出共用同一套 preset（`gfm` / `haklex`）。

**`PasteboardReader` + `RichPastePlugin`（放在 `LexicalHTML`）**

- 依赖方向：`LexicalHTML` 依赖 `Lexical`、`LexicalMarkdown`、`LexicalListPlugin`、`LexicalLinkPlugin`；core 不反向依赖，所以读取流程不放 core。
- `PasteboardReader`：从 `NSItemProvider` 异步挑一种表示，优先级：Markdown 类型 → HTML → RTF → 纯文本。
- RTF 用 `NSAttributedString` 读入、导出成 HTML（导出不经过 WebKit），再走 HTML 路径。列表导出成 `<ul><li>` 需要实测确认；确认不了就只保留字体特征和链接。
- `RichPastePlugin`：注册 editor 的 `.paste` 命令，接管 `TextView` 的粘贴。haklex 装上这个插件就有富文本粘贴，不需要 Lody 的逻辑；Lody 在它之前插入自己的附件和长度策略。
- 插入统一用 `insertGeneratedNodes`（lexical-ios 已有，改为 public），对应 `$insertGeneratedNodes`。

### Lody（`ChatComposerInput` / `ChatComposerView`）

- 粘贴管线：附件 → 包内读取与试生成 → 按 Markdown 长度决定上限和转文件 → 插入节点。
- `ChatCell` 和 `LodyChatView+Scroll` 复制消息时，除纯文本外再写一份 `net.daringfireball.markdown`。

## 数据流

```
粘贴（⌘V / 编辑菜单 / UIPasteControl / 拖放）
  1. 附件检查（Lody）：有文件、图片、视频 → 转成附件，结束
  2. 挑表示（PasteboardReader，后台）：Markdown > HTML > RTF(→HTML) > 纯文本
  3. 试生成（headless editor，注册与 composer 相同的节点）
       HTML → DOM → generateNodes；Markdown → convertFromMarkdownString；纯文本 → 每行一段，不解析
       → [序列化节点] + 导出的 Markdown + 长度
  4. 策略（Lody，主线程）
       当前内容 + 新 Markdown 超过 32,000 → 不插入
       超过 2000 字或 15 行 → Text.md / Text.txt 附件，toast 撤销插回这批节点
  5. 插入（主线程，一个 editor.update）
       insertGeneratedNodes(反序列化节点, 当前选区)：替换选区，光标到末尾，一步撤销，通知 textViewDidChange
```

- 试生成放在 headless editor：必须先知道 Markdown 长度才能决定转不转文件；节点对象不能跨 editor 移动，所以序列化后再插入，这份序列化结果也给 toast 撤销用。
- "粘贴为纯文本"跳过第 2、3 步，仍然经过第 4 步。
- 选区在代码块或行内代码里：只插纯文本，不解析（同 Web 版 Lexical）。
- 正在输入法组字：先提交 marked text，再粘贴。
- Share Extension 走同一条管线，不联网。

## 错误处理与安全

- 降级：当前表示读取、解析或生成失败，按 Markdown → HTML → RTF → 纯文本降一级；纯文本一定成功。剪贴板没有文字时交给 UIKit 默认处理。插入时抛错，整个 update 作废，输入框保持粘贴前的状态。用户看不到报错。
- 上限：HTML 超过 2 MB 不解析，直接用纯文本；嵌套深度用 libxml2 默认的 256 层；DOM 遍历用显式栈；生成节点超过 5000 个退回纯文本。
- 联网：`NONET`，不加载外部实体和 DTD；图片永不下载。
- 整棵丢弃：`script`、`style`、`head`、`title`、`iframe`、`object`、`embed`、`template`、`noscript`、注释。
- 链接只放行 `http`、`https`、`mailto`；其他 scheme 只留文字。
- 属性只读 `href`、`alt`、`start`、`checked`，以及 inline style 的 `font-weight`、`font-style`、`text-decoration`、`font-family`、`white-space`。
- 来源怪癖（照搬 Web 版）：Google Docs 的 `<b style="font-weight:normal">` 不加粗；`pre` 外按 HTML 规则合并空白，`&nbsp;` 转普通空格；实体和编码由 libxml2 解码，默认 UTF-8；Word / 备忘录的无规则 `span` 透传子节点。
- 线程风险：lexical-ios 的活动 editor 是全局状态，可能不区分线程。实现第一步用测试确认后台 headless editor 与主 editor 并发是否安全；确认之前只把 libxml2 解析和 DOM 构建放后台，生成节点和测长在主线程。

## 测试

**包内**

- Web 对齐：`Fixtures/generate.mjs` 在 Node 里用 `@lexical/headless` + jsdom 对同一批 HTML 跑 `$generateNodesFromDOM`，对 Markdown 跑 `$convertFromMarkdownString`，生成期望 JSON；Swift 结果逐项比较，只允许 Q3 兜底产生的差异，并在测试里逐条列出。
- 真实来源 fixtures：从 Mac 剪贴板导出原始 `public.html` / `public.rtf`——Safari 和 Chrome 的文档类网页（标题、列表、代码、表格、链接）、备忘录、Pages 或 Word、VS Code、Xcode、GitHub 代码视图、Google Docs。Google Docs 和 Word 先按公开结构造 fixture，之后由用户补真实导出。
- 往返：gfm 能表达的内容，Markdown → 导入 → 导出等于原文。
- 安全与上限：`script`/`style` 被丢弃；`javascript:` 链接只剩文字；NONET 下外部实体不加载；2 MB、5000 节点退回纯文本；256 层嵌套不崩；每一级失败都降级。
- 线程：后台 headless editor 与主 editor 并发更新互不干扰；不通过就用主线程方案。

**Lody 原生检查（`verification/composer`）**

测试进程读不了系统剪贴板，用构造的 `NSItemProvider` 调 `paste(itemProviders:)`。覆盖：表示优先级；附件优先；按 Markdown 长度转文件（`Text.md` / `Text.txt`）；toast 撤销插回节点；32,000 按 Markdown 长度；代码块内只插纯文本；"粘贴为纯文本"原样插入；一次粘贴一步撤销；Lody 复制消息写入 Markdown 类型。

**UI（`verify:ui`，浅色和深色）**

- 用 driver 里写附件剪贴板的 helper（`file-pasteboard.swift` 的方式）写入 HTML；`simctl pbcopy` 只能写纯文本，不用。
- chat、新建会话、Share Extension 各一次：写 HTML → ⌘V → 截图确认粗体、列表、代码块渲染 → 发送并检查 Markdown 正文。
- chat 里复制一条带格式的消息，粘贴到输入框，确认是渲染后的格式。

## 不在范围内

- composer 新增表格或图片节点（Q3 选了降级）。
- haklex 节点的 HTML 转换（M2 的 `HTMLImport.haklex`）。
- 修复 lexical-ios 的 `x-lexical-nodes` 复制格式（已记为 deferred minor）。
