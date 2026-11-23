# 有明确焦点的 diff 只展开选中的文件

Status: implemented
Translation: current

[English](2026-09-27-all-changes-single-file-expansion.md)

## 摘要

从 Changes 列表或会话 turn 中打开一个文件时，所有文件的 diff 卡片都会展开，用户必须先扫过
无关文件才能看到选中的文件。现在有明确文件焦点的 base（All Changes）和 turn diff 都只展开
选中的卡片，其余卡片折叠。没有焦点的 base 面板全部折叠；没有文件焦点的直接 turn diff 保持
原有的全部展开行为。Changes 的 Types 列表同时在文件名下显示父级工作区路径，避免同名文件
无法区分。用户仍可手动展开任意折叠的卡片。

## 决定与证据

- `SessionConversationDiffPanel` 在选择文件行时已经传递 `focusFilePath`，但
  `DiffFileBlock` 给每个 `DiffViewer` 都传了 `defaultOpen`，因此聚焦路径只影响加载和滚动，
  没有影响卡片的可见状态。第一次修复只覆盖 base 模式，带焦点的 turn diff 仍然全部展开；
  现在两个模式统一使用这个策略。
- `shouldOpenDiffFileByDefault` 在面板边界应用这个区分，并复用路径等价判断，因此
  `./src/file.ts` 和 `src/file.ts` 会选中同一张卡片。
- Changes 的 Types 行保留文件名作为主标签，并把父级路径作为次级行显示；完整路径仍保留在
  行的 title 中，便于悬停或辅助技术查看。
- 每张卡片的 `DiffViewer` key 包含 base／conversation 模式和展开状态。当在同一个 diff 标签
  中把焦点切换到另一文件时，原卡片会重新挂载为折叠，新目标会重新挂载为展开；普通的折叠／
  展开点击仍只影响各自卡片。

本次没有改变 diff 数据加载或文件选择契约。

## 验证

聚焦的面板策略测试共 9 项并全部通过，覆盖 base 和 conversation 的有焦点状态、无焦点默认状态
以及等价路径写法。组件 `tsgo --noEmit`、Oxfmt、Oxlint 和 `git diff --check` 已通过；类型检查和
定向测试是在临时初始化并构建所需 ACP 子模块后运行的，随后已将 checkout 恢复为原本的未初始化
状态。已尝试直接运行 docs check，但仍被未初始化 ACP 子模块中的既有 broken links 阻塞。未运行完整
仓库测试套件和桌面运行时。
