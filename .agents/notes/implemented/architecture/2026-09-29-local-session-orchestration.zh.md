# 通过 daemon 权威状态实现本地 Session 编排

Status: implemented
Translation: current

[English](2026-09-29-local-session-orchestration.md)

## 摘要

OSS 的 Role mention 会要求 Agent 通过仅支持 Cloud 的 MCP 路径创建 Session，
恢复路径又独立依赖远端 workspace 查询与 Streams。现在，本地 Session 工具
通过有界 IPC 进入 daemon 已有 repo，与 Cloud 共用参数校验、Role 解析和
Operation 持久化。请求作用域内的命令环境提供本地身份、权限检查和宿主操作，
恢复则显式注入权威状态确认。Cloud 保留现有认证和远端追平要求；代价是本地
MCP 增加一次 IPC，但不会产生第二个本地写入副本。

## 职责

```text
MCP Session/catalog 注册与校验
  Cloud -> 现有认证命令运行时
  Local -> session/call-tool -> daemon 作用域/活跃 Turn 校验
    -> 作用域 SessionCommandEnvironment -> 相同 handler + Operation store
Operation coordinator -> 权威状态确认 -> 按冻结配置补齐目标
  Cloud: 远端 Streams 追平
  Local: 权威 daemon repo 落盘，再检查固定 Turn
```

`session-tool-router.ts` 同时注册 MCP handler 和 daemon 白名单，在 IPC 边界
重新解析参数。`daemon-session-tools.ts` 将调用绑定到活跃本地用户、机器和
workspace。AsyncLocalStorage 隔离并发 workspace 环境，复用已有命令入口，
不修改全局状态。作用域包含 daemon 资源，不接受调用方指定凭据。Role 配置、
已接受的目标 ID、claim、重试语义和完成通知所有权保持已有表示。

只跳过登录会把写入留在另一个副本，且恢复仍依赖 Streams。另写 OSS Role 实现
又会重复配置冻结和重试协议。适配器方案共用这些逻辑，保留 Cloud 路径。本决策
扩展已有的 [Session 编排](../../../../specs/session-orchestration.zh.md) 能力，
不改变因果链深度限制。

## 验证与限制

真实本地 repo 测试覆盖 Role 发现、目标历史中的 prompt 前缀、持久派发、重复
Operation 接受以及零产品云端流量。Coordinator 测试覆盖本地权威恢复，并保留
远端追平、防重复和 Delivery 测试。这些测试不证明打包桌面的实际交互或真实
Provider 响应。托管仓库上下文及不相关的 Cloud MCP 操作不在本地支持范围内。
