# 多仓库 Info Bar 选择单个仓库的 GitHub 上下文

Status: implemented
Translation: current

[English](2026-10-25-multi-repo-repository-context.md)

## 摘要

Project group 对话原本把仓库平铺展示，而 Info Bar 的 context stage、PR 标签页和
GitHub 操作始终只描述第一个 Member。于是多个当前 PR 看起来像“最后加载的那个”，
用户也无法在不离开对话的情况下查看另一个仓库。现在仓库面板按冻结的放置森林渲染
（子模块缩进在父仓库下），点击某一行即选中该仓库；context stage、diff 统计、PR
标签页和已有 PR 的操作随之描述这个 Member。选择是视图状态，默认仍使用旧的第一
Member 投影，且没有 GitHub remote 的本地目录不会借用其他 Member 的 PR。已用单元
测试、jsdom 测试和 Storybook 验证，尚未在打包后的桌面应用中端到端运行。

## 决定

- `buildSessionProjectMemberRows` 按先序输出：根 Member 按快照顺序排列，每个根
  后面紧跟它的子模块，并带上 `depth`、`parentId`、`hasChildren`。面板只按深度
  缩进，不引入第二套树模型；冻结快照仍是唯一事实来源。
- `sessionProjectMemberSelectionAtomFamily` 保存选中的 Member id，以 workspace
  所有者 Session 为键，因此子标签页和根对话描述同一个仓库。它和 Info Bar 的
  staged item 一样不持久化。
- 未选择时回退到旧的 `project` / `repoFullName` 投影。选中后，stage 使用该
  Member 的仓库、分支、路径、diff 和当前 PR；`null` 明确表示“这个 Member 没有
  GitHub remote”，与“使用旧默认值”区分开。
- PR 标签页、`useGitHubPrDetails`、Fix CI Errors、Resolve Conflicts、Ready for
  review 和 Merge 都跟随选中的 PR。Create PR 和 Commit & Push 仍以整个对话为
  范围，因为它们发送的 prompt 会发布所有有改动的 Member。
- 原地使用的 Member（`additional` / `link`）保留文件夹图标并清空 GitHub 身份，
  不把挂载路径伪装成可复制的宿主机路径。
- 否决方案：另做“全部 PR”视图。仓库面板已经列出每个 Member 及其当前 PR/CI，
  第二个列表会复制数据源，并把选择拆到两个界面。

## 证据

- `packages/components/tests/session-project-members.test.ts` 覆盖嵌套顺序、
  深度/父级字段和“选择 → 旧投影”回退。
- `packages/components/tests/session-project-members-chip.test.tsx` 覆盖缩进、
  标签、选择、关闭面板，以及点击 PR 时先选中所属仓库再打开。
- `packages/components/tests/session-github-state.test.ts` 覆盖选择某个 Member
  的 PR，以及为无 remote 的 Member 显式清空仓库。
- `SessionProjectMembersChip.stories.tsx` 在真实 Info Bar 上渲染嵌套列表和选中态。

## 验证与限制

类型检查和上述测试通过。面板尚未连接真实的多仓库 daemon 运行：超过合成 fixture
的子模块层级、非默认 Member 上的实时 CI 与 merge、以及移动端 popover 尺寸都还
没有端到端验证。
