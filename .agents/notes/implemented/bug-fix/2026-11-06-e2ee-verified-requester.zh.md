# 加密工作区的已验证请求者

Status: implemented
Translation: current

[English](2026-11-06-e2ee-verified-requester.md)

## 摘要

在加密工作区里，Turn 的执行身份取自已验证的签名者，历史行的 `userId` 只是显示数据。机器主人的请求者是机器账户，其他成员是
`e2ee-member:<cryptoUserId>`。加密 daemon 上的机器访问在本地依据已验证账本和机器主人签名的共享策略判定。不改 ledger 格式，
不改服务端。

## 决定

- **身份。** `resolveRequester` 把已验证的签名者映射为请求者。当前机器签名的行保留它写入的请求者，自动化准入依赖这一点。
  派生输入以来源成员身份运行。
- **入口。** watcher 在构建请求前解析请求者，service 为直接启动和 prepared 启动解析。`claim` 拒绝请求者不一致的启动，所以
  漏掉解析的路径会失败封闭。
- **访问。** `verifyRequesterAccess` 复用 `authorizeExecution`，也就是 Turn 启动走的同一个检查。`MessageHandler` 里加密的
  `verifyMachineAccess` 调用，以及 daemon 上的 `session` 命令、Operation 目标和 `project list --machine`（委派或非委派）都走它。
  只有机器主人能访问其他机器，与派生工作的同机规则一致。通过这个检查本身不授予任何权限，由启动 claim 判定。
- **设备控制。** iOS 和 Android 的 agent 控制共用一道基于已验证 principal 的 gate。
- **标签。** 加密 Turn 上，`humanInputReceipts`、设备控制和 Inbox 都用已验证的身份。

## 替代方案

- *由服务提供加密用户到账户的映射。* 不采用：这些检查留在本地。
- *缩减成员功能。* 不采用：成员在共享机器上保留这些功能。

## 后果和限制

- 启动在 claim 之前多解析一次签名原件。
- 提交显示名字仍可能沿用标签或回退到合成资料，不是已验证署名。
- 旧标签作用域下的 Inbox 和 Operation 记录不迁移。数据仍保留，但不会出现在派生身份的查询里。
- 自动化行如果标着非机器账户，会保留该标签，其委派访问被拒绝。
- `verifyRequesterAccess` 通过成员的一台当前个人设备来检查。
- 一次性命令用自己的副本判定访问，且只代表自己的账户。没有可用账本的机器会得到清楚的错误：`session` 命令没有转给 daemon
  的通道。

## 验证

`apps/cli/tests/e2ee-runtime.test.ts` 覆盖错误标签的请求者、owner 和成员身份、本地共享与未共享访问（不调用服务）、跨机器
访问。`apps/cli/tests/session-dispatch-watcher.test.ts` 覆盖构建的请求，`apps/cli/tests/session-execution-service.test.ts` 覆盖生产
组合。没有运行真实后端、设备或手机。
