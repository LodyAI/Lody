# 输入框 `@`、`/`、`$` 菜单迁到 v2 浮层表面

Status: implemented
Translation: current

[English](2026-09-25-composer-mention-menu-v2.md)

## 摘要

在输入框里敲 `@`、`/` 或 `$` 时弹出的菜单，是 v2 迁移漏掉的最后一个浮动列表：1px 边框、
shadcn 的小阴影、全大写的分组标题、等宽字体的完整文件路径，以及在两行列表下仍固定撑开
320px 的详情栏。现在它站在 `@lody/ui` 的 popup 表面上——raised 底色、popover 阴影、14px
圆角、28px 行、6% 墨色高亮——用 StyleX 从语义 token 重述，桌面浮层和移动端停靠条一致。
行变成单行但承载更多信息：文件先显示文件名再显示所在目录，命令先显示名字再显示说明，
一级分类行显示能直接打开它的按键（`$`、`/`）。mention 原语的行为（触发、键盘、插入、
range）没有变化。

## 改了什么

**表面。** `src/ui/mention/mention-surface.ts` 持有表面、行、高亮和入场动画。`@lody/ui` 的
`popup` token 组是包内私有的，所以这里像 `components/shared/composer-surface.ts` 那样，从它们
解析到的语义 token 重述数值。桌面 `MentionContent`、移动端 `MentionMobilePanel` 和所有行都读它，
菜单里不再有 Tailwind。StyleX 选不到 `data-highlighted`，因此 `ui/mention.tsx` 从 mention 上下文的
`highlightedItem.value` 推出高亮。入场是 popup 的上浮：从离光标更远 4px 处用 `duration.regular`
落位；方向取 floating-ui 实际落在哪一侧（`--mention-rise`），因为窗口底部的输入框会把菜单开在
光标上方。

**行。** 一行依次是：图标、`title`、先让位的安静 `hint`、尾部元信息（`#3312`、快捷指令的可见范围）。
`MentionCandidate` 新增 `hint`；`subtitle` 现在只用于解释某行为何不可选的第二行（例如 Role 的可用性）。
文件候选把 token 拆成 `title`（文件名，目录带 `/`）和 `hint`（所在目录）：人要找的东西在前，
目录用来区分两个 `index.ts`。提交的文本仍是完整的 `@path`。命令和提示快捷方式把说明放进 `hint`，
所以 `/` 列表每条一行而不是两行。禁用行只把文字调淡，不把整行调淡，因为它携带的原因必须可读。

**层级。** 分组标题用 caption 字号的句首大写，与 `ui/menu-styles.ts` 的产品菜单一致。二级界面会
标明自己：从 `@` 进入时，标题是写着“‹ Skills”的 ghost `Button`，同时就是返回入口；从它自己的
触发键进入时只是标题。Sessions 的范围切换改用 `@lody/ui` 的 `ToggleGroup`。加载中显示 `Spinner`，
错误用 destructive 色。一级分类行在尾部显示它的 `directTrigger`，在用到的地方教会快捷键。

**详情栏。** 详情栏与行在同一表面上、以分隔线色隔开，高度随内容增长、上限与列表相同，不再固定
320px。菜单是一个 size container，宽度低于 480px 时隐藏详情栏：在窄输入框里，旧的固定 248px
详情栏会把列表挤成零宽，真实浮层的 story 复现了这一点。Agent Role 仍使用与输入框 Role 子菜单共享的
`AgentRoleDetailPane`，保持原样。

**移动端。** 停靠条是唯一的滚动容器。菜单过去依赖全局的 `.mention-mobile-panel .scrollbar-pro`
覆盖来摊平自己的列表；现在它接收 `docked` 并去掉自己的滚动容器，该 CSS 规则已删除。

## 第二轮：行说出更多，动效说明方向

被要求“做得更好”后，第二轮只加携带信息的东西：

- **匹配到的字母被点亮。** 输入搜索词时，标题中匹配的字母用墨色、650 字重，其余退到次级文字色，
  每一行都回答“它为什么在这里”。位置来自各来源排序用的同一个 VS Code `scoreFuzzy`（`matchedRuns`）。
  路径搜索词按最后一段匹配，因为文件行的标题只有文件名。如果匹配不在标题上（按编号找到的 issue、
  按目录找到的文件），标题保持完整，不会整体变淡却没有任何点亮。
- **行说出只有它知道的事。** 会话显示上次活跃时间（`12m`、`3d`），来自新增的 `activityAt`，
  用共享的 `useStableNow` 时钟格式化，registry 不调用 `Date.now()`。Role 的 `hint` 是它的 agent 和
  机器（`Codex · Studio`），不用打开详情就能区分同名 Role。文件夹带 chevron，因为选中它是打开而不是插入。
- **动效说明你往哪走。** 进入一个分类时，这一层从尾侧滑入；返回时上一层从首侧滑入。在同一层里继续
  输入不会重放（在 Chromium 里按 Tab、Backspace 和输入后读取 `document.getAnimations()` 验证），
  `prefers-reduced-motion` 时关闭。

本轮否决的：一级分类上的数量（owner 认为数量徽标廉价，而且计数会启动一级界面不应启动的懒加载来源）；
滑动的高亮（popup 行刻意不加过渡，让高亮不落后于键盘）；在输入框里用幽灵文本预览将插入的内容
（要改动镜像层和光标契约，收益小）。

