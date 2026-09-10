# 会话编排异步链深度

Status: draft
Translation: current

[English](session-orchestration.md)

Agent 通过 Lody 委派异步工作时，每个委派目标都会从发起它的人类 Turn
继续同一条因果链。Lody 最多接受 32 次这样的跳转。已经处于深度 32 的
Turn 再发起命令时，会在创建 Operation 或目标 Session 之前被拒绝，并返回
不可重试的 `CHAIN_DEPTH_EXCEEDED` 错误。

这个深度表示因果委派次数，不是通用的 `parentSessionId` 树深度。创建
Session、向另一个 Session 发送工作、以及投递 Operation 完成通知，都会让
目标 Turn 增加一层。普通人类 Turn 缺少深度时从零开始。这个上限仍是共享
协议中的固定值；修改它必须同步更新所有生产者、恢复路径、可执行模型和本
Spec。

机器侧 Review Automation 在这条 MCP 委派链之外运行。它自己管理轮数、
Token 和权限预算，并根据外部的 Review 与 CI 状态推进。

## 证据

实现检查位于 `apps/cli/src/mcp/lody-mcp-server.ts`，共享上限位于
`packages/shared/src/session-orchestration.ts`，可执行 Operation 模型位于
`apps/cli/src/orchestration/operation-model.ts`。

本草稿记录将上限改为 32 的请求。依赖安装后仍需补充运行时和已发布客户端
验收。
