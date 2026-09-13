# Codex 自定义端点认证

Status: draft
Translation: current

[English](codex-custom-endpoint-authentication.md)

## 场景

用户设置 Codex 时，可以使用 ChatGPT 认证，也可以为 OpenAI 兼容网关提供 API Key。
新手引导和设置页的 Codex provider 表单都提供这两种选择。网关必须支持 OpenAI
Responses API。

## 行为

ChatGPT 仍是默认选项，并继续使用设备登录流程。Base URL + API Key 会创建一个使用
Responses wire API 且无需 OpenAI 账户认证的 Codex model provider。携带凭据的端点必须
使用 HTTPS；只有 localhost 和 IP loopback 可以使用 HTTP。共享 builder 与表单执行同一
规则。

API Key 只存在于 renderer 的一次性状态中，绝不能进入 `AgentConfig.env`、
`ProviderSetupTask`、日志或其他 workspace 可读文档。renderer 通过加密的 Machine ACP
authentication-input 路径提交它。provisioning start 请求携带 renderer 已确认 launch
binding 的 SHA-256 digest；digest 包含 setup revision，但不包含展示 metadata。目标 CLI
在请求 secret 前和 staging 前分别重新计算并校验 digest，因此相同 revision 的 setup
重写不能把 key 引流到另一端点。验证期间，候选 key 只保留在目标 CLI 内存中。live probe
成功后，CLI 打开一个短暂的 machine-local commit 窗口，最多同时保留当前已发布 binding
和目标 binding，发布目标 config，再剪掉旧 binding，最后才确认成功。

daemon 在 publication 前后任一侧崩溃时，两种 binding 中仍有一份可以启动。启动恢复从
authoritative Flock 状态出发，只保留 surviving config 或 setup 引用的 binding。普通 queue
drain 不从 live Flock 状态 reconcile，因为 post-commit flush failure 会让该状态领先于最后
一次已确认 durable 的 snapshot。启动恢复只 snapshot config ID；每个 ID 的当前引用必须在
该 config 的 credential mutation 序列内重新读取，避免并发 publication 被旧 snapshot
错误剪除。

所有共享 Machine Flock `AgentConfig` writer 都拒绝 reserved credential key，包括空值；
reader 也丢弃含该 key 的旧 row 或外部写入 row。因此通用 `agent-config create`、`update`、
`show` 不能绕过 provider setup 流程持久化或显示 key。reserved-key 比较、generated-env
清理、credential binding 与设置页过滤均按 ASCII 大小写不敏感处理，因为 Windows process
environment 会把不同大小写的名称视为同一 slot。

只有当前 launch config 的 canonical launch binding SHA-256 digest 与 credential record
匹配时，credential 才会注入 generated provider 的 `env_key`。raw binding 不落盘。端点、
proxy、runtime、agent type、自定义 launch command 或任何 launch-relevant env 变化都会
fail closed。POSIX 使用 `0700` 目录和 `0600` 文件；Windows 使用 Lody per-user data 目录
继承的 ACL。GitHub token、credential-broker 变量等 session-specific env 必须在 canonical
persisted `AgentConfig` 完成 hydration 后才 merge，因此不会改变 provider credential identity。

创建、key rotation 和 launch-binding 变化使用带 exact setup revision 的非 secret durable
setup draft。credential RPC 等待该 revision 在目标 daemon 可见，总是请求 replacement key，
并使用内存中的候选 key probe staged config。credential staging 前，daemon 将该 revision
写入 Lody-owned provider state 的 `credentialRevision`。provider state 属于 canonical
launch binding，因此即使其他 launch field 全部相同，两个 API Key 也不会共享 credential
identity。一个 authentication lifecycle 及其 abort signal 覆盖 setup synchronization、
secret input、probe、credential staging 和 config publication。最后一次 abort check 紧邻
Flock commit 之前；commit 同步返回后 lifecycle 立即变为 `committed`，两者之间没有 async
gap。同步 commit failure 属于 pre-commit，必须 rollback staged credential 并报告普通失败。
boundary 前 cancellation 获胜且不发布；boundary 后 cancellation 或 timeout 已经太晚，不能
返回 `cancelled`。probe failure 不写 credential。

