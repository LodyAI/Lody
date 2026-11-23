# Git commit 身份

Status: draft
Translation: current

[English](git-commit-identity.md)

Lody 每轮依据请求者的批准和机器所有权选择 host Session 的 Git identity，而不是 workspace
成员数或共享状态。优先级为：

1. 由机器 owner 发起的轮次，session workdir 所在仓库自身配置的身份（仓库或 worktree 配置）；
2. 请求者本人的 Lody/GitHub 身份，仅当该请求者批准了 "Act as you"；
3. 由机器 owner 发起的轮次，Git 自身在 session workdir 中解析出的其他身份；
4. 中性的 `LodyAI <agent@lody.ai>` 身份。

仓库身份是 owner 针对该项目最具体的选择，因此也优先于 owner 自己的 "Act as you" 批准。

只有 Lody 已经确定身份时（已批准的请求者、LodyAI，或下文所述的替换），才会把它导出为
Git author 与 committer 环境变量。这些变量会覆盖所有 Git 配置层级，因此除此之外 owner
自己的配置交给 Git 处理：仓库与 worktree 配置、条件 include、用户级配置和 daemon 环境，
都和直接运行 `git commit` 时一样生效。例外是 Lody 管理的共享 GitHub clone 的仓库配置：
agent 可以写入它，且该仓库的所有 Session 共享它，所以来自它的身份会被替换为 owner 的
用户级身份，或 LodyAI。

其他 workspace 成员发起的轮次绝不读取或回退到机器 Git identity。未批准时使用 LodyAI，
请求者的账户邮箱不会进入 commit。owner 的派发资料是占位身份，因此已批准的 owner 轮次会
进行一次有界的账户查询；失败时本轮保留 owner 的本地身份。

云端用户资料查询最多等待 60 秒。失败或超时后，本轮使用占位身份，并最终回退为中性
Git 身份；下一次查询可以重试。晚到的结果不得覆盖更新的缓存。机器授权和 GitHub 凭据
仍是独立检查，不会因资料查询兜底而跳过。

缺失邮箱占位符不是可用身份。GitHub 鉴权仍是独立的、绑定请求者的决策，不会改变 commit
对象中的 author 或 committer。

切换请求者或 Git identity 不得触发 ACP 进程或 sandbox 重启。
新身份会更新 host Session 配置，供此后经该配置启动的命令使用。已运行 ACP 仍持有启动时的
环境，其自行启动的 Git 命令可能继续使用旧身份。无重启的身份传播尚未实现。

## 证据

身份选择实现在 `apps/cli/src/session/git-identity.ts`。初次创建 session 时，
`apps/cli/src/session/session-manager.ts` 应用所有权策略；后续轮次由
`apps/cli/src/session/session-execution-service.ts` 重新应用。

本 draft 记录请求者已确认的策略；批准优先级和 owner 原生配置的理由见
[原生身份说明](../.agents/notes/implemented/bug-fix/2026-11-16-native-owner-git-identity.zh.md)。有界查询的验证情况记录于
[实现说明](../.agents/notes/implemented/bug-fix/2026-09-16-bounded-session-user-identity.zh.md)；
已部署客户端的验收仍未验证。
