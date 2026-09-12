# 请求者 commit 邮箱优先使用 GitHub no-reply 地址

Status: implemented
Translation: current

[English](2026-09-12-github-noreply-commit-email.md)

## 摘要

每一轮 session 都会把请求者解析出的 commit 身份写入 `GIT_AUTHOR_*`/`GIT_COMMITTER_*`，
而这些环境变量会覆盖 `~/.gitconfig`，因此 Lody 解析出什么，agent 的 commit 就带什么。
此前解析器优先使用存储的账号邮箱，只有在邮箱是缺失占位符时才回退到 GitHub no-reply 地址；
对于同时开启「邮箱保密」和「禁止命令行推送暴露邮箱」的账号，这个真实地址会让 GitHub 以
GH007 拒绝每一次 agent commit 的推送，用户无法交付成果。修复只反转这一处优先级：只要
profile 同时带有 GitHub account id 与 login，请求者的 commit 邮箱就是
`<id>+<login>@users.noreply.github.com`，仅在拿不到这对值时才使用账号邮箱。权衡是：邮箱本
就公开、并期望它出现在 commit 对象上的用户，现在会看到 no-reply 地址；由于 GitHub 把两者
归属到同一账号，署名归属不变。

## 决策

只要存在 GitHub no-reply 地址，它就是严格更优的 commit 邮箱：它把 commit 归属到之后开 PR
的同一个 GitHub 账号，不会被私密邮箱推送保护拒绝，也不会公开用户选择保密的地址。存储的账号
邮箱并不提供 no-reply 没有的能力，所以旧的优先级只是用一次能成功的推送换一个更好看的地址。

改动限定在 `SessionUserResolver.toSessionUserProfile`。`git-identity.ts` 中的所有权策略保持不变：

- 机器 owner：机器/仓库中生效的 Git identity，其次是本文解析出的身份，最后是中性的
  `LodyAI <agent@lody.ai>`；
- 非 owner 请求者：本文解析出的身份，其次是中性身份。

两个替代方案被否决。当 host 的 `user.email` 已配置时干脆不导出 `GIT_*`，会让远程或多用户
daemon 把团队成员的轮次署名成机器 owner，而这正是所有权策略要避免的情况。新增用户可见设置
同样被否决：对任何拥有 no-reply 地址的账号来说它都是正确选择，没有可配置的余地。

worktree 归档备份身份刻意保持不变：那是机器本地的记录，不是请求者署名。

## 证据与验证

优先级实现在 `apps/cli/src/session/session-user-resolver.ts`；
`apps/cli/tests/session-user-resolver.test.ts` 覆盖了「真实账号邮箱 + 完整 GitHub profile 解析为
no-reply 地址」「GitHub profile 不完整时保留账号邮箱」以及原有的占位符与回退路径。意图记录在
`specs/git-commit-identity.md`（仍为 `draft`）。本修复所依赖的所有权策略见
[机器 owner Git identity 笔记](../feature/2026-09-08-machine-owner-git-identity.zh.md)。

验证手段是 CLI 单元测试与 typecheck；GH007 拒绝本身依据 GitHub 推送保护行为推导，并未在 CI 中
实际执行，因此针对私密邮箱账号的端到端验收在此仍未验证。
