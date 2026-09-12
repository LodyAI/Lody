# Git commit 身份

Status: draft
Translation: current

[English](git-commit-identity.md)

Lody 每轮依据仓库的 remote host 与机器所有权选择 host Session 的 Git identity，而不是 workspace
成员数或共享状态。下述规则约束身份解析；已运行 ACP 的身份更新存在下面说明的限制。

只有当 session 工作目录推送到 github.com、且请求者账号同时带有 GitHub account id 与 login 时，
GitHub no-reply 地址 `<id>+<login>@users.noreply.github.com` 才作为请求者的 commit 邮箱，
并优先于其余所有候选。该地址把 commit 归属到同一个 GitHub 账号，并且对于开启了邮箱保密、
且禁止命令行推送暴露邮箱的账号，它是唯一被接受的地址。Lody 读取工作目录的 Git remote 来判断：
存在 `origin` 时只由 `origin` 决定，否则任意 remote 均可，且只有 `github.com` 与
`gist.github.com` 算作 GitHub。其他任何 host（包括 GitHub Enterprise 部署）都按下文规则解析，
因为 GitHub no-reply 地址在那里无法归属，甚至可能被拒绝。

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

身份选择与 remote host 判断实现在 `apps/cli/src/session/git-identity.ts`，请求者的 Lody/GitHub
身份解析实现在 `apps/cli/src/session/session-user-resolver.ts`。初次创建 session 时，
`apps/cli/src/session/session-manager.ts` 应用所有权策略；后续轮次由
`apps/cli/src/session/session-execution-service.ts` 重新应用。

本 draft 记录请求者已确认的策略。当前 worktree 的身份定向测试与 CLI typecheck 已通过；
已部署客户端的验收仍未验证。