## 设计评审第二轮

在真实桌面应用（而不是 Storybook）里做的评审发现了 story 看不到的问题。本节取代上文关于定位和
详情栏尺寸的描述。

- **定位。** 菜单用的是 `MentionContent` 的默认值：锚在光标所在行，`side: 'bottom'`，每次尺寸变化
  都重新跑 floating-ui 的 `flip`。两行的一级菜单放得进光标下方、输入框内部，于是盖住了工具栏；
  二级菜单放不下，就翻到光标行上方，压在芯片行上，而且从光标的 x 开始，旁边露出半个芯片。
  `positionAnchor="composer"` 改为锚定输入框的 `[data-mention-frame]`（芯片行加输入框，由
  `ChatComposer` 标记），左对齐，间距 8px。方向在每次打开时选定一次（除非上方没有空间，否则在上方），
  之后不再翻转；改为把高度限制在那一侧的空间内，所以切换层级只会原地改变大小。后续的修复把
  `@` 菜单直接钉成 `side="top"`（见[笔记](../bug-fix/2026-09-26-mention-menu-pinned-above-input.zh.md)）；
  未钉住的 composer 菜单仍按空间选边。
- **比例。** 列表占窄列（约 220px），详情占宽列（300px），菜单共 536px。详情栏的高度跟随列表，
  最低 168px，内容在栏内滚动；描述最多五行，12/18。Role 详情栏使用同一列。
- **详情内容。** 应用里标题消失，是因为详情栏是会滚动的 flex 列，而标题带 `overflow: hidden`，
  在长描述下被压缩到零高度。现在各部分不再收缩，没有标题的详情栏用该行的标题。作用域和版本是一行
  安静的文字，不再是徽标；路径保持一行，从中间省略。
- **图标。** 如果行图标只是重复本级标题（“Skills”下每行的 skill 图标），就去掉。文件类型、文件夹和
  Role 的 emoji 保留；没有自身图标的行，只有在邻行有图标时才保留一个空位对齐。
- **过滤。** `@skill:sy` 仍显示全部六个系统 skill，是因为 skill 按完整路径匹配，而 `sy` 就在
  `~/.codex/skills/.system` 里。现在只匹配 skills 目录之下的那段路径。任何层级里，没有匹配的词都显示
  “没有匹配“sy”的结果”，不会退回未过滤的列表。
- **首页输入框的 `/` 保持无反应。** 只有存在可用命令或 Prompt Shortcuts 时才注册 `/`，这是
  [命令触发草案](../../../../specs/command-mention-triggers.zh.md)写明的门槛，占位文字也按同一规则
  提示 `/`。E2E agent 不上报命令，Prompt Shortcuts 是开发者 beta，所以什么都没打开。要在这里显示空
  菜单就得改这个门槛，这应由 spec 决定。
- **验证。** `tests/mention-registry.test.ts` 在纯视图上复现 `@skill:sy` 和 `$sy`；
  `tests/mention-two-level-menu.test.tsx` 固定了锁定方向、高度上限和重新打开时重新选择、无匹配提示、
  去掉的图标以及路径拆分。`FloatingInComposer`、`FloatingComposerAtTop`、`SkillCategorySystem` 和
  `SkillNoMatch` story 覆盖这些状态；E2E 走查在打包后的渲染器里截取了首页输入框的 `@`、二级、输入后和
  `$` 状态，明暗各一套。

## 考虑过的方案

- **用 `@lody/ui` 的 `Combobox` 或 `Menu` 重建菜单。** 两者都自己管理焦点、由触发器打开；而这个菜单
  锚定在保持焦点的 textarea 光标上，键盘、插入和 range 都归 mention 原语管。所以只迁移表面，行为
  留在文档化了契约的地方。
- **把详情做成列表旁的第二张浮动卡片。** 每张卡可以各自决定高度，但定位元素要变成透明框架，Role
  详情栏也要自带表面。一张表面用一条线分开，层级只有一层，也与 ⌘K 面板一致。
- **像 ⌘K 面板那样加按键提示页脚。** 这是光标下的临时列表，每次打开都带页脚是多余的 chrome；唯一
  不显而易见的按键（直达触发键）现在显示在它适用的那一行上。

## 验证

- Storybook 明暗两套、中英文：`Mentions/MentionTwoLevelMenu` 的每个状态，以及新增的 `FloatingAtCaret`
  story——它在真实 textarea 上挂载真正的 `MentionTwoLevelMenu`，输入 `@`、`/`、`$`、`@role:`，覆盖了
  光标上下两侧的定位、高亮、窄输入框下的详情栏，以及 390px 的移动端停靠条。
- `tests/mention-registry.test.ts` 覆盖文件名/目录拆分（嵌套、根目录、目录）和命令的 `hint`；
  `tests/mention-two-level-menu.test.tsx` 断言详情栏在行旁边而不是某一行；
  `tests/combined-mention-textarea-activation.test.tsx` 按新的“文件名+目录”文本查找文件行。九个
  mention 测试套件全部通过。
- 第二轮在 `tests/mention-two-level-menu.test.tsx` 新增 `matchedRuns` 单测、会话时间和文件夹 chevron，
  在 `tests/mention-registry.test.ts` 覆盖会话 `activityAt`，在 `tests/agent-role-mention-source.test.ts`
  覆盖 Role 的 `hint`。
- 未在打包后的 Electron 应用或真机上验证。
