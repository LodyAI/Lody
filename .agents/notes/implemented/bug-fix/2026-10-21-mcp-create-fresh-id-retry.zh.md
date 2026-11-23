# 采纳进行中 MCP 创建的换 ID 重试

Status: implemented
Translation: current

[English](2026-10-21-mcp-create-fresh-id-retry.md)

## 摘要

用户反馈 `lody_session_create` 会在同一个 Agent turn 里创建两条一模一样的 Session。
同一个 `operationId` 的接受本来就是幂等的，但这个调用要等目标 Session 写入后才返回，
客户端工具超时或较晚的错误会让 Agent 换一个新 id 重试同样的工作，而这次重试被当成了新工作。
现在本机 Operation store 在原 Operation 仍处于 active 时，把同一来源 Turn 发起的、内容相同的单个创建视为重试，
返回原 Operation，不再创建 Session。代价是同一个 turn 不能同时发起两个完全相同的单个创建；
输入有变化或来自其他 turn 的请求不受影响。

## 发现

- `accept` 和 `findMatchingRetry` 以 `(requesterSessionId, operationId)` 为键。
  同 id 重试（包括并发重试）已经能原子地采纳，固定的目标 id 让补建复用同一条 Session。
- 单个创建在 `createSessionResult` 完成前都是同步的，之前要经过 workspace/catalog 同步、
  机器检查和附件准备。Lody 没有配置 MCP 工具超时，客户端使用各自的默认值；
  客户端放弃调用不会取消 daemon 里的工作。
- 用户截图显示同一个 turn 里有一次成功、一次失败的 `lody_session_create` 调用，
  随后 Agent 发现有两条 review Session。本机 transcript 和 daemon 日志拿不到，
  具体失败原因（超时或错误）和两次的 id 都未确认；任何同输入的换 id 重试都符合该现象。
- 旧的 `wait=true` 适配路径不接受 `operationId`，仍不幂等；它是临时兼容，本次不改。
- `createSessionResult` 成功之后，`markItemInputDurable` 是一次写入，可能耗尽 store 的忙重试
  （`STORE_BUSY`）。以前它会作为工具错误抛出，而 Session 和输入其实已经存在，
  这正是会诱发重试的误报失败。Coordinator 本来就能识别已存在的目标输入，只补 durable 标记而不重复写入。
- 接受后 `createSessionResult` 的 catch 会让 Operation 保持 active 等待补建，但丢弃了错误，
  卡住的创建没有任何诊断信息。

## 决定

在 `BEGIN IMMEDIATE` 接受事务内以及接受前的重试查找中，新的 `session_create` 若与某个
**active** Operation 的请求方 Session、请求用户、来源 Turn 和规范化命令指纹都相同，
就采纳该 Operation：不写新行、不建认领、不建目标。MCP 返回原 Operation 快照，
并附带 `notice`，写明其 id，并说明要重新发起同样的工作需先取消它。
工具描述现在要求 Agent 在超时或失败后用同一个 `operationId` 重试。

创建成功后 durable 标记失败时，只记日志并返回 active 快照，由 Coordinator 根据历史证据补完标记。
接受后创建失败时，先用原始错误信息记日志，再返回 active 快照。接受前的错误和目标 id 不变量检查仍然让调用失败。

单个创建仍要等物化完成，因此在同步降级时，客户端工具超时仍可能短于创建耗时：
调用方会看到失败，而创建随后成功。相同的重试不会再造成重复，完成结果也仍会送达调用方。
[同步确认下限](2026-10-21-sync-confirmation-timeout-floor.zh.md)延长了这些等待，
因此需要在单独的改动中把 Lody MCP 的客户端超时调到高于服务端预算。

考虑过的替代方案：

- 接受后立即返回、交给 Coordinator 落地，能消除大部分超时窗口，但会改变接受失败的暴露时机，
  也覆盖不了接受前就发生的超时。
- 连已结束的 Operation 也匹配，会阻止拿到结果或失败后的有意重复，因此只匹配 active。
- 批量创建和 chat 不在范围内：相同的批量项或重复的 chat 提示可能是有意的。

## 验证

- `operation-store.test.ts` 覆盖换 id 采纳，提示不同、其他 turn、chat Operation 互不影响，
  以及原 Operation 结束后可以重新创建。
- `lody-mcp-server-chat-sync.test.ts` 使用真实 store，证明 durable 标记遇到忙碌时返回 active Operation，
  且换 id 重试不会创建第二条 Session；去掉修复后该测试失败。Coordinator 从已写入目标恢复的路径由
  `operation-coordinator.test.ts` 覆盖。
- `tests/local-platform-zero-cloud.test.ts` 走真实的 daemon 工具路径，
  断言换 id 重试返回原 Operation，且不会派发第二条 Session。
