# 通过 native turn 取消压缩

Status: implemented
Translation: current

[English](2026-09-12-native-compaction-cancellation.md)

## 摘要

手动 Codex `/compact` 原本被当作没有 native turn 的命令，Stop 可以返回 ACP 取消，
但 Codex 仍在压缩。适配器现在捕获 native turn，通过常规取消路径中断它，并持有 ownership
直到 terminal 确认。Lody 发送 provider cancel，不中断 in-flight prompt 的 owner fiber，
因此正常取消在 ACP 返回后才完成历史收尾；共用的五秒 drain 会终止无响应的 provider，
终止失败则继续持有 owner。PR #618 删除自动历史 reconciliation 协议，改为修复这些执行边界；
打开会话不会迁移已有的陈旧历史。

## 决策

Codex 0.153.4 的手动压缩会发出标准 turn 和 item 通知。`thread/compact/start` 用空结果确认
提交，turn id 随 `turn/started` 到达。此前认为压缩没有可中断 turn，是把空 ACK 与不存在
生命周期混为一谈。

app-server client 在提交前注册 owner，只在匹配的 `turn/completed` 到来时 resolve。
启动失败和连接关闭会 reject owner。命令通过普通 native turn 的 ACP 命令生命周期传递
native id 和 terminal 结果。Stop 与请求取消均中断捕获的 turn；若取消早于 id 到达，
则等待 turn 启动后中断。在取消 drain 期间，ACP prompt 一直被占用。

Lody 在 prompt in-flight 时记录 `runtime.cancelRequested` 并发送 provider cancel，
保留原有 owner fiber 和 runtime，直到 ACP 返回，再由 scope 执行取消收尾并释放 ownership。
期间新用户消息保持 pending，不能到达 ACP。steer 在异步准备后及 provider 接受 ACK 后都
检查取消标记。Stop 后到达的成功 ACK 不得替换 source invocation、将 source 强制结算为
handled 或转移 ownership。它返回 `stale-turn`，释放 application lease，不重新排队已被
接受的 steer；现有 owner 继续等待 cancelled terminal。daemon 与客户端均不会把这个
disposition 当作重放 steer 的许可。提交 prompt 前的取消及 finalization teardown 保留原路径。

此前 CLI 的 scope finalizer 已通过 `pendingPromptCompletion` 保留 runtime，并非在 Stop 时
无条件释放 ownership；但它会先中断 owner fiber、完成历史收尾，然后才 drain provider。
正常 Stop 现在等待 prompt 本身，同时启动原有五秒 raw-request drain，不等待 cancel ACK。
到期时 prompt 若仍 pending，则终止该 session；连接关闭 reject prompt，让 owner 自然进入
finalizer。终止失败时继续等待 raw ACP 完成，不释放 ownership。Stop 与外部中断后的
finalizer 共用 runtime 上的一个 drain promise，重复取消不会重置期限或重复终止。
这恢复了 #571 的恢复策略；此前保留 in-flight owner 的修改误将该策略限制在外部中断路径。

ACP 完成后，既有的 [provider 失败收尾](2026-09-10-context-compaction-terminal-state.md)
会在释放执行 ownership 前，将尚未结束的压缩持久化为 failed。provider 明确发出的 terminal
item 更新仍是权威结果。

Session 视图不主动修复数据。本分支新增的 reconciliation capability、两种传输方法、
renderer retry hook 和 daemon 历史修复均已移除。历史上的未完成记录是独立维护问题；
隐藏进度或改写历史都不能中断 native 执行。

## 证据与验证

- [固定版本的 native 协议](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server/README.md#example-trigger-thread-compaction)。
- 适配器 owner 位于 `packages/acp-extension-codex/src/CodexAppServerClient.ts`；
  同目录的 `CodexCommands.ts` 和 `CodexAcpServer.ts` 负责命令及取消路由。
- 确定性测试覆盖 native start 前后的 Stop/abort、drain 期间拒绝第二个 prompt、
  中断后继续执行、失败、start ACK 前的 terminal、启动拒绝、无关 turn 完成及进程退出。
- Lody execution 测试使用真实 `AgentClient` 与受控 ACP transport：cancel ACK 后 signal
  仍存活、历史未完成、第二次 dispatch 保持 pending，native terminal 后下一次 prompt 才能运行。
  fake timer 覆盖五秒终止、cancel ACK 不返回、重复 Stop 不重置期限，以及终止失败后继续
  保留未完成历史和 ownership。外部中断测试仍覆盖 raw 完成、进程终止及终止失败。
- steer 测试覆盖请求前和异步准备期间的 Stop，验证未投递历史及其 dispatch pointer 保留。
  受控的接受 ACK 在 Stop 后到达时，source invocation、用户轮次和 dispatch owner 均不改变，
  source 历史不提前完成、不报告 handled，也不重放 steer；provider terminal 最后将 source
  结算为 cancelled 并释放 owner。补上 ACK 后检查前，该 race 在 `e4a860a2` 上失败。
- 契约：[会话历史写入](../../../../specs/session-history-writes.zh.md)。
- PR：[Lody #618](https://github.com/LodyAI/Lody/pull/618)。
- 适配器实现：[Codex adapter #41](https://github.com/LodyAI/acp-extension-codex/pull/41)。

适配器类型检查及 617 个启用的测试通过；27 个测试由原有环境条件跳过。真实 Codex smoke
验证手动压缩正常完成，并确认 Stop 后 native `interrupted` 先于 ACP prompt 的 `cancelled`。

根仓库类型、lint、格式、i18n、文档和边界检查通过。Lody execution、dispatch-watcher 和
AgentClient 三组相关测试共 207 个通过。完整 `pnpm check` 到达 Electron 测试时，103 个通过，
relay suite 因本地缺少已安装的 Electron 二进制无法加载；此前的 workspace 测试均通过。
