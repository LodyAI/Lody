# MCP chat 的网络与接受边界

Status: implemented
Translation: current

PR: [#715](https://github.com/LodyAI/Lody/pull/715)

[English](2026-09-14-mcp-chat-network-boundaries.md)

## 摘要

Cloud MCP chat 在读取或接受 Operation 前先解析 workspace 权限并同步远端元数据，同机目标也经过这条路径。此前 workspace fetch 失败与接受后的输入物化失败可能都变成不可重试的内部错误，但持久状态不同。现在命令使用 Effect 管理有限读取重试、取消、manager 释放和基于固定 Operation 身份的恢复。本实现没有新增本地路由或离线授权，也不代表已通过发布端验收。

## 证据与建议

在 `b73c365a7d9afc2e7e10ccd4881130787b3a80e3`，`startSessionChatOperation` 先调用 `resolveWorkspaceOrThrow`、`withWorkspaceManager`、元数据同步和活跃调用身份读取，再执行 `findMatchingRetry`。Workspace 枚举直接查询 Convex，没有使用机器访问查询的有限重试。未知错误映射为 `INTERNAL_ERROR`、`retryable: false`。已有 `operation_get` 直接读取本机 store，可用于结果不确定后的查询。

仅为幂等 workspace 读取扩展[现有访问检查记录](2026-09-08-session-access-retry-diagnostics.zh.md)中的有限重试：最多四次，间隔 250/1000/2000 ms，单次上限 5 秒，总计上限 10 秒。`WorkspaceAccessError` 区分暂不可用、拒绝、无效响应和未配置。自定义 Convex fetch 在 SDK 转换前保留 HTTP 状态及响应正文传输失败；业务/schema 错误不进入传输重试。明确 HTTP 拒绝优先于消息特征匹配。失败诊断记录 stage、接受状态、Operation 身份、安全 endpoint 分类和白名单嵌套 cause code，不记录原始消息、URL、prompt 或凭证。Promise 适配层解开类型错误，避免泄漏 Effect 的 FiberFailure 包装。

```text
workspace 读取 [Effect 重试 + 超时 + AbortSignal]
  → manager 作用域 [获取 / 使用 / 释放]
  → 身份与权限校验
  → SQLite 接受 [固定 Operation 和目标 Turn]
  → 物化输入 [失败不触发命令整体重放]
  → 已存回执，或 OPERATION_RESULT_UNAVAILABLE
```

本次只有 workspace I/O 支持端到端取消。旧 manager 获取和派发 Promise 必须结束后才释放资源，避免取消时关闭尚在写入的 manager。这可能延迟取消完成，不是整个命令的截止时间。MCP 上下文在旧 Promise 边界捕获并重新绑定，防止 Effect 并发调度混淆调用者身份。Effect 已是依赖，无需新增包或更改存储/传输格式。

接受后应返回或恢复 store 中的固定目标。回执读取失败代表不确定，不能当作拒绝或分配新 Operation 的许可。同 ID chat 重试要求命令、请求者和源 Turn 一致；后续驱动 Turn 应遵循现有 snapshot/recovery 契约。保留输入物化 claim、重放前远端追平，以及 dispatch 后已有的尽力同步语义。

`session-access-policy.ts` 已允许当前 owner 身份匹配、workspace 活跃且存在已验证 owner 快照时进行本地 dispatch。`remote_missing` 拒绝；其他成员、账户不匹配、快照缺失或 catalog 不可读时须远端验证。`verifiedAt` 不是 TTL，也不证明 token 当前有效。未来本地 MCP 路由必须绑定准确 runtime machine/workspace 和当前调用身份，复用 daemon 所有的策略与撤权生命周期，不能将 owner 权限扩大到远端目标或其他成员。本次不采纳新离线许可或缓存期限。

## 验证与限制

重构基于 `99e63b0694d5f67eab62bd1dc7df7d548f074b27`。`workspace.test.ts` 覆盖真实 Convex 解析、连接/正文故障、明确拒绝、单次与总超时、并发取消。`session-chat-network-boundary.test.ts` 用注入 fetch 失败、显式 Promise gate 和 fake clock 测试真实 MCP handler 与 SQLite Operation store，包括获取/物化期间取消、回执丢失与同 ID 重试。它替换只断言 mock 调用的 chat-sync 套件，保留单项/批量同步失败和 inactive runtime 的覆盖。目标物化端口使用合成 SQLite sink，不是真实目标 daemon 或 HistoryWriter；它只证明该端口的行为。现有 coordinator、store 和 access 套件提供邻近覆盖。测试不能确定历史 DNS/代理/TLS 根因，也不证明整机离线行为。[Spec](../../../../specs/session-access-verification.zh.md) 仍为 draft。
