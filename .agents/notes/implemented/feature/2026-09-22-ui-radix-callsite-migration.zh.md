# UI v2 调用点迁移：所有 Radix 基元的调用方落到 `@lody/ui`

Status: implemented
Translation: current

[English](2026-09-22-ui-radix-callsite-migration.md)

## 摘要

`@lody/ui` 基元早已存在但没有调用方：`packages/components/src/ui` 里的每个
Radix 文件仍拥有完整的调用图。本次改动迁移了剩余的浮层与反馈调用点——
tooltip、popover、menu 与 context menu、dialog 与 alert dialog、toast、card、
tabs、kbd、progress、spinner，约 400 处调用、横跨约 200 个文件——并删除了这些
Radix 包装层。`src/ui` 保留三个兼容适配层（`menu.tsx`、`dialog.tsx`、`card.tsx`），
承载基元不该知道的产品语义；本地 `spinner.tsx` 则作为有意不同的组件存活——它是
图标动画器，而 `@lody/ui` 的 Spinner 接管纯加载标记。迁移的代价是 `@lody/ui`
新增一个属性（`Dialog` 的 `noAnimation`）以及一个 `data-slot="spinner"` 测试锚点。

## 问题

本系列前几条笔记交付的基元在 gallery 画板上验证过，却处于闲置状态：`Tooltip`
对应 49 处本地 Radix 调用，`Menu`/`ContextMenu` 37 处，`Dialog`/`AlertDialog` 60
处，`Popover` 14 处，`Toast` 60 处，另有 116 处分布在 card、tabs、kbd、
progress 与 spinner。只要调用方不迁移，每个 Radix 文件就继续持有它的 Tailwind
样式、事件语义与测试选择器，新包声明的 token 体系对产品界面毫无作用。

## 迁移了什么、没迁移什么

所有被删包装层的仓内调用方现在都直接导入 `@lody/ui`，或经由三个适配层。删除的
文件：`tooltip.tsx`、`popover.tsx`、`dropdown-menu.tsx`、`context-menu.tsx`、
`dialog.tsx`、`alert-dialog.tsx`、`sonner.tsx`、`tabs.tsx`、`kbd.tsx`、
`progress.tsx`、`loading.tsx`、`form.tsx`（死代码）、`workspace-list.tsx`（死
代码）。barrel `src/ui/index.ts` 按调用方已用的名字转发包模块。

`spinner.tsx` 保留：它是图标动画器（`icon` + `spinning`），与 `@lody/ui` 的加载
标记（`size`/`label`/`tone`，无 glyph 属性）职责不同。11 处调用方需要动画器，其余
约 100 处已迁移。`drawer.tsx`（带移动端键盘处理的 Vaul 底部抽屉）、
`scroll-area.tsx`（打过补丁的 Radix scroll area）、`command.tsx`（cmdk）、
`sidebar.tsx`、`resizable.tsx`、`slider.tsx` 以及产品组件（`collapsible-card`、
`diff-viewer`、`mention`、`emoji-picker`、`menu-styles`）没有包内等价物，保持
不变。

## 适配层及存在原因

`src/ui/menu.tsx` 转发 `@lody/ui` 的 `Menu` 与 `ContextMenu`，并持有三件基元无法
知晓的产品策略：composer 焦点策略（按下菜单项默认把焦点还给 composer，除非该项
自己的 `finalFocus` 另有说法；Escape 与外部按下走 Base UI 默认）、
`MenuSearchInput`，以及不属于 `Group` 子级的独立分组标题 `Menu.Label`。

`src/ui/dialog.tsx` 持有 `data-lody-dialog-content`（mention 与编辑器代码通过它
找最近的 dialog）、作为 backdrop 内容的 `WindowDragStrip`、命令面板用的
`DialogContentWithoutClose`。`AlertDialog.Action`/`Cancel` 是渲染成 Button 的
`Close`——答案跑完 `onClick` 就关闭。12 处使用 Radix `preventDefault` 保开惯用法
的异步确认调用方（吊销凭据、清缓存、删 provider……）被迁移到了 Base UI 模型：
需要保持打开的答案就是普通 `Button`，dialog 由调用方在异步完成后经受控
`onOpenChange` 关闭——它们本来就有受控 `open`。`machine-detail-pane.test.tsx`
钉死了「吊销失败保持打开」的证据。

`src/ui/card.tsx` 补了包导出没有的 `Card.Content` div。

## 迁移暴露的差异

- **事件语义不同。** Base UI 菜单触发器在 `mousedown`（排进一帧）时打开，而非
  Radix 的 `pointerdown`；子菜单悬停是 `mousemove`；context menu 仍是
  `contextmenu`。十几个测试文件用 `pointerdown` 开菜单并同步读结果，全部改为
  `mousedown` 加真实定时器的一帧冲刷。jsdom 的 rAF 是真定时器，所以冲刷用
  `setTimeout` 一拍，而非调度运气。
- **菜单行的浮层就是 `Menu`。** fork-destination 原本给 `Popover.Content` 标
  `role="menu"` 并手写 `role="menuitem"` 按钮；现在是
  `SessionForkDestinationMenu`，用真正的 `Menu.Item`，顺带补上了手写行没有的
  方向键导航。Base UI 的 `Popover.Popup` 保持 `role="dialog"`。
- **composition 状态在文档级跟踪。** bug-report dialog 的 IME 测试需要在取消
  输入的 Escape 与关闭的 Escape 之间补一个 `compositionend`——真实的 IME 时序，
  不是变通。
- **Chromium 合成器规则随组件迁移。** `@lody/ui` 的 Spinner 动画在
  `data-slot="spinner"` HTML wrapper 上，绝不在 `<svg>` 上（crbug.com/1186312）。
  组件侧不变量测试现在接受任一 wrapper 标记；包自身测试钉住结构。
- **Base UI 的 `Tooltip` 纯视觉**——无 `role="tooltip"`、无 `aria-describedby`。
  查该 role 的测试改为找 positioner；纯图标触发器自己命名，迁移后的调用方
  本来就如此。

## 验证

`pnpm check` 全绿：完整 typecheck、边界守卫、双套件——`packages/components`
484 文件 / 3858 测试，`packages/ui` 23 文件 / 275 测试。`pnpm run docs check`
干净；`pnpm format` 已跑。

## 限制

三个适配层意味着 `src/ui` 尚未清空；删除它们是逐个调用方的 API 改动，不是移除
包装层。`Spinner` 的双重身份是有文档的分工（`src/ui/AGENTS.md`），不是迁移债。
Vaul drawer 与打过补丁的 scroll area 在包长出等价物之前维持原依赖。移动端界面
只经 typecheck 与共享测试迁移，未做真机验证。

随后真实 Electron 的 P0 smoke 抓到了单测抓不到的回归——弹层 `z-index` 被困在
positioner 的层叠上下文里、`closeButton={false}` 丢失、Escape 逐层关闭。见
[弹层 positioner 层叠](../bug-fix/2026-09-23-popup-positioner-stacking.zh.md)。
