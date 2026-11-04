# 侧栏默认隐藏分支详情

Status: implemented
Translation: current

[English](2026-10-19-sidebar-branch-details-off-by-default.md)

## 摘要

侧栏的 `Show Branch` 偏好最初默认开启，以保留 Workspace 行原有的布局。现在，新安装或尚无保存值时默认关闭分支详情，避免用户未选择时行内就多出第二行。用户已保存的选择保持不变。在 Workspace 模式下，分支与相对时间共用同一条次级信息行，因此默认关闭也会隐藏该行。

## 决定

- `sidebarShowBranchNamesAtom` 保持原存储键，默认值改为 `false`。
- `LoroSidebar`、`SidebarFilterPopover` 的直接属性默认值及对应 Storybook 示例也改为隐藏分支详情。
- 不迁移或覆盖已保存的 `true`/`false`；此改动只影响尚无显式偏好的情况。
- 该偏好继续控制 Updated 模式的分支段，以及 Workspace 模式合并显示的分支/时间行。

这项决定取代[侧栏行详情说明](2026-10-18-sidebar-row-details-group.zh.md)中的“默认开启”；此前的理由和行为记录仍保留。

## 证据

- 持久化偏好为 `packages/components/src/atoms/sidebar-state.ts` 中的 `sidebarShowBranchNamesAtom`。
- `LoroAppSidebar` 在 Workspace 和 Updated 行中读取该值，并传给 Details 开关。

## 验证与限制

- 不包含 `LoroSidebar.stories.tsx` 时，对实现文件、测试和 `SidebarFilterPopover` Story 运行的 `oxlint` 通过，另有 21 条无关警告。包含 `LoroSidebar.stories.tsx` 时，第 1144 行会报告一处无关的 hook 依赖错误。
- 未运行测试。组件类型检查仍在 `loro-sidebar.tsx` 和 `home-week-usage.ts` 报错，这些错误不属于本次偏好变更。
- 文档检查仍报告工作区其他位置的 `subagent-events` 断链和超长 `AGENTS.md`。
