# 设置编辑对话框：弹层、面板颜色与自行消失的 Shortcut 编辑器

Status: implemented
Translation: current

[English](2026-09-28-settings-editor-dialog-popups.md)

## 摘要

Prompt Shortcut 和 Agent 角色编辑器有四个问题：长 Select 列表的第一行上压着一个多余的箭头；打开几个 Select 后，页脚下方多出一截空白；面板是灰色，和白色的设置页不一致；桌面版中 Shortcut 编辑器还会自己关闭。四个问题各有原因，都在源头修复：弹层的 portal 不再占布局空间；Select 的滚动箭头自己声明贴边位置；浅色产品调色板把卡片层和模态层映射到浮起的 widget 表面色；cloud platform 对象不再因为会话重新拉取而更换引用。只有 platform 的修复有单元测试。布局和颜色的修复在 Chromium 中实测，因为 jsdom 不会应用 StyleX 的 CSS。

## 原因与修复

- **页脚下的空白**：Base UI 为每个弹层挂一个自己的 `<div>`，追加到容器里。在对话框中，这个容器就是面板，而面板是带 16px `gap` 的 flex 纵列。所以每打开一个 Select，面板就多一个 flex 子项和一段 gap，而且列表关闭后这些 portal 元素仍然挂着。面板已经到 `max-height` 时，每个 Select 让表单缩短 16px（实测打开四个后从 582px 降到 518px）。现在所有浮层的 portal 都使用 `portalClassName`（`display: contents`）。里面的 positioner 本来就脱离文档流。
- **"None" 上的箭头**：Base UI 给滚动箭头加了内联的 `position: absolute`，但不设置 inset，交给使用方决定。不设 inset 时，绝对定位元素在 flex 纵列里会落到盒子起点，所以向下箭头画在了第一行上。现在由 `surface.scrollArrowUp` 和 `surface.scrollArrowDown` 把它们固定在上、下边缘，并沿用弹层外侧的圆角。`surface.scrollArrow` 本身仍不定位，供 gallery 中的样例使用。
- **列表向触发器左侧偏出**：Base UI 默认让锚定的列表与触发器居中对齐，比触发器宽的列表会越过触发器的起始边。现在 `Select.Content` 默认使用 `align="start"`。
- **灰色面板**：#961 把卡片层和模态层用的 `elevatedBackground` 映射成了 `hsl(var(--card))`。浅色主题的 `--card` 是侧栏色，比画布低一级（Lody Light 为 `240 14% 94.1%`，渲染为 `rgb(239,239,241)`），所以所有对话框和产品卡片都变成了侧栏灰。#961 之前，这些表面用的是组件包的白色。设置页用只在浅色下生效的 `--card: var(--popover)` 绕开了这个问题，但对话框是 portal 到设置页之外的。现在浅色调色板把 `elevatedBackground` 映射为 `--popover`。深色保持 `--card`，即调色板按其调校的深海色阶。
- **Shortcut 编辑器自行关闭（cloud 版）**：`useStableSession` 会在窗口获得焦点时，以及每 5 分钟的保活中重新拉取会话。每次拉取都返回新的 `user` 对象，于是 `createOrganization` 的引用变化，`CloudPlatformProvider` memo 出来的 platform 也跟着变化。Prompt Shortcut provider 用 `instance.platform === platform` 校验 runtime（#989），这时 `runtime` 变成 `null`。设置列表的 key 取决于 runtime 是否存在，于是整个列表重新挂载，编辑器草稿丢失。现在 platform 的方法从 ref 中读取回调，platform 对象只随 `localAgentSyncMode` 变化。

## 考虑过的方案

- _在面板内放一个脱离文档流的专用层作为弹层容器_：只能修好 Dialog、AlertDialog 和 Drawer。使用方自己提供的 `PopupContainerProvider`（例如移动端新建会话面板）仍会有这个问题。
- _Shortcut 设置改为按身份做 key，而不看 runtime 是否存在_：这只替一个使用方掩盖了症状，其他按 platform 持有的资源仍会在每次拉取时重建。会话状态处于 `loading` 期间，这样做也不起作用。

## 限制

- 会话拉取*失败*并重试期间，状态仍会被设为 `loading`（`cloud-platform-provider.tsx`）。这时 `userId` 为 `null`，Shortcut 编辑器同样会重新挂载。这条路径出现的可能性较低，本次没有改动。
- 浅色模式下，设置页之外使用 `elevatedBackground` 的产品卡片（提问卡、权限请求卡、归档页、引导页）会恢复为 #961 之前的白色。

## 验证

- `tests/cloud-platform-provider.test.tsx` 用新对象重新提供相同的会话数据，断言 platform 对象不变，并且调用的是最新的 `createOrganization`。在修改前的 provider 上，这个测试失败。
- Chromium：用临时 Storybook story，把两个编辑器放进产品 `Dialog`，并使用设置页的宽高。开关角色表单的全部五个 Select 后，表单保持 582px。面板实测为 `rgb(255,255,255)`，修改前为 `rgb(239,239,241)`。在 30 行的列表上，两个箭头分别贴在弹层的上、下边缘，列表左边缘与触发器对齐。
