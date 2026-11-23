# owner 的 Git 身份交给 Git 解析

Status: implemented
Translation: current

[English](2026-11-16-native-owner-git-identity.md)

## 摘要

此前 Lody 每轮都把选定身份导出为 `GIT_AUTHOR_*`/`GIT_COMMITTER_*`。这些变量优先于所有
Git 配置层级，所以 owner 在仓库里设置的 `user.email` 或 `includeIf` 身份永远不会进入提交；
用户级配置为空时则一律变成 LodyAI。顺序也不符合 owner 的意图：未批准的非 owner 会用其账户
邮箱提交；owner 开启 "Act as you" 也不生效，因为 owner 的派发资料是占位身份（#1451 第二点）。
现在的顺序是：owner 的仓库身份，然后是已批准的请求者，然后是 owner 其他原生 Git 身份，
最后是 LodyAI。只有已确定的
身份才设置环境变量，owner 自己的配置因此成为真正的回退，而不是被覆盖。

## 决定

- owner 轮次中，若 workdir 所在仓库（仓库或 worktree 层级，且不是 Lody 管理的共享 clone）
  配置了身份，即使批准了 "Act as you" 也保留该身份：按项目的身份比账户级批准更具体。
  非 owner 的轮次绝不使用它。
- 已批准的请求者（含 owner）导出其账户身份。对 owner，`SessionManager` 进行一次受 3 秒策略
  期限约束的账户查询；失败时本轮保留本地身份。
- 否则在 Session workdir 中用 `git config --show-scope --get-regexp` 探测 owner 身份。可用时
  交给 Git，不导出任何变量。若 Git 只有 email 没有名字，则导出该身份并以 email 作为名字，
  沿用此前规则，而不是让 Git 从系统账户猜测。
- 只有当 workdir 的 common 目录是 `<data dir>/repos/<repoId>/bare.git` 时，才不信任仓库或
  worktree 层级。这个共享 GitHub clone 正是之前被 agent 污染的配置
  （[2026-09-30 说明](2026-09-30-github-personal-identity-silent-fallback.zh.md)）。此时导出
  owner 的用户级身份（[XDG 读取](2026-10-12-xdg-git-identity.zh.md)，在 workdir 中求值以使
  条件 include 生效），否则导出 LodyAI。本地项目及其 worktree 共享用户自己的仓库配置，
  属于 owner 的选择。
- 非 owner 绝不读取机器身份
  （[所有权边界](../feature/2026-09-08-machine-owner-git-identity.zh.md)）；未批准时使用 LodyAI。

## 备选方案

通过 `GIT_CONFIG_SYSTEM` 提供最低优先级的回退层可以跟踪之后的配置变化，但替换 system 文件会
丢失 `/etc/gitconfig`，而 Xcode 和 Git for Windows 的 system 路径各不相同。`EMAIL` 变量只对
email 是真正的回退，Git 没有对应的名字变量。每次解析身份时探测一次，既保留 Git 自身的优先级，
又不需要上述两者。

## 限制

探测发生在解析身份时。Project 组的 workdir 不是仓库，因此其中 GitHub 成员的共享 clone 配置
不会被判为不可信。未导出环境变量时，agent 自己执行 `git config user.email` 会改变该 Session
之后的提交；下一次 Session 启动会再次识别共享 clone 身份。已运行的 ACP 仍保留启动时的环境，
与之前相同。

## 验证

`apps/cli/src/session/git-identity.test.ts` 中的真实 Git fixture 覆盖：仓库和 `includeIf`
身份交给 Git、被污染的托管 clone 被替换为用户级身份，以及批准矩阵。
`apps/cli/tests/git-identity.test.ts` 覆盖有界的 owner 查询。
