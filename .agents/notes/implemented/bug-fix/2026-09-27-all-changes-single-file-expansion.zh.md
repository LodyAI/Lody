# All Changes 只展开选中的文件

Status: implemented
Translation: current

[English](2026-09-27-all-changes-single-file-expansion.md)

## 摘要

从 All Changes 列表打开一个文件时，所有变更文件的 diff 卡片都会展开，用户必须先扫过
无关文件才能看到选中的文件。现在 base diff 面板使用聚焦的工作区路径决定初始展开状态：
选中的卡片展开，其余卡片折叠；没有聚焦文件的 base 面板则全部折叠。会话历史和 turn diff
继续保持原有的全部展开行为，用户仍可手动展开任意折叠的 base 卡片。

## 决定与证据

- `SessionConversationDiffPanel` 在选择列表行时已经传递 `focusFilePath`，但
  `DiffFileBlock` 给每个 `DiffViewer` 都传了 `defaultOpen`，因此聚焦路径只影响加载和滚动，
  没有影响卡片的可见状态。
- `shouldOpenDiffFileByDefault` 在面板边界应用这个区分，并复用路径等价判断，因此
  `./src/file.ts` 和 `src/file.ts` 会选中同一张卡片。
- 每张卡片的 `DiffViewer` key 包含 base／conversation 模式和展开状态。当在同一个 diff 标签
  中把焦点切换到另一文件时，原卡片会重新挂载为折叠，新目标会重新挂载为展开；普通的折叠／
  展开点击仍只影响各自卡片。

本次没有改变 diff 数据加载或文件选择契约。

## 验证

聚焦的面板策略测试共 9 项并全部通过，覆盖有无 focus 的 base 模式、conversation 模式以及
等价路径写法。组件类型检查、Oxfmt、Oxlint、`git diff --check` 和 `pnpm run docs check`
均已通过。未运行完整仓库测试套件和桌面运行时。
