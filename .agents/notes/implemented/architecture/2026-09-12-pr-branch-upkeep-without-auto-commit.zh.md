# 用提示与 UI 信号取代回合结束的自动 commit

Status: implemented
Translation: current

[English](2026-09-12-pr-branch-upkeep-without-auto-commit.md)

## 摘要

机器曾在回合结束探测脏工作区，驱动 Agent 执行额外的 commit/push 回合——真实的 ACP
prompt，消耗 token 并提交用户未决定保留的工作。该义务改由 Create PR 提示承担（可被
对话覆盖），两个标志兜底：仍有未发布工作时 Info Bar 把 `Commit & Push` 排最前。提示
弱于钩子，风险是 Agent 忽略它；排序让这种情况可见而非被静默纠正。

## 决策

- **Commit & Push 优先于冲突修复、CI 修复与 Merge**：三者都作用于已推送的 head，
  未发布的工作让它过期。被降级的 Merge 因此不能再被 overflow 过滤掉。
- **两个标志而非一个**：`workspaceDirty` 在提交瞬间即为 false，推送失败则让 PR head
  落后。第一版只有它，比旧行为更糟：被删的循环原有第二阶段处理这点。
  `workspaceUnpushed` 用本地 `git rev-list @{u}..HEAD`；轮询器剥掉 `headCommitSha`，
  无法改用 PR head。
- **两条取消路径都刷新**：prompt 执行中按停止走不到 `finalizeTurn`，只覆盖一条会漏掉最常见场景。

## 局限

探测不确定时不写入 key，不会出现过期的 `false`。回合抛错或无 GitHub 仓库时不刷新。
Agent 遵守提示的程度未验证。
