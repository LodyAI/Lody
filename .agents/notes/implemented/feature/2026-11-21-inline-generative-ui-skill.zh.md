# 通过显式标记和 MCP skill 提供会话内生成式界面

Status: implemented
Translation: current

[English](2026-11-21-inline-generative-ui-skill.md)

## 摘要

Lody 会把助手回复里的 HTML 放进沙箱，作为会话里的界面运行。但之前没有任何地方告诉
agent 有这个能力，而且所有闭合的 `html` 代码块都会被执行，连 agent 想给用户阅读或复制
的 HTML 源码也会被运行。现在只有信息串正好是 `html render` 的代码块才会执行。内置 MCP
服务器发布了 `lody-visualize` skill，讲清楚这个标记、沙箱限制和主题变量，服务器说明里
也写明了这个 skill 的 URI。没读过 skill 的 agent 写出的普通 HTML 照旧显示成源码。这份
指引随 CLI 包固定，不能跟着 App 设置变化；除 Claude Code 外，其他宿主会不会读 MCP
服务器说明还没有验证。

## 决定

- **显式标记。** 只有信息串正好是 `html render` 的闭合代码块才执行。由 Markdown 解析器
  判断标记，并和代码块闭合状态一样按源码位置记录，所以 `rehype-raw` 和清洗步骤抹不掉它，
  原始 HTML 属性也伪造不了它。语言仍是 `html`，代码块流式显示源码时保留 HTML 高亮。
- **用 MCP skill 提供指引。** `lody-visualize` 放在现有的内置 skill 目录里。服务器说明列出
  每个 skill 的入口 URI，因为在已记录的实测中 Codex 0.160.1 和 Claude Agent SDK 0.3.293
  都没有请求 `skills/list`（[交付路径](../../../../apps/cli/src/mcp/README.md#skills-over-mcp)），
  这些宿主在连接时只能收到服务器说明。
- **提示词来源。** T3 Code 通过 MCP 工具展示 HTML：`html_preview` 返回截图、高度和控制台
  输出，`html_render` 发布页面。它们的工具描述提供了 skill 采用的规则：不介绍也不复述页面；
  html、body 和最外层元素不加背景、卡片、边框或左右留白；使用主题变量；高度由内容决定，
  不用 `vh`。skill 的结构（先判断该不该用、按需求选写法、通用约束、最后检查）参考了
  opencode 里附带的 Figma 画图 skill；opencode 本身没有会话内可视化。

## 备选方案

- **所有闭合的 `html` 代码块都执行。** 这是之前的行为。写代码的 agent 经常用 `html`
  代码块展示源码，而大多数 agent 不会读这个 skill，本该显示的源码会被运行。
- **换一个语言名，比如 `lody-ui`。** 流式显示源码时会失去 HTML 高亮，agent 在陌生的语言名
  下也更难写出正确的 HTML。
- **按 App 设置每轮注入提示词。** App 给这一轮加标记，CLI 追加说明，能覆盖不读 MCP 说明的
  agent。但这会新增一条提示词注入路径，而 MCP skill 交付本来就明确避免这样做，所以没有采用。
- **像 T3 Code 一样做专门的渲染工具。** 服务端渲染能在发布前给 agent 截图和实测高度，但需要
  无头浏览器和附件存储；Lody 的代码块已经在客户端渲染并自己测量高度。

## 影响

- skill 必须和渲染器一致：`--preview-*` 变量名、只开 `allow-scripts` 的沙箱、10,000px 高度
  上限和防循环保护。[HTML 预览规则](../../../../packages/components/src/components/ai-gui/html-preview/AGENTS.md)
  同时约束两边。
- agent 看不到渲染结果。skill 要求页面保持小巧，有浏览器工具时自己检查；和 T3 Code 相比，
  最大的缺口是 Lody 没有预览工具。
- Lody 没有注入图表色板或状态色。skill 让 agent 只用一个强调色系列，其余保持中性，需要更多
  颜色时用 `light-dark()`。
- 之后的 App 设置可以在客户端把 `html render` 代码块当源码显示来关闭这个能力；MCP 指引本身
  不随用户变化。

## 验证

- `packages/components/tests/markdown-streaming-reparse.test.ts` 覆盖标记判定、闭合、嵌套容器
  和伪造的原始属性。
- `apps/cli/src/mcp/skills/server.test.ts` 覆盖 skill 列表、实际返回的字节、链接可达，以及服务器
  说明列出每个入口；`lody-mcp-server.test.ts` 覆盖 HTTP 下的列表。
- Storybook `Conversation/Markdown HTML` 增加了普通代码块的 `Source` story。skill 里的示例
  图表在临时 story 里按暗色和亮色渲染过。
- 未验证：Codex 和其他 ACP agent 是否读取 MCP 服务器说明，以及 agent 在真实会话里如何使用
  这个 skill。
