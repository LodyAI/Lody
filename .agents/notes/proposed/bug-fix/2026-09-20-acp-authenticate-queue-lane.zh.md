# 为 ACP 认证控制消息分配独立队列 lane

Status: proposed
Translation: current

[English](2026-09-20-acp-authenticate-queue-lane.md)

## 摘要

在托管 Agent 登录（例如 Codex 的"Sign in with ChatGPT"）过程中点击取消按钮，在登录完成或
daemon 的 285 秒超时触发之前没有任何效果：本地控制队列把 `machine/acp-authenticate` 的
cancel 消息串行排在了仍在运行的 start 消息后面的共享默认 lane 上。现在
`MessageProcessor.extractQueueKey` 把 `start` 映射到独立 lane，把
`cancel`/`submit-code`/`submit-input` 映射到共享的 control lane，使控制动作在登录进行中也能
被分发。仍保留一个设计内的竞态：如果 cancel 先于 start 在 `AcpAuthenticationManager` 注册
到达，会以 `not-running` 结束，用户可以再次取消。

## 问题发现

渲染层的取消是发后即忘：发送 `action: 'cancel'` 的 `machine/acp-authenticate` 消息，然后等待
daemon 的 `cancelled` 进度事件。在桌面本机路径上，该消息经过
`MachineRuntime.dispatchLocalMessageForResponse` → `MessageProcessor.enqueue`
（`apps/cli/src/lib/machine-runtime.ts`），两处默认行为叠加出了问题：

1. `extractQueueKey` 只为 `session/*` 消息分配 lane；所有 `machine/*` 消息——包括认证的
   start 和 cancel——都落入 `null`。
2. `ConcurrentQueue.enqueue` 把 `null` key 映射到唯一一条共享的 `__default__` 串行链。

start 任务一直占用该 lane 直到 `handleMessage` 返回，也就是等到 spawn 的登录进程
（`codex login --device-auth`）退出或 `apps/cli/src/agent/acp-authentication.ts` 的 285 秒
认证超时触发。`AcpAuthenticationManager.cancel()` 本身实现是正确的——cancelled 标志、abort
信号、对进程组 SIGTERM、升级 SIGKILL——但只要它要取消的 start 还在运行，它就永远不会被
分发。同样的阻塞还会让登录期间无关的 `machine/*` 控制消息（status、ping 等）排队等待。

## 决策

`extractQueueKey`（`apps/cli/src/lib/message-processor.ts`）的 lane 分配：

- `start` → `machine:acp-authenticate:start`。start 之间保持串行，与此前行为一致；按
  provider 的互斥仍由 `AcpAuthenticationManager.runningByAgentType` 保证。
- `cancel`、`submit-code`、`submit-input` → `machine:acp-authenticate:control`。控制动作绕过
  被阻塞的 start，并保持彼此之间的顺序。

考虑过的替代方案：

- 按 `authenticationRequestId` 分 lane：cancel 会和它要取消的 start 排在同一 lane 里，等于
  重现了死锁。
- 只把 `start` 移出默认 lane：也能解除 cancel 阻塞，但会允许 start 并发；让 start 保持串行
  更贴近既有行为，且登录 UI 本来就一次只驱动一个流程。
- 渲染层取消时做乐观状态更新：对正确性不是必需的——cancel 真正被分发后，面板会随 daemon 的
  `cancelled` 进度事件更新。

## 证据

- `apps/cli/tests/message-processor-permission-response.test.ts` 新增两个测试：cancel 和
  submit-code 在 start 处理器仍被阻塞时被分发；连续的 start 仍保持串行。去掉 lane 改动后，
  cancel 测试会因等待超时而失败。
- 根因报告与复现步骤：LodyAI/Lody#828（Bug 1）。

## 验证

- `vitest run tests/message-processor-permission-response.test.ts`：4 个通过；回退 lane 改动
  后新的 cancel 测试在 1 秒超时处失败。
- `vitest run tests/session-execution-service.test.ts`：130 个通过。
- `pnpm --filter lody test`：2812 个通过；`src/agent/acp-authentication.test.ts` 中两个
  `probeBuiltinAuthentication` 失败在原始基线上同样复现，与本改动无关。
- 根目录 `pnpm check`：typecheck、lint 和三项边界检查通过；i18n lint
  （`settings.about.devbarWarmup*` 缺失）与 `packages/components` 测试套件（本地 Node 25 下
  `atomWithStorage` 报 `getItem is not a function`；仓库支持 Node 22.14–22.x / 23.6+）在
  原始基线上以相同方式失败——两者均为与本改动无关的既有环境性失败。

剩余限制：本修复覆盖桌面本机控制路径（唯一经过 `MessageProcessor` 的路径）；远端机器通过
Machine RPC 分发认证消息，不经过该队列。渲染层仍不做取消的乐观状态更新。#828 的另一半
（登录把托管运行时下载失败呈现为登录失败）不在本 PR 范围，保持开放。
