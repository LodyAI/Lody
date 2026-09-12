# 仅在 GitHub remote 上使用 GitHub no-reply commit 邮箱

Status: implemented
Translation: current

[English](2026-09-12-github-noreply-commit-email.md)

## 摘要

每一轮 session 都会把请求者解析出的 commit 身份写入 `GIT_AUTHOR_*`/`GIT_COMMITTER_*`，而这些环境
变量会覆盖 `~/.gitconfig`，因此 Lody 解析出什么，agent 的 commit 就带什么。Lody 此前解析的是存储
的账号邮箱；对于同时开启「邮箱保密」和「禁止命令行推送暴露邮箱」的账号，这恰好是 GitHub 会拒绝
的地址：每次推送 agent commit 都以 GH007 失败，用户无法交付成果。修复让账号的
`<id>+<login>@users.noreply.github.com` 地址胜出，但仅限于推送到 github.com 的 session 工作目录
——该地址在 GitLab 或 GitHub Enterprise 上无法归属、甚至可能被拒绝，所以这些仓库仍按 Git 配置与
账号邮箱的原有顺序解析。由于解析器按用户缓存、看不到工作目录，no-reply 地址现在与账号邮箱并列
上报，由工作目录的 remote 在两者之间选择；遗留限制是 `ssh.github.com` 之类的 host 不被识别为
GitHub，这些用户因此拿不到修复，但不会被破坏。

## 决策

两项事实不在同一处。`SessionUserResolver` 知道请求者的 GitHub 账号，但它跨所有 session 按用户缓存，
看不到工作目录；`resolveSessionGitIdentity` 每轮携带 session `cwd` 运行，却不知道账号信息。因此
no-reply 地址作为独立且有明确类型的值解析（`SessionUserProfile.githubNoreplyEmail`，以可选请求
字段 `userGitHubNoreplyEmail` 随该轮冻结传递），判断放在有 `cwd` 的地方。账号邮箱保留自身含义，
非 GitHub 场景的回退顺序因此保持不变，而不是被一个 GitHub 地址悄悄替换。

`resolveSessionGitIdentity` 最终的顺序是：

- github.com remote 且 GitHub account id 与 login 可用：使用 no-reply 地址，优先于机器 Git
  identity——对这些账号而言，正是机器 identity 会触发 GH007；
- 其余情况沿用既有策略——机器 owner：机器/仓库中生效的 Git identity，其次是请求者账号邮箱，最后是
  中性的 `LodyAI <agent@lody.ai>`；非 owner：请求者账号邮箱，其次是中性身份，绝不使用机器 owner
  的配置。

存在 `origin` 时只由 `origin` 决定 host：origin 指向 GitLab 的仓库不会因为多了一个 GitHub 镜像就
变成 GitHub 仓库。只有 `github.com` 与 `gist.github.com` 计入，因此排除 GitHub Enterprise 部署
（其账号 id 不同，也没有 `users.noreply.github.com` 归属）。push URL 优先于 fetch URL，因为被
GitHub 拒绝的是 push。每个分支都仍然导出 `GIT_*`：在 host Git 配置已存在时改为不注入，会让共享
daemon 上团队成员的轮次被署名为机器 owner，而这正是所有权策略要防止的。

两个替代方案被否决。让解析器继续选择 no-reply、再由 Git 层在非 GitHub 场景把它降级，无需新增管道，
但那时账号邮箱已经丢失，没有 Git 配置的 GitLab 用户会被署名为 `LodyAI` 而不是本人。在
`updateGitIdentity` 时重新解析请求者 profile 可以省去请求字段，但那是在冻结轮次之外重新读取身份，
[session 规则](../../../../apps/cli/src/session/AGENTS.md)禁止这样做。新增用户可见设置同样被否决：
在 github.com 上，对任何拥有 no-reply 的账号它都是正确选择；离开 github.com 它则根本是错的。

worktree 归档备份身份刻意保持不变：那是机器本地的记录，不是请求者署名。

## 证据与验证

`apps/cli/src/session/git-identity.ts` 承载 remote 判断与解析顺序，
`apps/cli/src/session/session-user-resolver.ts` 将该地址与账号邮箱并列上报。
`apps/cli/tests/git-identity.test.ts` 覆盖 https 与 ssh 的 GitHub origin、gitlab.com origin、
无 remote 的仓库、GitLab origin 背后的 GitHub 镜像、GitHub Enterprise host、不完整的 GitHub
profile，以及非 owner 与中性回退；其中最后三种场景通过真实临时仓库执行，从而真正跑过
`git remote -v` 与 `git config` 读取，并将继承的 `GIT_AUTHOR_*`/`GIT_COMMITTER_*` 环境变量置空，
使仓库配置成为答案来源。`apps/cli/tests/session-user-resolver.test.ts` 覆盖拆分后的字段。意图记录
在 `specs/git-commit-identity.md`（仍为 `draft`）。本修复所依赖的所有权策略见
[机器 owner Git identity 笔记](../feature/2026-09-08-machine-owner-git-identity.zh.md)。

`apps/cli` 全量测试通过，仅 `tests/worktree-gc.test.ts` 的既有 macOS `/private/var` 路径不匹配失败，
该用例在不含本次改动时同样失败。GH007 拒绝本身依据 GitHub 推送保护推导，并未在 CI 中实际执行，
因此针对私密邮箱账号的端到端验收仍未验证。
