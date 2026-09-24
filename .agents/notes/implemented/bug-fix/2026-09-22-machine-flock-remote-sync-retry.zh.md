# Machine Flock 远端追平失败后重试并上报

Status: implemented
Translation: current

[English](2026-09-22-machine-flock-remote-sync-retry.md)

## 摘要

同事共享的机器会出现在机器列表里，但它的 Agent 列表是空的。渲染端从
`<workspaceId>:mf:<machineId>` 这条 Flock 流读取每台机器的 agents。加入这条流失败，
或首次远端同步失败时，错误被直接吞掉：不打日志、不上报、不重试。之后 effect
看到任务未变就跳过，这台机器只剩本地副本里已有的数据（本设备从未同步过的机器就是
空的），直到组件重新挂载或在线状态翻转一次。现在远端追平失败会先释放这次的房间租约，
在使用方挂载期间按指数退避（1 秒起翻倍，上限 60 秒）重试，打一条 `console.warn`，
并且每台机器只发一次 PostHog 事件 `machine_flock/remote_sync_failed`，直到某次追平成功。
拉取范围没有变：离线或 `unknown` 的机器仍只读本地副本。

## 问题

`useMachineFlockRowsByMachineIdsState`（`packages/components/src/hooks/use-machine-flock-rows.ts`）
先读本地行。对 `remoteMachineIds` 里的机器，它再加入共享房间，等 `firstSyncedWithRemote`
之后发布远端行。远端这一步以 `.catch(() => undefined)` 收尾。加入失败时共享房间会被移除，
但任务仍然有效、`workKey` 也没变，effect 遇到这样的任务会直接 `continue`，
没有任何路径会重新发起这次拉取。

失败可能来自网络抖动、流令牌过期，或托管服务拒绝读取这条流。最后一种无法在本仓库内确认。
由于每种失败都是静默的，日志和分析里都看不到它们。

## 决定

- 失败时任务立即释放这次的租约，避免失效的房间被留着复用。没有其他持有者时，
  重试会通过 `acquireMachineFlockRoom` 重新加入。
- 重试间隔是确定的 `min(1000 * 2^(n-1), 60000)` 毫秒，不加抖动。每个挂载的使用方各自重试；
  加入房间和同步本身已按房间、按文档去重。卸载、切换 runtime，或机器移出远端名单时，
  任务清理会取消待执行的重试定时器。
- 上报按 `workspaceId + machineId` 跨使用方去重，某次追平成功后清除。第一次失败打
  `console.warn` 并发事件；之后只打 `console.debug`，避免流被拒绝的机器每个使用方每分钟上报一次。
- 事件只带低基数字段：`workspace_id`、`machine_id`、`families`、`error_type`、
  `http_status`（错误带 `status` 或 `statusCode` 时才有）和 `navigator.onLine`。
  不发送错误消息，因为传输错误里可能带有流 URL；PostHog 的 `error`/`message` 键本来也在屏蔽列表里。
  桌面版的遥测仍由平台能力硬关闭，所以只有配置了 PostHog 的环境才会上报。

## 考虑过的方案

- 在共享房间上记住"首次同步失败"，让之后的租约改走一次新的 `syncOnce` 追平。
  最终放弃：所有持有者等待的是同一个首次同步，现在失败时都会释放，失败的房间不会比持有者活得更久。
  这个标记只会是没有测试覆盖的防御代码。
- 用 `captureException` 上报原始错误。它在 PostHog 错误追踪里聚合得更好，但会带上未经过滤的错误消息。

## 验证

`packages/components/tests/use-machine-flock-rows.test.tsx`：

- 两次加入失败（第一次为 403）后成功。测试检查只上报一次且带 `http_status: 403`，
  1 秒后发起第二次尝试，2 秒重试后 agent 行被发布。该测试在旧代码上失败。
- 失败后卸载。测试检查假时间推进 60 秒后不再发起加入。

相关组件测试（31 个文件，306 个用例）全部通过。线上实际出现的失败没有在这里复现，
所以它是偶发还是托管端的权限拒绝仍待确认；新事件正是用来回答这个问题的。

## 未改变的部分

远端追平仍然受在线状态门控：显示为离线或 `unknown` 的可见机器不会拉取它的流。
是否放宽这道门槛是另一个决定。
