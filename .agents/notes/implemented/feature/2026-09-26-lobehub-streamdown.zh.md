# 使用 `@lobehub/streamdown` 渲染流式 Markdown

Status: implemented
Translation: current

[English](2026-09-26-lobehub-streamdown.md)

## 摘要

对话中的 Markdown 原先由 Vercel 的 `streamdown` 渲染，它自带代码块、Mermaid 和数学公式
UI，流式文本按原始分块直接出现。现改为 `@lobehub/streamdown`：一个无样式的引擎，会平滑
流式文本的出现节奏，只对仍在到达的字符做淡入。引擎懒加载，且只在回合流式输出时使用；
已完成的文本通过普通 react-markdown 渲染，代码块、高亮和 Mermaid 组件改由 Lody 自己维护。
主要权衡是本地 UI 代码增多，换来平滑的流式体验和没有动画开销的静态路径。

## 问题

- Vercel `streamdown` 原样呈现每个流式分块，文字跳跃式出现。它的词级 `animated`
  会把整个回合的每个词包进 span，因此从未启用。
- 它提供的许多东西已被覆盖：Mermaid 全屏和平移缩放画布被关闭
  （[手势记录](../bug-fix/2026-09-09-mermaid-diagram-gestures.zh.md)），
  `tailwind/index.css` 用 `!important` 对抗它的工具类。

## 决定

- `markdown-renderer.tsx` 对已完成文本使用 `react-markdown`，在 `isStreaming` 时使用
  `@lobehub/streamdown` 的 `Streamdown`。引擎只重新解析尚未闭合的尾部块，平滑出现节奏，
  只淡入正在到达的字符；已稳定的文本没有动画 span，开销不随回合增长。
- 流结束后流式渲染器再保留一秒，让缓冲的尾部显示完，然后交给静态渲染器。
- 引擎是懒加载分块。它的产物包含 lookbehind 正则字面量，在 Safari < 16.4 上是解析
  错误（与 `remend` 补丁和懒加载 `@pierre/diffs` 是同一约束）；加载失败时回退到静态
  渲染器，而不是让回合崩溃。
- 旧库提供的部分改由 Lody 维护：`markdown-code-block.tsx`（容器、复制按钮、token 主体）、
  `markdown-code-highlight.ts`（使用现有高亮 worker，带主线程回退和有界缓存）、
  `markdown-mermaid-block.tsx`（渲染、复制，以及通过 armed `Menu` 提供 SVG/PNG/源码下载）。
  保留 `data-streamdown="…"` 属性作为样式和测试钩子。
- 流式中的代码块在 worker 返回前保留上一次的高亮结果，新增文本以纯文本追加；其前缀不再写入
  高亮缓存，避免挤掉已完成的代码块。
- `@lobehub/streamdown` 用 `remend` 默认选项补全尾部，其 HTML 标签步骤会丢弃 `p<q` 这类
  TeX 比较符之后的全部内容（[之前的修复](../bug-fix/2026-09-20-streamdown-math-document-truncation.zh.md)）。
  `@lobehub/streamdown` 1.4.0 为此新增了 `remend` 选项
  （[lobehub/streamdown#5](https://github.com/lobehub/streamdown/pull/5)），渲染器传入
  `{ htmlTags: false }`，与旧渲染器一致。由于在发布当天采用，1.4.0 被列入
  `minimumReleaseAgeExclude`。
- 一个 remark 插件标记未闭合的代码围栏，使流式中的围栏带有 `data-incomplete`；未闭合的
  Mermaid 围栏在闭合前保持普通代码块，而不是每次提交都重新渲染图表。
- 数学公式直接使用 `remark-math` 和 `rehype-katex`，选项与 `@streamdown/math` 相同。

## 备选方案

- 保留 Vercel `streamdown`，只喂给它 `useSmoothStreamContent` 的输出：改动更小，但保留了
  被覆盖的内置 UI，也没有逐字淡入。
- 所有消息都用 `Streamdown`：它在挂载时就会动画，虚拟列表中滚回视野的行会重放淡入，
  并且每个页面都会加载含 lookbehind 的分块。

## 验证与限制

- `tests/markdown-streaming-reparse.test.ts` 覆盖流式到静态的交接、围栏闭合判断、原始
  HTML 转义、两条路径上的自动链接修复，以及流式中 `p<q` 数学公式之后的内容（去掉 `remend` 选项即失败）；`tests/markdown-mermaid-fullscreen.test.tsx`
  在新的区块结构下原样通过。
- 已在 Storybook 中检查：代码高亮、表格、KaTeX、Mermaid 操作栏和下载菜单，以及流式演示
  （仅在流式时有淡入 span，交接后为零）。
- 流式期间每个顶层块独立解析，脚注和引用式链接要等回合结束后才会解析。
- 旧版 Safari 下流式输出没有平滑和淡入；未在真机上验证。
