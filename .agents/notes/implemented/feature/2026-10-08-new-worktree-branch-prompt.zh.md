# 在首次任务前提示 Agent 为新 Worktree 分支命名

Status: implemented
Translation: current
PR: [#1321](https://github.com/LodyAI/Lody/pull/1321)

[English](2026-10-08-new-worktree-branch-prompt.md)

## 摘要

Provider 自行推送标题后，Lody 移除了独立命名进程，但已有的 GitHub 提示只要求
按任务命名分支，没有明确要求执行改名，本地 Worktree 也没有收到这一指导。
普通新建的独立 Worktree 会话现在会提示 Agent 检查当前分支，在首次任务开始前
重命名分配的临时分支。现有 Git 观测负责发布结果；执行仍依赖模型遵循提示，
不是宿主强制改名，Fork 不在本次范围内。

## 决策

将不依赖 Provider 的首次任务 Worktree 指导与 GitHub 专用提示拆开。执行层仅对
没有父会话、没有既有 ACP 会话 ID、没有明确恢复请求的 GitHub／本地 Worktree
会话启用指导。按逻辑首次使用判断，因此采用预创建 Worktree 时收到相同要求，
不用在提示词路径增加文件系统检查。共享父目录的子标签页、直接目录、后续回合
和独立的 Fork 流程排除在外，不新增持久化标志或公共协议字段。

Agent 检查当前引用是否仍为 Lody 分配的 `session/<id>` 或 `lody/<id>` 分支，
包含碰撞后缀。已有描述性分支保留，以不含敏感输入的简短任务摘要命名，名称
冲突时不强制替换，改名失败则说明情况并继续任务。已有的 GitHub 改名指导仍
属于 GitHub 专用上下文；标题通知从不触发改名。

这延续了 [ACP 自有标题决策](../architecture/2026-09-08-acp-owned-session-titles.zh.md)
中的 Agent 指导方案，不替代该决策移除不安全宿主提示词到引用派生的结论。
等待标题或恢复独立分支生成器会重新引入该记录中的时序与归属问题。
[分支约定](../../../../specs/workspace-branch-state.zh.md) 记录当前意图，
[分支观测](../bug-fix/2026-09-24-workspace-branch-observation.zh.md) 仍负责元数据。

首次任务上下文在共享执行输入解析器运行前完成组合，遵循
[冻结执行输入决策](../architecture/2026-10-08-frozen-turn-execution-input.zh.md)。
这样在添加分支指导时仍保留已接受的 Config／Role 指令及结构化附件。
回归测试检查 Provider 实际收到的三类内容，并保留创建、继续和恢复路径的持久化回合重试测试。

## 验证与限制

执行测试检查实际发送给 ACP 的提示词块，覆盖新 GitHub／本地 Worktree、直接
本地目录、子标签页、既有会话及明确恢复请求，并分别测试 Provider 是否自有
标题生成能力。提示词组合覆盖任务引用与反馈上下文；附件测试检查 Agent 最终
收到的内容。真实临时 Git Worktree 测试执行分支改名，验证所属会话元数据更新
及 Detached HEAD 后的保留行为。

合并 `main` 后的验证：执行服务、提示词辅助函数、Git 观测、共享执行输入、
选取的 Worktree 采用测试、准备退休与冷会话文件预览共 239 项不同测试通过。
执行矩阵检查下一回合只收到新输入。最终 CLI 类型检查、`pnpm check:quick`
（类型感知 lint、i18n 及仓库边界）、根 `pnpm format`、范围内格式检查和
`pnpm run docs check` 通过。依赖按冻结的根锁文件安装，子模块检出合并后的固定版本。

全仓 `pnpm check` 通过工作区类型检查和 lint，但在无关的原生递归 SSH 子模块
用例（`github-git-transport.test.ts`）处停止：Lody Git 包装器返回
`context_unreadable`；[冻结输入验证记录](../architecture/2026-10-08-frozen-turn-execution-input.zh.md)
也记录了这一限制。CLI 共 3530 项通过、1 项失败、4 项跳过，完整流水线未完成。
该次执行早于最终基线刷新；刷新后重跑了受影响的执行／准备／文件预览套件、
CLI 类型及静态／边界检查。确定性测试不能证明模型遵循要求。
本次未调用真实 Claude／Codex，也未进行桌面界面冒烟测试。
