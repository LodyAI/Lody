# 助手正文换用 MarkdownView

## 问题

`ChatMarkdown.swift` 用 Foundation 的 `AttributedString(markdown:)` 解析，把整条消息压平成一条 NSAttributedString 交给 `ChatTextView` 自绘。解析器不认表格、任务列表和嵌套缩进；代码块没有背景、横滚、语言标签和复制；引用没有竖条；分割线被忽略；链接点不了。样式层能修的只是一部分，表格和代码块横滚在单个 text view 里做不出来。

## 决定

直接使用 FlowDown 抽出的 [Lakr233/MarkdownView](https://github.com/Lakr233/MarkdownView)（MIT）。它是一个 CoreText 文本视图（[Litext](https://github.com/Lakr233/Litext)，MIT）加代码块 / 表格子视图的结构，解析走 cmark-gfm，自带流式节流、视图复用、代码高亮（Highlightr）和公式（SwiftMath）。不重写渲染器。

保留 Lody 现有的逐字淡入。FlowDown 的"按 token 动画"是 `BalancedEmitter` 的均匀分批，Lody 已作为 `ChatStream` 移植；MarkdownView 与 Litext 没有任何淡入代码，需要各改一处注入点。

## 依赖接入

LodyKit 是 CocoaPods 静态库，拿不到 SPM。Spike 已在 Expo 57 + 预编译模块下验证 [cocoapods-spm](https://github.com/trinhngocthuyen/cocoapods-spm) 可行：`pod install` 通过，模拟器 Debug 正常签名构建成功，MarkdownView / Litext / Highlightr / SwiftMath 的资源 bundle 都进了 app，模拟器上表格、带高亮和复制按钮的代码块、任务列表、嵌套列表渲染正常。

- `apps/mobile/Gemfile`：`cocoapods` 与 `cocoapods-spm`，用 Homebrew ruby 的 bundler 安装到 `vendor/bundle`（已加 .gitignore）。Homebrew 的 `pod` 二进制加载不到插件，pod install 必须走 `bundle exec pod install`；`expo run:ios` 直接调 `pod`，所以 `pnpm ios` 改为先 `expo prebuild` 再 `bundle exec pod install`，或者在 `native:assets` 之后自己跑。
- 本地 config plugin `apps/mobile/plugins/withMarkdownView.ts`：用 `withDangerousMod` 往生成的 Podfile 写三样东西：`plugin 'cocoapods-spm'`；`spm_pkg "MarkdownView", :url => ..., :branch => ...`；一段 prepend 到 `Pod::SPM::UpdateScript::Mixin` 的补丁，在插件写 xcfilelist 前 `FileUtils.touch` 不存在的 `Pods-Lody-*-input/output-files.xcfilelist`（Expo 生成的 app target 没有这些文件，插件 0.1.20 会直接崩）。
- `LodyKit.podspec`：`s.spm_dependency "MarkdownView/MarkdownView"` 与 `"MarkdownView/MarkdownParser"`（已加）。

## Fork

两处上游改动，各开一个 PR；合并前依赖 `github.com/Innei` 下的 fork 分支，合并后切回上游 tag。fork 只放注入点，淡入实现留在 LodyKit。

- Litext：`TextLabelView` 增加 `open func makeTextLayout(_ text: NSAttributedString) -> TextLabel.Layout`，替换现有两处 `TextLabel.Layout(attributedString:)` 直接构造。
- MarkdownView：`MarkdownTextView.init` 增加 `textLabelView: TextLabelView` 参数，默认 `.init()`。

## 渲染结构

只替换 `text` 与 `thought` 两种行。`user`、`summary`、工具行继续用 `ChatTextView`，shine 不受影响。

- `ChatCell` 拆出 `ChatMarkdownCell`：内容视图是 `MarkdownTextView(textLabelView: ChatFadeLabelView())`，`throttleInterval = 1/60`。同一行 id 的后续更新走 `setContent`，换行走 `setContentImmediately`；`prepareForReuse` 调 `reset()`。
- 解析缓存 `ChatMarkdownStore`：键是行 id，值是 `(hash, MarkdownContent)`。`MarkdownParser().parse` 在现有 `preparation` 队列执行，`MarkdownContent(parserResult:theme:)` 回主线程构造（它是 `@MainActor`，负责调度高亮与公式）。替代 `ChatMarkdown.prepare`。
- 测量：`measuringText` 与 `measurements` 换成 FlowDown 的 `MarkdownSizingViewPool`（每行一个离屏 `MarkdownTextView`，上限 24，宽度变化只重排，内容或主题变化才重装）。`sizeForItemAt` 对 markdown 行用 `boundingSize(for:)`。
- `applyDynamicType` 与 `traitCollectionDidChange` 重建主题并清空 pool。

## 淡入

- `ChatFadeLayout: TextLabel.Layout`：重写 `draw(in:visibleRect:)`。每行 `CTLineGetGlyphRuns`，与淡入区间不相交的 run 直接 `CTRunDraw`；相交的 run 按字符区间切段，`context.setAlpha` 后 `CTRunDraw` 子区间。
- `ChatFadeLabelView: TextLabelView`：`makeTextLayout` 返回 `ChatFadeLayout`，持有 `ChatTextFade`，`attributedText` 变化后用渲染字符串调 `fade.update`，60fps timer 只 `setNeedsDisplay`，窗口为空或减弱动态时停表。`ChatTextFade` 现有的按渲染字素跟踪逻辑不改。
- 代码块与表格子视图不淡入。

## 主题

一个 `ChatMarkdownTheme.make(traits:secondary:)` 映射到 HIG：

- 字体：`fonts.body/bold/italic` 用 `UIFont.dynamic(of: 17)` 系列，`code/codeInline` 等宽 13 缩放，`largeTitle/title` 沿用现有 23/20 半粗。`thought` 行 body 15。
- 颜色：`body` 是 `label`（thought 用 `secondaryLabel`），`highlight/emphasis/selectionBackground` 用 `systemBlue`，`codeBackground` 用 `secondarySystemBackground`。表格沿用默认的 `separator` / `systemGray6`。
- 间距：`paragraph` 8、`headingBefore` 12、`final` 0，让行高与现有 25pt 正文接近。

## 交互

- 文本选择用 Litext 自带的手势：双击选词、三击选行，拖动手柄扩展，系统编辑菜单复制；Litext 没有长按选择。`text/thought` 行不再挂 `UIContextMenuInteraction`，「选择此块 / 复制此块」删除；`user` 行的复制菜单保留。
- `linkHandler`：MarkdownView 把链接目标作为字符串放进 `.link`，payload 是 `.string`；转成 URL 后只放行 http(s) 到 `UIApplication.shared.open`。
- 代码块的复制按钮是 CodeView 自带的；`codePreviewHandler` 不接。
- 公式点击预览用 MarkdownView 默认行为。

## 删除

- `modules/lody-kit/ios/Chat/ChatMarkdown.swift`
- `ChatCell` 里的块选择菜单、`menuRange`、`pendingSelection` 与块级 `contextPreview`
- `ChatTextView.block(at:)`、`blockRect`、`selectBlock`、`endSelection` 与 `ChatSelectionView`
- `src/ui/MarkdownBody.tsx`、`AssistantProse.tsx`、`react-native-markdown-display` 依赖（会话页已不经过 RN 转录）

## 许可与致谢

README 致谢加 MarkdownView 与 Litext；`native:assets` 脚本把两者的 LICENSE 复制到 `modules/lody-kit/ios/Resources`，与 Flock、Loro 的许可证放在一起。

## 验证

- `pnpm check`、`pnpm test`、`pnpm bundle`，模拟器 Debug 构建正常签名。
- 模拟器：一条含标题、嵌套列表、任务列表、引用、表格、带语言的代码块、行内代码、链接、分割线的真实消息，浅深色各截一次。
- 流式：新会话发送后正文逐字淡入且不闪烁，代码块在 ``` 未闭合时不抖；完成后高度不跳。
- 双击正文出现选择手柄与系统复制；代码块复制按钮写入剪贴板；链接打开 Safari。
- 动态字号切换后行高与高度缓存一致。

## 已知上限

- 淡入只覆盖正文 CoreText 部分，代码块与表格整块出现。
- MarkdownView 不是完整 CommonMark：HTML 块按纯文本显示，列表里的表格和代码块会被提到顶层。
- fork 分支存在期间，上游更新需要手动 rebase。
