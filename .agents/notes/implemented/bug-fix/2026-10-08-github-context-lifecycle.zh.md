# 将 GitHub broker 上下文限定于其持有者

Status: implemented
Translation: current

[English](2026-10-08-github-context-lifecycle.md)

## 摘要

本地项目会话可能在后续轮次以 `github_context_missing` 失败：被放弃的预准备在该会话 ID 下
留下 GitHub broker 上下文，而轮次开始的刷新把任何上下文都当作托管注册。broker 上下文现在是
计数租约，未被接管的预准备会释放；刷新在检查上下文前先跳过本地项目。缺少 policy 的托管会话
仍失败关闭。留下残留上下文的桌面交互属于推断、未复现，最终源码也尚未完成全仓库与 E2E 验收。

## 证据

已确认：

- 同一本地会话首轮刷新成功、Agent 已在运行后，失败轮次记录
  `execution.refresh_gh_token status=error durationMs=0`。
- 调用已安装 bundle 自带的预准备、成员判断、刷新与 policy 方法，无 policy 的本地会话仅在
  其 ID 存在上下文时失败。
- 源码中成员关系是刷新的唯一门槛；预准备在最后一次中止检查前注册上下文，预准备清理从不撤销。

推断：取消与认领未命中不等待进行中的凭据设置，被放弃的托管预准备可能在冷启动本地会话首轮
刷新之后才注册上下文。这与日志相符；触发该竞态的用户交互尚未确认。

## 决策

- `GitCredentialBroker.acquireSessionContext` 返回按会话 ID 计数的幂等租约。预准备与接替它的
  持久会话可能持有同一上下文；最后一次释放撤销当前 token 及其文件，包括所有者轮换后替换的 token。
- 预准备在其他凭据步骤全部完成后才获取租约；中止、失败或未被接管的清理时释放，接管时移交给
  持久会话。
- fork worktree 清理只为解析仓库而准备凭据，worktree 移除后释放其租约。
- 持久会话保留上下文直到 broker 关闭。关闭推进租约代数，关闭前签发的租约不能释放之后的上下文。
- 刷新与预准备一致，在检查成员关系前对本地项目直接返回。无 policy 的托管会话仍失败关闭，
  所有者变更仍终止旧进程。

未采用的方案：

| 方案                    | 原因                               |
| ----------------------- | ---------------------------------- |
| 删除缺 policy 检查      | 掩盖托管设置错误                   |
| 给本地会话补 policy     | 把本地项目纳入托管凭据             |
| 每次预准备清理都撤销    | 迟到的清理会撤销接替者共享的 token |
| 刷新只看会话自身 policy | 去掉托管失败关闭检查               |

## 限制

- 持久会话终止时不释放其上下文，上下文保留至 broker 关闭。
- 解析出不同所有者的过期预准备仍会轮换共享 token。

## 验证

行为测试覆盖 broker 租约（共享持有者、所有者轮换、关闭代数）与真实预准备运行时：凭据设置
期间中止、未接管与迟到的清理、接管后的多轮刷新、fork worktree 清理、本地会话与同 ID 上下文并存，以及托管会话缺
policy 的失败。在 `5fe0d97b`，这四个聚焦测试套件通过 43 个测试，无 unhandled rejection；
format 与 typecheck 通过。

最终源码未验证：全仓库 check 与完整桌面 E2E。早先 checkout 上的运行中，native-SSH fixture 以
`context_unreadable` 失败，`LODY-AGENT-001` 与 `LODY-ROLE-001` 超时；原因均未归因。

## 链接

- PR [#1314](https://github.com/LodyAI/Lody/pull/1314)、Issue
  [#1309](https://github.com/LodyAI/Lody/issues/1309)
- [本地原生认证](../feature/2026-09-29-local-project-native-github-auth.zh.md)
- [按命令选择凭据](../architecture/2026-09-26-github-command-credentials.zh.md)
