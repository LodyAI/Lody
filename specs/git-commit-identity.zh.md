# Git commit 身份

Status: draft
Translation: current

[English](git-commit-identity.md)

每一轮 Agent 执行 Git 命令前，Lody 都会选择 Git commit 身份。选择条件依据机器所有权，
而不是 workspace 成员数或机器共享状态，因此共享状态变化不会让其他请求者继承机器
owner 的身份。

当前轮次由机器 owner 发起时，Lody 优先使用 session worktree 中生效的 Git identity；
如果机器没有可用的 Git email，则使用 owner 经 Lody/GitHub 解析出的身份。当前轮次由
其他 workspace 成员发起时，Lody 只使用该请求者经 Lody/GitHub 解析出的身份，绝不读取
或回退到机器 Git identity。

缺失邮箱占位符不是可用身份。如果允许使用的机器身份和请求者解析身份都不可用，Lody
使用中性的 `LodyAI <agent@lody.ai>` 身份。最终选择的名字和邮箱会同时写入 Git author
与 committer 环境变量。GitHub 鉴权仍是独立的、绑定请求者的决策，不会改变 commit 对象
中的 author 或 committer。

ACP 进程会在启动时快照环境。如果复用 session 时有效 Git identity 发生变化，Lody 必须在提交
下一个 prompt 前在内部终止旧进程，并使用新环境恢复同一个 ACP session；这个替换不得发布
session termination 生命周期，也不得把该 prompt 提交给旧进程。identity 未变化时无需重启。
这个规则同样适用于 identity 快照已过期、但已经 adopt 的 speculative preparation。

## 证据

身份选择实现在 `apps/cli/src/session/git-identity.ts`。初次创建 session 时，
`apps/cli/src/session/session-manager.ts` 应用所有权策略；后续轮次由
`apps/cli/src/session/session-execution-service.ts` 重新应用。

本 draft 记录请求者已确认的策略。当前 worktree 的身份定向测试与 CLI typecheck 已通过；
已部署客户端的验收仍未验证。
