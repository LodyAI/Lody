# 让序列化的工具输入 JSON 不再经过 Markdown 数学公式管线

Status: implemented
Translation: current

[English](2026-09-15-tool-call-json-markdown-math.md)

PR: [#711](https://github.com/LodyAI/Lody/pull/711)

## 摘要

展开 tool call 时，它的原始输入 JSON 显示是花的：单 `$` 行内数学解析把 `$(git ...)` 这类 shell 片段当成 TeX 公式，并丢掉了 `2>&1` 里的 `&`，导致显示的命令并不是实际执行的命令。历史存储和实际执行的命令都是完好的——损坏只发生在渲染时。现在渲染层会识别出内容为序列化 JSON 的文本块，改用不做任何改写的逐字等宽代码呈现，只有散文继续走 Markdown 路径。散文里合法的 `$...$` 公式不受影响；工具的 `resource` 文本块仍按 Markdown 渲染，同样的显示问题在那里依然存在。

## 决策与边界

`detectToolCallJsonText`（`packages/components/src/lib/tool-call-json-text.ts`）在文本块去掉首尾空白后能解析为 JSON 对象或数组时，原样返回原文（不做任何改写），否则返回 `null`（原始值、散文、损坏的 JSON）。`StandardToolContentBlock` 的 `text` 分支（`packages/components/src/components/ai-gui/view.tsx`）把识别出的 payload 用与原始工具输出一致的等宽 `<pre>` 展示；其余内容照旧进入 `MarkdownBlock`。

`JSON.parse` 只用于校验，payload 永远不会被重新序列化。把数值词素经过 JavaScript 数字转换会损坏超过 2^53 的整数（64 位 ID）、改写 `1e10` 这类写法，等于在数字上重演同一个"显示与实际不符"的缺陷。

分类器放在叶子级 lib 模块而不是 `view.tsx`：本包的测试模块图规则禁止把整个 `view.tsx` 的导入图拉进单元测试，而且纯函数正是回归测试要断言的契约。

## 备选方案与取舍

曾考虑让生产端不再输出 input-JSON 文本块，被否决：历史会话已经带着这些块，只改生产端会让既有记录继续花屏。也曾考虑对所有 tool-call 文本块关闭数学解析，被否决：工具结果可能包含合法的 `$...$` 公式散文；JSON 解析检查用"数据 vs 散文"的区分代替一刀切。最初采用的 `JSON.stringify` 美化排版在评审中被指出存在上述数值词素损坏后放弃；保留词素的美化打印器需要在展示路径上手写一个 JSON 分词器，逐字方案以"单行 payload 保持单行"为代价避免了这部分复杂度。

## 证据与局限

回归测试使用真实 payload 形态（一条含 `$(...)`、`2>&1` 和嵌套引号的 `git commit --amend` 命令），断言输出与输入逐字一致；超过 2^53 的整数词素和指数写法断言保持原有数字；散文、原始值和畸形 JSON 继续走 Markdown 路径。单测 8/8 通过；包级 typecheck、改动文件的 oxlint、Prettier 均干净。`markdown-idle-rerender` 与 `markdown-streaming-reparse` 在未改动的基线上于新 worktree 中就失败（jotai 存储环境），与本改动无关。工具的 `resource` 文本块被有意留在 Markdown 路径，仍可能触发同样的显示问题；渲染效果是经代码审查确认的，未在实际 UI 中点击验证，因为发现问题的历史记录早于本分支产生。
