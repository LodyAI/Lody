# 用 ⌘1–⌘9 直接切换会话标签页

Status: implemented
Translation: current

[English](2026-09-22-session-tab-index-shortcuts.md)

## 摘要

桌面端会话标签栏此前只有相对切换（⌘⇧, / ⌘⇧.）——要跳到某个标签页只能逐个步进。
本次新增 9 个 registry 命令，采用浏览器惯例：`Mod+1`–`Mod+8` 切换到对应的会话
标签页，`Mod+9` 切换到最后一个标签页。之所以是 9 条独立命令
（`session.switchToTab1`…`session.switchToTab8`、`session.switchToLastTab`），是因为
registry 中一条命令只对应一个 `run`，且快捷键设置页每行只编辑命令的第一个绑定；
如果合并成一条带 9 个绑定的命令，就无法按位置分别改绑。这组绑定与现有的
标签步进快捷键一样仅桌面端生效——浏览器把 ⌘\<数字\> 保留给自己的标签栏。

## 问题与决策

按位置跳转索引到 `orderedSessionTabIds`——与 `session.nextTab` /
`session.previousTab` 循环遍历的是同一个列表——因此数字位置与可见的
`variant="session"` 标签条完全一致（先是父标签页，然后是按持久化顺序排列的
子标签页和草稿标签页）。`switchToTabN` 仅在标签数大于 N−1 时可用；
`switchToLastTab` 在存在任意标签页时可用。两者都经由 `handleSessionTabSelect`
解析，因此按下数字键与点击一样会推入历史记录。

考虑过的替代方案：一条命令挂 9 个快捷键被否决，因为 `run()` 拿不到事件上下文
（无法区分按下了哪个数字），且设置页只渲染 `currentBindings[0]`，第 2–9 个位置
将不可编辑。只覆盖更少位置（如 1–4）也被否决——registry 本就能容纳 Navigation
分类新增的 9 行，没有收益。

`session.newTabOrTerminal` 同时新增了浏览器惯例的 `Mod+t` 作为第二个
electron-only 默认绑定——桌面端 ⌘T 新建会话标签页。它作为次级绑定加入而不是
替换 `Alt+n`，后者仍是第一个（也就是设置页可编辑的）绑定；web 端浏览器把
⌘T 保留给自己的标签栏，因此只有 `Alt+n` 在 web 生效。

## 与右侧栏的隔离

数字跳转在结构上不可能影响右侧栏：viewer 标签页（`file:`/`diff:`）和侧栏
标签页（PR、Files、Side Chat）从不属于 `orderedSessionTabIds`，任何下标都
无法寻址到它们。`handleSessionTabSelect` 只移动桌面焦点区域 ref（供 Cmd+W
定向）并写入 `?tab=`；`writeSessionUrlTab` 把 tab 参数合并进现有 search，因此
`?pr=` / `?browser=` 在会话切换后保留，而 `isSidebarOpen` / `activeViewerTabId` /
`activeSidebarTab` 只在 `sessionId` 路由变化时重置，会话内 `?tab` 切换从不触发。
唯一注册的 `KeyScope`（Monaco Quick Fix）只认领 `Mod+.`，所以数字快捷键全局
派发——包括作曲器或右侧栏编辑器持有焦点时，与浏览器 ⌘<数字> 语义一致。
一个既有特性：已归档但未关闭的子会话会占据 `orderedSessionTabIds` 中的位置，
但在 `variant="session"` 标签条上没有可见的标签——这是 `nextTab`/`previousTab`
早已共享的有序列表语义，不是新引入的分歧。

## 验证边界

`commands-built-ins.test.ts` 断言了默认绑定：web 端为空，electron 运行时为
`Mod+1`–`Mod+8` / `Mod+9`。桌面旅程 `LODY-SHORTCUT-002`
（`e2e/src/features/shortcuts.feature`，`@P1 @runtime-simulator`）在真实
Electron 中端到端驱动按键路径：scripted-ACP 会话，`Mod+t` 打开两个草稿
标签页，然后 `Mod+1` 回到父标签页、越界数字不改变选中、`Mod+2` 切到第 2
个标签页、`Mod+9` 切到最后一个标签页，均通过 `Session tabs` 标签条的
`aria-selected` 状态断言。

相关规则见 `packages/components/src/lib/commands/AGENTS.md`。
