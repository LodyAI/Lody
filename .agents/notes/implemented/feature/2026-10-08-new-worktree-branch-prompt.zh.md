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

## 验证与限制

执行测试检查实际发送给 ACP 的提示词块，覆盖新 GitHub／本地 Worktree、直接
本地目录、子标签页、既有会话及明确恢复请求，并分别测试 Provider 是否自有
标题生成能力。提示词组合覆盖任务引用与反馈上下文；附件测试检查 Agent 最终
收到的内容。真实临时 Git Worktree 测试执行分支改名，验证所属会话元数据更新
及 Detached HEAD 后的保留行为。

验证结果：执行服务、提示词辅助函数与 Git 观测套件共 174 项测试通过；另外选取
的三项 SessionManager 测试通过，覆盖预创建 Worktree 的采用、重试和已消失
目录的重建。执行测试矩阵还检查新 Worktree 首次任务后的下一轮只收到新输入。
CLI `pnpm run typecheck`、范围内类型感知 lint（无错误）、根 `pnpm format`、
范围内格式检查及 `pnpm run docs check` 通过。验证复用了根锁文件完全一致的
本机依赖，并从本机克隆初始化了固定版本子模块。

不完整的缓存依赖使全仓 `pnpm check` 无法完成：初次验证在 site-docs 缺少
`fumadocs-mdx` 处停止，准备 PR 时复用的缓存已不可用，又在 ACP 构建缺少
`@tsconfig/node22` 处停止，不记为通过。确定性测试不能证明模型遵循要求。
本次未调用真实 Claude／Codex，也未进行桌面界面冒烟测试。
