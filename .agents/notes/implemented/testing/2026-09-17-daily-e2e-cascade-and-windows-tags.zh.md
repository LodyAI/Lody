# 修复 Desktop Daily：过期的归档 journey 与 Windows 标签引号

Status: implemented
Translation: current

[English](2026-09-17-daily-e2e-cascade-and-windows-tags.md) | 中文

## 摘要

Desktop Daily 失败 Issue #507 的每条 comment 对应一次失败运行，背后是两个
独立缺陷。`LODY-SESSION-004` 仍在断言 #663 之前的 containment-only 归档
契约，因此当归档开始沿 opened-by 链接级联后确定性失败；该场景现在端到端
验证级联契约。另一方面，Windows 分支从未执行任何场景，因为 `e2e` 包脚本
用单引号包裹 Cucumber 标签表达式，而 pnpm 的 `cmd.exe` 脚本 shell 不做
分组；两个套件脚本已改用双引号。两个缺陷都不涉及产品代码。

## 证据

Daily 运行 [35193489771](https://github.com/LodyAI/Lody/actions/runs/35193489771)、
[35067864414](https://github.com/LodyAI/Lody/actions/runs/35067864414) 和
[34940772254](https://github.com/LodyAI/Lody/actions/runs/34940772254) 均在
ubuntu 和 macOS 上失败于 `LODY-SESSION-004` 的 `archiveRelationRoot`：该
journey 期望 opened Sessions 在根归档后保持活跃，但
[归档后代决策](../bug-fix/2026-09-13-session-archive-descendants.zh.md)与
修订后的[关系 Spec](../../../../specs/session-relations.md)会归档 child
Tab 与两个 opened Sessions。同一批运行显示 Windows 分支在 Cucumber 解析
标签之前就失败：`cmd.exe` 把 `'@P0 or @P1'` 拆成三个参数，Cucumber 将
`or` 和 `@P1'` 当作 feature 路径读取并以 `ENOENT ... e2e\@P1'` 退出。
因此 Windows 在所有已记录的 Daily 中贡献的场景覆盖为零。

## 决策

`SessionRelationLifecyclePage` 现在断言当前契约而非已废止的契约：

- `archiveRelationRoot` 期望根行与两个 opened Session 行一起离开活跃侧栏、
  四条元数据全部归档，且 opened Sessions 的 agent 进程与 worktree 被释放
  —— 每个已归档 Session 保持其原有的拆解行为。
- `permanentlyDeleteRelationRoot` 保持 containment 范围：仅根与直接 child
  Tab 被移除，opened Sessions 保持归档并继续列于 Archive。
- `expectDanglingProvenanceAndCleanup` 仍验证已删除 opener 卡片可见且不可
  导航，随后直接从各自的 Session 路由删除每个已归档的幸存 Session。

Gherkin 检查点不再声称 worktree 保留 —— worktree 由归档回收，而非由随后
的删除 —— journey registry 行记录了级联检查点并重新计算了 fingerprint。

`full` 与 `smoke` 脚本改用双引号包裹 `--tags`，POSIX shell 与 pnpm 的
`cmd.exe` 脚本 shell 都能正确分组。根 `package.json` 中已有双引号脚本
参数的先例。

## 验证与限制

`pnpm --filter @lody/e2e check` 通过：套件契约（22 个场景、id 匹配）、
Cucumber dry-run、类型检查与脚本单元测试。`journey:coverage` 已从更新后
的 registry 行重新生成 `COVERAGE.md`。修复后的 journey 与 Windows 脚本
路径未在本地执行；两者都需要已构建的桌面端与一次真实 Daily 分支来确认
转绿。同一批运行中出现的两个间歇失败 —— `LODY-COPY-001` 在 macOS 上
“存在但隐藏”的消息文本，以及 `LODY-MCP-001` 在 ubuntu 上的空 MCP 启动
选择 —— 在 35193489771 中未复现，仍属待观察的 flake。
