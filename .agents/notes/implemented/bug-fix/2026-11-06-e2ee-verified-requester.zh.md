# 加密工作区的已验证请求者

Status: implemented
Translation: current

[English](2026-11-06-e2ee-verified-requester.md)

## 摘要

加密 Turn 的 `userId` 只是历史行上的显示标签，但执行时 MCP、Git 身份、Inbox 和委派访问都把它当请求者。现在启动时从已
验证的签名者推出请求者：机器主人用机器账户，其他成员用 `e2ee-member:<cryptoUserId>`。加密 daemon 上的委派访问改为在本地
依据已验证账本和机器主人签名的共享策略判定，不调用工作区服务。标签继续用于名字和提交署名。不改 ledger 格式，不改服务端。

## 决定

owner 2026-11-06 决定这些检查在本地完成："刚刚的问题直接改成本地验证，不要去服务端走一圈了"。这排除了服务端账户映射。

- **身份。** `resolveRequester` 把已验证的签名者映射为请求者。当前机器签名的行保留它写入的请求者，自动化准入依赖这一点。
  派生输入以来源成员身份运行。
- **入口。** watcher 在构建请求前解析请求者，service 为直接启动和 prepared 启动解析。`claim` 拒绝请求者不一致的启动，所以
  漏掉解析的路径会失败封闭。
- **访问。** `verifyRequesterAccess` 复用 `authorizeExecution`，也就是 Turn 启动走的同一个检查。`MessageHandler` 里所有加密的
  `verifyMachineAccess` 调用都走它，daemon 上的 `session` 命令、Operation 目标和 `project list --machine`（委派或非委派）也
  走它。工作区服务拒绝加密工作区，所以这些在账户登录的 daemon 上此前无法工作。只有机器主人能访问其他机器，与派生工作的
  同机规则一致。命令通过这个检查不代表获得权限，启动 claim 仍是最终判定。
- **设备控制。** iOS 和 Android 的 agent 控制共用一道基于已验证 principal 的 gate。
- **标签使用方。** 加密 Turn 上，`humanInputReceipts` 和设备控制不再比较标签。RPC offer 不再按标签接受 Inbox 输入，dispatch
  会按已验证的请求者接受。

## 替代方案

- *由服务提供加密用户到账户的映射。* owner 否决，而且这会让映射依赖服务端可信。
- *砍掉受影响的成员功能。* owner 否决。

## 后果和限制

- 启动在 claim 之前多解析一次签名原件。
- Inbox 续跑、目标控制和编辑重发从请求者解析提交名字。成员在这些路径上回退到合成资料，而不是行上的标签。
- 自动化行如果标着非机器账户，会保留该标签，其委派访问被拒绝。
- `verifyRequesterAccess` 通过成员的一台当前个人设备来检查。
- daemon 之外的一次性命令保持现有的已认证访问路径。

## 验证

`apps/cli/tests/e2ee-runtime.test.ts` 覆盖错误标签的请求者、owner 和成员身份、本地共享与未共享访问（不调用服务）、跨机器
访问。`apps/cli/tests/session-dispatch-watcher.test.ts` 覆盖构建的请求，`apps/cli/tests/session-execution-service.test.ts` 覆盖生产
组合。没有运行真实后端、设备或手机。
