# 本地项目使用原生 GitHub 认证

Status: implemented
Translation: current

[English](2026-09-29-local-project-native-github-auth.md)

## 摘要

本地项目此前也会加入 Lody 命令凭据 broker，覆盖用户预期使用的现有 Git 与 GitHub 登录。
现在本地目录及其 worktree 跳过托管凭据初始化，即使已知其 GitHub remote 也一样。
刷新只轮换已注册会话的上下文，避免同一工作区其他托管会话存在时重新注入本地会话。
托管 GitHub 项目保持原有策略；已经运行的 Agent 进程需要重新创建才能获得新的启动环境。

## 决策与证据

本次收窄[按命令选择 GitHub 凭据](../architecture/2026-09-26-github-command-credentials.zh.md)的适用范围，
不改变其目标仓库选择。以 `project.kind` 为准，而不是是否有 GitHub 元数据或 `useWorktree`。
`SessionManager.prepareGitHubRepoSessionConfig` 提前返回，同时覆盖冷启动和预准备启动。
现有本地宿主 worktree 路径已经跳过 broker 认证。
`GitCredentialBroker.refreshSessionContext` 只轮换已注册上下文。
因此保留原生 token 环境变量、helper 配置、SSH 和 shell 设置，不再让本地命令经过托管偏好与降级检查。

现有 session-manager 测试集新增两种本地项目模式，覆盖 GitHub 元数据、原生环境保留，
以及已有另一托管会话时的请求者切换。托管上下文测试使用真实 broker 验证 token 轮换。
当前 checkout 缺少依赖，`vitest` 不可用，因此测试尚未执行；未声称完成真实 GitHub 或钥匙串验证。
参见[更新后的规格草案](../../../../specs/github-command-credentials.zh.md)。

PR：[#1117](https://github.com/LodyAI/Lody/pull/1117)。
