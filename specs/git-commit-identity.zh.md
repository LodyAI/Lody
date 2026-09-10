# Git commit 身份

Status: draft
Translation: current

[English](git-commit-identity.md)

Lody 每轮依据机器所有权选择 host Session 的 Git identity，而不是 workspace 成员数或共享状态。
下述规则约束身份解析；已运行 ACP 的身份更新存在下面说明的限制。

当前轮次由机器 owner 发起时，Lody 优先使用 session worktree 中生效的 Git identity；
如果机器没有可用的 Git email，则使用 owner 经 Lody/GitHub 解析出的身份。当前轮次由
其他 workspace 成员发起时，Lody 只使用该请求者经 Lody/GitHub 解析出的身份，绝不读取
或回退到机器 Git identity。

缺失邮箱占位符不是可用身份。如果允许使用的机器身份和请求者解析身份都不可用，Lody
使用中性的 `LodyAI <agent@lody.ai>` 身份。最终选择的名字和邮箱会同时写入 Git author
与 committer 环境变量。GitHub 鉴权仍是独立的、绑定请求者的决策，不会改变 commit 对象
中的 author 或 committer。

切换请求者或 Git identity 不得触发 ACP 进程或 sandbox 重启，包括已 adopt 的预启动 session。
新身份会更新 host Session 配置，供此后经该配置启动的命令使用。已运行 ACP 仍持有启动时的
环境，其自行启动的 Git 命令可能继续使用旧身份。无重启的身份传播尚未实现。

## 证据

身份选择实现在 `apps/cli/src/session/git-identity.ts`。初次创建 session 时，
`apps/cli/src/session/session-manager.ts` 应用所有权策略；后续轮次由
`apps/cli/src/session/session-execution-service.ts` 重新应用。

本 draft 记录请求者已确认的策略。当前 worktree 的身份定向测试与 CLI typecheck 已通过；
已部署客户端的验收仍未验证。
