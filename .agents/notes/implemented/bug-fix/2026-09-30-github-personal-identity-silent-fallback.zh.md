# 说明个人 GitHub 身份降级原因，并停止读取共享 bare 仓库的身份

Status: implemented
Translation: current

[English](2026-09-30-github-personal-identity-silent-fallback.md)

## 摘要

启用"以我身份操作"后，在没有本地 GitHub 凭据的机器上，会话仍以工作区 GitHub App
身份推送和开 PR，提交作者却是 `Test User <test@example.com>`。凭据优先级
（个人 → 所有者本地 → App）本身是对的；后端返回的是
`personal_token_refresh_failed`，CLI 把它压成没有信息的 `available: false`，
设置页则一直显示身份已连接。现在 helper 会打印后端原因；GitHub 确认 refresh token
已死时清除存储的 token 对，设置页转而要求重新授权。提交身份遵循同一优先级，
机器身份只读全局 Git 配置，不再读所有 Lody worktree 共享的 bare 仓库配置。
尚未查明的是受影响账号的 refresh token 为何失效；本次修复让状态可见、可修复，
但不能阻止其发生。

## 问题

在受影响机器上的现场探针（会话 broker + Convex action）：

- `/github-auth-context` → `personalEnabled: true, allowLocalAuth: true`
- `/github-token` personal → `available: false`；后端为
  `personal_unavailable / personal_token_refresh_failed`
- 机器上没有 `gh` 登录，也没有 Git credential helper → 使用 App token

选择器行为与规范一致。缺陷在可观测性和状态：

1. `GitHubTokenManager.getCredentialCandidate` 对 `personal_unavailable` 返回
   `null`，丢掉原因；helper 只打印 `(personal access unavailable)`。
2. `getPersonalOperationSettings` 只要 `refreshTokenExpiresAt` 在未来就报
   `authorized`。而 refresh 失败分支恰恰只在该条件下可达，所以这种账号永远显示健康。
3. `readHostDefaultGitIdentity` 在 worktree 里执行 `git config user.name`。Lody
   的 worktree 共享同一个 bare 仓库配置，某次 agent 在那里写入了测试用身份，
   该仓库所有所有者会话都继承了它。

## 决定

- 候选查询返回 `{ available: false, reason }`；broker 原样转发；
  `selectGitHubCredential` 在降级到本地或 App 身份时，按原因打印可操作的一句话
  （未授权 / 已过期或撤销 / 无仓库权限 / token 被拒）。原因是策略码，不含 token。
- 后端（私有仓库）：GitHub 以 `bad_refresh_token`、`invalid_grant` 或
  `expired_token` 拒绝 refresh，且没有并发写入的新 token 对时，清除账号的 token 对。
  设置查询随后报告 `missing`，现有的 Authorize 按钮重新链接。
- 提交身份：启用个人身份的请求者以其 Lody 账号提交。否则机器所有者使用机器的
  **全局** Git 身份；永不读取仓库级配置。`SessionManager` 按请求者从凭据策略解析
  `{ preferMachineIdentity, personalIdentityEnabled }`，包括会话中途切换请求者。
  身份仍按 agent 进程通过 `GIT_AUTHOR_*` / `GIT_COMMITTER_*` 注入，这正是同一台
  机器上不同请求者互不干扰的原因。

考虑过的替代方案：开启 `extensions.worktreeConfig` 隔离每个 worktree 的身份。
但在链接 worktree 中执行普通的 `git config user.name` 仍写入共享配置（只有
`--worktree` 才写 `config.worktree`），挡不住污染；只读全局作用域才能。

## 验证

- `github-credential-runtime.test.ts`：降级到 App 和本地各自打印对应原因的句子。
- `github-token-manager.test.ts`、`git-credential-broker.test.ts`：原因往返传递
  且不携带 token。
- `git-identity.test.ts`：所有者机器上个人身份优先；未开个人身份的所有者保留机器
  身份；非所有者永不获得机器身份；仓库级 `user.*` 被忽略。
- 私有后端测试：refresh 被拒后清除 token 对。

未验证：清除后真实的 GitHub 重新授权（依赖 BetterAuth `linkSocial` 更新既有账号行），
以及 refresh token 失效的来源。
