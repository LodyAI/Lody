# 运行实例持有 GitHub 凭据上下文

Status: implemented
Translation: current
PR: [#1385](https://github.com/LodyAI/Lody/pull/1385)

[English](2026-10-10-runtime-owned-github-context.md)

## 摘要

废弃托管 GitHub 预热后，用相同 Session ID 创建本地实例，会让 broker 注册记录与
实例缺失的凭据策略不一致，导致后续消息报 `github_context_missing`。现在凭据授权
属于独立的 Effect Scope lease，接管后继续由同一运行实例持有；原生实例不再查询
broker 历史注册。预热控制使用另一个 Effect Scope，清理失败会阻止替换。
Session/ACP/worktree 的 Promise 编排仍是明确保留的兼容层，本改动不宣称完成整个
Effect 迁移，也没有部署验证。

## 决策与所有权

本改动扩展[本地原生认证](../../implemented/feature/2026-09-29-local-project-native-github-auth.md)
与[有序身份回退](../../implemented/architecture/2026-10-03-github-identity-fallback.md)。
[更新后的草案契约](../../../../specs/github-identity-fallback.md)保留对话 owner 网络
身份与 turn requester 提交作者的独立归属。

broker 的 `acquireContext` 是 Effect acquire/release 资源。每次获取生成独立 token
和固定上下文文件，即便 Session 与 owner 相同也不复用。不可变上下文包含 Session
和 machine 身份，workspace 由所属 broker 确定。不再存在 Session 索引的注册状态
或可变的 Session 上下文文件。释放精确 lease 且幂等；broker 关闭也会撤销剩余 lease。
平台没有 token 能力时仍走原生路径。

`SessionCredentials` 在 `SessionConfig` 之外显式表达 native/managed 运行能力。
临时 `acquireSessionCredentialsLegacy` facade 为 Promise 调用方提供 Scope 持有的
句柄与共享关闭凭证。预热在补偿范围内获取它，sandbox/Session 创建之前失败也会关闭。
接管时由同一个 Session 继续持有，实例终止时关闭。冷启动还覆盖文档、进程启动及
启动后持久化失败。回退使用原始传入的启动配置，不带入合并过的预热环境。
提交作者偏好不再存放在网络凭据策略里。

创建、续聊、失效 agent 恢复及 steer 均校验实例自己的有效 lease 和可信 owner。
native 分支为空操作；托管状态无效则拒绝继续。owner 变化时撤销旧授权并终止实例，
不在旧 helper 下切换身份，也不重放操作。steer 校验发生在 provider 接受前，并保留
最后的同步 Stop 校验。旧 Session 的生命周期事件不能从注册表移除新实例。

## Effect 边界与清理

`makePreparationControl` 使用 Effect v4 Scope、Deferred 和受控 TTL fiber。
临时 facade 在退出 Effect runtime 后通知 Promise 调用方；所有关闭方共享完成凭证。
claim 关闭控制 Scope，不关闭凭据/运行资源 Scope。同步 peek/claim 以及先发布再启动
的语义保持不变。

manager 仍通过原有 Promise 完成屏障管理底层 ACP 与 worktree 启动，没有把整个流程
包起来就宣称已原生使用 Effect。未来可按
[路线](../../proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.md)和
[CLI Effect 指南](../../../docs/cli-effect-ts.md)自底向上替换这些依赖与准入 facade。
本次仅迁移资源和计时底层，不新增跨层 Effect→Promise→Effect 进程 runner。
关闭 Scope 不承担运行资源的自动重新挂载。

从预热目录移除后及资源迟到创建时，清理仍可发现。释放错误（包括资源发布前的回滚失败）保留在清理凭证中，替换
不能把失败视为成功。无法确认进程终止时撤销凭据授权，但保留工作区所有权。
现有底层启动屏障上的清理等待仍可能持续 pending；这是明确的未解决所有权状态，
不代表释放成功，也不能据此允许冷启动并行覆盖。

## 验证与边界

broker 测试用真实 Scope 获取配合请求 handler 验证：释放 A 后其 token 被拒绝，
相同 Session 的 B 仍能获取授权。manager 测试覆盖相同 ID 的托管注册后转本地、
原生环境保留、接管保留 lease、sandbox 失败、启动前废弃、文档/进程/持久化失败、
终止、owner 转移撤销，以及旧实例退出不会移除或结束替换实例。原有预热测试覆盖过期、取消、替换和迟到资源，清理失败现在
断言保持阻塞。轮次执行、环境、终止、原生 Git helper 与 gh/runtime 测试也通过。
新增回归使用合成身份及可控信号/虚拟时钟，不使用真实凭据或生产网络。CLI 类型检查、
仓库文档检查、public/platform 边界检查及进程边界 guard 均通过。创建 PR 前，
`pnpm format`、全工作区类型检查和类型感知 lint 通过。首次 `pnpm check` 的测试阶段
因 Roost signed-prefix 超时及原生 Git fixture 继承当前会话 Git 包装器而中止。
两个失败套件单独重跑通过；Git fixture 使用移除继承 Git/SSH/Lody Git 环境变量及
包装器 PATH 的环境。未重新完整跑完测试阶段，其余 i18n、导入及边界检查单独通过。

未采用的方案：仅增加本地 guard 会遗留授权；按 Session ID 撤销会误伤新实例；
吞掉缺失策略会削弱托管隔离。未重启应用、修改运行中的 daemon、发布版本或验证部署
恢复效果。
