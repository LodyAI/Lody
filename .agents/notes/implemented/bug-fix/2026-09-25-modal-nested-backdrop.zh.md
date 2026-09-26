# 嵌套弹层的遮罩由 primitive 负责，挂载即开的动画同理

Status: implemented
Translation: current

[English](2026-09-25-modal-nested-backdrop.md)

## 摘要

dialog 家族迁到 `@lody/ui`（Base UI）之后，在另一个 dialog 里打开的 dialog
完全没有 overlay:Base UI 对嵌套 root 不挂载 backdrop(`enabled: forceRender
|| !nested`)，所以 Radix 时代留下的 `nestedInDialog` backdrop class 从来没有
落在任何元素上。于是 Settings → Agent → 新建 Provider 的弹层浮在没被压暗的
设置面板上。同一批调用方还让 `Dialog.Root` 带着 open 挂载 ——
`machine-agent-settings.tsx` 用 `dialogMode` 直接 gate 整棵树 —— 这会跳过
Base UI 的 `starting`/`ending` transition 状态，进出场动画都不会播。现在
`@lody/ui` 的共享 backdrop 始终渲染（`forceRender`)、与 panel 共享同一个
z 层级，portal 的 DOM 顺序天然把它压在父 panel 之上、自身 panel 之下；当
`ModalDepthContext` 报告存在祖先 modal 时改用更浅的 veil
（`dialog.nestedOverlay`)—— 全部由 primitive 负责，不再需要调用方传 prop。
`machine-agent-settings` 让 dialog 在关闭状态下保持挂载、延迟一个 commit 打开，
并在 `onOpenChangeComplete` 时清理 mode/machine，进出动画因此都能播放。

## 决策与证据

本记录取代
[2026-09-21-nested-dialog-overlays](2026-09-21-nested-dialog-overlays.zh.md)
的按调用方机制，但保留其不变量：所有 overlay 共享 `--z-dialog` 这一层，portal
DOM 顺序让后开的 overlay 位于之前的 panel 之上、自身内容之下。变化的是归
属者。旧修复早于 Base UI 迁移 —— 它假设 backdrop 始终渲染，这一点已经不再
成立。

`packages/ui` 中：

- `DialogBackdrop`(`DialogContent` 使用；由于 `AlertDialog.Backdrop` 上游即同一
  组件，`AlertDialogContent` 也使用）以及 drawer 的 backdrop 都传
  `forceRender`，嵌套 modal 的 veil 因此一定存在。
- `modal.backdrop` 用 `z.dialog`(80）而非 `z.dialogBackdrop`(70):portal 都
  挂在同一个父节点上，DOM 顺序本身就完成 panel 与 veil 的交错 —— 不需要嵌套
  计数器，09-21 的记录已经建立这一点。
- `ModalDepthContext`(`dialog/parts.tsx`）跨 portal 统计祖先 modal 数量 ——
  DOM 祖先关系看不到 portal；depth ≥ 1 时 backdrop 换成
  `modal.backdropNested`(`dialog.nestedOverlay`，约 black/20 —— 页面 overlay
  已经在父 panel 下方压暗，再来一层完整 veil 会叠加过深）。
- 删除了全部 `nestedInDialog` prop 和重复的
  `z-[var(--z-dialog)] bg-black/20` backdrop class(agent config、MCP、agent
  roles、prompt shortcuts、project settings、Codex reset、新增/移除本地项目）。
  `backdropClassName` 保留给真正定制 backdrop 的场景，比如命令面板。

`machine-agent-settings.tsx` 缺失的动画：dialog 以 `open` 为 false 保持挂载，
一个 commit 后再打开（`useLayoutEffect`，使 `useTransitionStatus` 中
`mounted && !open` 能产生 `starting`)，并在 `onOpenChangeComplete(false)`
触发时才清掉 `dialogMode`/`dialogMachineId` —— 退出淡出期间 panel 内容保持
完整。`AgentConfigDialog` 保留自己的 `Dialog.Root` 和 reset-on-`open` effect,
挂载即重置的语义及其约 1500 行测试面不变；唯一新增的 prop 是
`onOpenChangeComplete` 透传。

被否掉的方案：只加 `forceRender`(backdrop 渲染了但仍在 z=70，压在父 panel
下不可见）；每个调用方各自改常驻挂载（之后每个新的嵌套 dialog 都会再踩一次，
suppression 是 Base UI 的默认行为）；挂载时用 `@keyframes` 做入场（等于引入
第二套与 transition 模型打架的动画机制）。

## 验证

`test/dialog.test.tsx` 断言嵌套 `Dialog.Root` 会产生两层 veil
（`[role="presentation"][data-open]` —— 排除 portal 内部用于外部点击检测的
inert backdrop);`test/drawer.test.tsx` 断言 backdrop 与 viewport 共享同一
层级。`NestedInSettings` story 改为点击打开 provider dialog，与产品流程一致，
入场动画可被真实触发。PR 中的 Playwright before/after 截图展示嵌套 veil 与
进行中的入场动画。story 里挂载即开的 dialog 仍会跳过 `starting` —— 这是上游
行为，现在只是静态渲染的怪癖，不再是线上路径。
