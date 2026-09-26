# Agent Role 菜单行保持自身高度

Status: implemented
Translation: current

[English](2026-09-27-agent-role-menu-row-overflow.md)

## 摘要

Agent Role mention 菜单使用纵向 flex 容器时，禁用原因换行会把每行压回
28px 的最小高度，原因文字因此溢出到下一条 Role，目录看起来像全部叠在一起。
共享的 mention 行现在禁止 flex 收缩，由内容决定自身高度，达到上限后由菜单列表滚动。
这样保留了完整的原因文本，也同时修复窄屏和移动端菜单；由于当前工作区没有安装依赖，
运行时验证仍受限。

## 决策

`MentionItem` 行是有高度上限的 `styles.list` 列的子项。此前虽然声明了
`min-height: control.small`，但仍保留默认的 `flex-shrink: 1`。flex 布局会把带换行副标题
的行压到最小高度，文字随后溢出。`mention-surface.ts` 现在设置 `flexShrink: 0`，让列表
滚动更多行，而不是压缩行内内容。

截断可用性原因会隐藏禁用行本来要说明的诊断信息；固定行高也会在其他换行内容上复现问题，
因此没有采用这两种方案。

## 证据与验证

- 报告截图中的每条 Role 都有两行“不可用”原因，后续名称进入前一条原因的第二行。
- 受影响的布局是桌面弹出菜单和停靠式移动菜单共用的 `MentionItem` surface。
- 已有的 `AgentRoleAvailabilityNarrow` Storybook story 覆盖带换行禁用原因的场景，继续作为视觉回归夹具。
- `mention-two-level-menu.test.tsx` 会渲染一条长禁用原因，并断言真实行计算出的
  `flex-shrink` 为零。
- 编辑前已运行 `node scripts/docs/main.mjs status`。当前检出没有安装依赖，因此未运行
  完整的包测试。
