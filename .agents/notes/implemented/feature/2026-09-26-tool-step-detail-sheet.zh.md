# 展开的工具步骤是一张 sheet

Status: implemented
Translation: current

[English](2026-09-26-tool-step-detail-sheet.md)

## 摘要

在对话里展开一个工具步骤时，不同形态的工具会显示成不同的东西：shell 命令是一块灰色
终端；只要结果恰好是字符串，任何工具都会变成带 `>_` 标题栏、重复行标题的终端面板；
文字结果是一张大号带边框的 Markdown 卡片；而当 agent 把命令同时作为文本块发出时，同一段
脚本会出现两次，第一份还被 Markdown 弄乱。现在每个展开的步骤都打开成同一张无标题的
sheet，使用对话的卡片材质，按发生顺序把"做了什么"和"返回了什么"排成以分隔线划开的
section。只有命令做语法高亮，在共享的 Shiki worker 里完成；输出保留 ANSI 颜色，从不
分词。sheet 不改变历史的存储内容：这里的所有规则都在渲染时生效。

## 问题与证据

Owner 截图（2026-09-25）在同一个 turn 里显示：`ToolSearch` → 一张 16px 带边框卡片
写着 "Tool: TaskStop"；`TaskStop` → 终端面板，标题栏重复 "TaskStop"，下面是一行
JSON；Claude Bash 步骤 → 灰色面板（"太灰了，变白一点"）；暗色主题下的 `python3 -c`
步骤 → 脚本先按 Markdown 渲染（`*` 变成强调，路径变成文件 chip），然后又作为命令出现
一次。

原因都在 `ToolCallCard`（`view.tsx`）：

- `TerminalComponent` 使用 VS Code 的 `terminal.background`，在 Lody Light 里是灰色；
  只要步骤不是 `execute` 调用就显示自己的标题栏。
- 历史把 Claude 工具的纯字符串 `rawOutput` 存为 `terminal_output`
  （`extractTerminalOutputContent`），于是非 shell 工具也拿到终端外观，并被
  `isCommandToolCall` 计为命令——行显示 "Ran TaskStop"，"Ran N commands" 也把它算进去。
- 与命令相同的多行文本块不会成为"终端标题"（那只接受单行文本），于是落到了
  `MarkdownBlock`。
- 文字结果被包在 `CONVERSATION_PANEL_FRAME_CLASS` 里，使用正文字号。

## 决定

- `tool-call-detail.tsx`（StyleX）负责 sheet：填充 `--composer`（亮色为白色，暗色为输入
  框表面——即 composer 自己的填充）、`shadow.card`、`radius.medium`，无标题栏。section
  之间用内嵌的 `separator` 分隔线，第一个之上从不画线。
- 命令 section：`$` 提示符加上 `useMarkdownCodeTokens(…, 'shellscript')` 的 Shiki
  token，在 `markdown-highlight.worker.ts` 里分词，完成的块会被缓存。搜索存储的"命令"是它
  的 pattern，所以没有提示符，也不用 shell 配色。`--lody-shiki-*` 调色板移到共享的
  `[data-shiki-palette]` 规则。
- `tool-call-command.ts`：`formatToolCommand` 拆开 `bash|sh|zsh -lc <script>`（Codex
  argv），并给 shell 会拆开的其他参数加引号；`isToolCommandEcho` 丢弃重述命令的文本块
  （fenced、行内代码或重新排版的）。
- 输出 section：和以前一样的尾部预览、ANSI 颜色、次级标签色；更早的输出被截断时显示一行
  说明；非零退出时用 destructive 色显示 `Exit N`——这是 sheet 里唯一值得上色的事实。
- 文字结果：JSON 或单个 fenced 块以等宽原样显示；散文以对话字号 0.9 倍的紧凑 Markdown
  渲染，与其他 section 对齐。
- diff 仍是独立表面，会把 sheet 切开；权限记录仍是一行。
- 对非 shell 类型，`isCommandToolCall` 要求存在 `terminal_command`；只有输出不再让工具
  成为命令。

## 备选方案

- 原地改造 `TerminalComponent`：它还服务于 worktree 脚本通知，那里的标题栏是有信息的；
  而发灰的正是它的终端背景表面。
- 输出也做高亮：输出不是源码，对 transcript 里最长的字符串分词会占用 worker 时间，而
  ANSI 已经带着程序自己的颜色。
- 同时把 Markdown fenced 代码块变白：留作单独决定；它们仍使用 `--code-background`。

## 证据与局限

`tests/agent-activity-row.test.tsx` 展开真实的行并断言：每个步骤一张 sheet；被重述的
脚本只出现一次且从不作为 Markdown；Codex 包装被移除；`Exit 2`；字符串结果既无提示符也无
标题栏；分组把 `TaskStop` 计为工具。`tests/tool-call-command.test.ts` 覆盖拆包、加引号、
worktree 缩短和重述匹配。`Sessions/ToolCallSteps` story（亮色与暗色）在 Chromium 中
截图验证。未在打包后的桌面应用中验证，也未覆盖上述形态之外各 agent 的真实 payload。