durable RPC success 表示最终非 secret `AgentConfig` 已发布且 setup 已删除。post-commit
flush failure 报告 uncertain publication durability，保留两种 credential binding，并要求
renderer resync authoritative config 后再展示结果；它不是普通 save failure，也不自动 retry。
superseded RPC 返回 conflict，不能发布或报告成功。provisioning probe 不修改共享 capability
cache；只有 exact setup revision 赢得 durable config publication 后，才在同一 per-config
credential mutation 序列内发布 probe 结果。cancellation、supersession、probe failure 与
uncertain publication 都不更新 cache。每次 submit 都使用新 setup revision。config
publication 成功后，capability-cache write failure 只是 degraded derived state；
authenticated result 仍完成 save。save 运行时，provider Dialog 的 close button、Escape 和
outside interaction 都不能关闭它。自动失败补偿只能取消本次 exact revision。

编辑时，旧 published launch config 保持可用直到 publication。展示 metadata、prompt、
title-generation 等 non-binding edit 直接更新 published config，不请求 API Key，也不 probe。
replacement publication 合并最新 published metadata，而不是以 setup snapshot 覆盖它。
相同 endpoint 的 key rotation 会在 `AgentConfig` 发布新的 `credentialRevision`，该 Flock
generation 在 crash recovery 时选择对应 key。credential store 在覆盖 active key 前拒绝
任何没有 fresh identity 的 rotation。不声明 credential protocol capability 的 machine 不能
提交 credential-changing edit。

专用表单只拥有它生成的 provider entry 和 ownership marker。切回 ChatGPT 时恢复原来的
`model_provider` selector，并移除 generated provider 与 marker。切换模式或删除 provider
必须先写 revision-independent setup cancellation，再修改或删除 config。optimistic projection
可能隐藏 config，因此 renderer 使用此前捕获的 `AgentConfig` 执行 durable delete，不能再从
projection cache 查找。durable wildcard 同时是阻止任何 in-flight replacement 的 barrier 和
cleanup intent。cancellation precedence 为 `wildcard > exact`：delete 会升级已有 exact marker，
后续 exact cancellation 不能削弱 wildcard。renderer cancellation 必须通过
`WorkspaceWriter` 的共享事务化 merge primitive，禁止 raw row put。

显式新 setup 只能在同一个 atomic Flock mutation 中撤销 wildcard 并写入 fresh setup
revision，因此 durable state 只能是 wildcard barrier 或新 replacement intent，不能出现
旧 setup 可发布的空档。目标 daemon durable 应用 cancellation 后，会 reconcile 该 config ID；
只有不存在引用它的 published custom config 或 custom setup 时才删除本地 credential。
cleanup 不依赖观察中间 config revision，也不需要第二种 row family。已有 `CODEX_API_KEY`、
无关 provider 和其他 env 保持不变。malformed `CODEX_CONFIG`、reserved provider-id collision
或 marker collision 都会被拒绝，不会覆盖。手写 Codex config 继续作为高级 env override。
通用 CLI `agent-config delete` 删除 custom Codex endpoint 时，在一次 Flock commit 内执行同样
的 wildcard cancellation 与 config removal。credential record 保存非 secret workspace/config
identity，使启动恢复能枚举并清理由旧客户端直接删除唯一 workspace row 后留下的 credential。

自定义端点只改变认证和 request routing，不改变 runtime ownership。除非用户另行提供 runtime
binary override，Lody 继续安装和管理同一个 Codex runtime。

## 证据

- [共享 provider 配置](../packages/shared/src/codex-provider-config.ts)
- [Provider credential adapter](../apps/cli/src/agent/provider-credential-adapter.ts)
- [Machine-local credential store](../apps/cli/src/agent/provider-credential-store.ts)
- [Provider 表单](../packages/components/src/components/settings/agent-config-dialog.tsx)
- [CLI authentication lifecycle](../apps/cli/src/agent/README.md#authentication)

本次修订以 draft 记录所请求的集成；它没有关联的人类批准。
