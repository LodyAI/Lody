# CollapsibleSection 回到 form-primitives,落在 StyleX 上

Status: implemented
Translation: current

[English](2026-09-24-form-primitives-collapsible-section.md)

## 摘要

把 `origin/main` 合入 flat-material 分支时,上游新增的 `PiExtensionsField` 依赖
`settings/form-primitives.tsx` 里的共享 `CollapsibleSection`,而本分支已删除该原语,
并在 `agent-config-dialog.tsx` 内长出了一个 prop 契约完全相同的局部 `Section`
(title、count、action、disabled hint、default-open)。本次合并把对话框里的 StyleX
ruled-row 实现搬进 `form-primitives.tsx` 作为共享的 `CollapsibleSection`,并把
`PiExtensionsField` 改写到 `@lody/ui` 栈上,使对话框的可选设置块与新字段共用同一套
ruled-row 语法,而不是两份副本各自漂移。

## 决策

`agent-config-dialog.tsx` 的局部 `Section` 与上游 `form-primitives.tsx` 的
`CollapsibleSection` 是同一组件的两个名字。两者并存正好会重建 `form-primitives`
要防止的漂移(其文档注释原话:每个编辑器各抄一份,本该一致的对话框就是这样一点点
散开的)。共享实现采用本分支结构——`sectionItem` 分隔线行、chevron 位于头部 action
之后;而上游基于已不存在的 Tailwind `@/ui/*` 原语编写的 `PiExtensionsField`,改用
`@lody/ui` 的 Checkbox/Input/Button/Spinner 与 StyleX tokens 重写。

其余合并取舍,供审查合并的人核对:

- `ui/menu-styles.ts` 整体保留我方版本:上游的 Tailwind 导出
  (`menuSurfaceClassName`、`menuItemClassName` 等)在菜单都换成 `@lody/ui`
  复合组件后没有任何消费方,它描述的按主题边缘混色现在由 `popup.separator` 承担。
- `ai-gui/view.tsx` 保留我方精简版 `PermissionRequestBlock`;只移植了上游为
  `PlanPanel` 埋点新增的 `sessionId` 透传。
- `web-archive-screen.tsx` 采用上游的 `windowsCaptionRowPadClass`,但用
  `bottomBorder: false`——扁平化 header 没有底边,针对边框的中线补偿不适用。

## 验证边界

已通过全 workspace 的 `tsc`/`tsgo`、受影响区域的四个 vitest 文件(103 个用例)、
i18n 检查与边界守护验证。`PiExtensionsField` 重写后的视觉效果,以及无边框 header 上
Windows caption pad 的表现,未做渲染级核对。
