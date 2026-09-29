# 投递已被 CLI 标记为 seen 的消息

Status: implemented
Translation: current

[English](2026-09-28-send-delivery-seen-race.md)

## 摘要

发送改为本地提交后，如果 daemon 已经打开该会话文档，它可能在 renderer 做投递复查之前就把
新的用户轮次标记为 `seen`。复查把 `pending` 以外的任何状态都视为已被认领，于是既不写
`latestUserMsgId`，也不发派发 RPC，会话一直停在 "Starting"。现在投递通过一个共享谓词把
`seen` 与 `pending` 同等对待：`seen` 只是已读回执，只有执行状态才表示 CLI 已认领该轮次。

## 问题

工作区发送日志的 `deliver()` 会在会话投递锁内复查已提交的轮次，状态不是"等待开始"时提前返回。
自发送日志引入（`cf5c925`）起，这个判断就是 `status !== 'pending'`。CLI 的自动已读观察器
（`apps/cli/src/lib/loro/history-auto-read.ts`）一观察到最新的 pending 用户轮次，就把它推进为 `seen`。

#1079 之前，这个隐患被掩盖：轮次先写在 fork 上再 import，而本地传输不上传 import 进来的更新，
所以投递结束前 CLI 看不到该轮次。#1079 改为本地提交并立即上传。同机的已读回执在几毫秒内就会同步回来，
而 `deliver()` 此时还在等待元数据读取。

现场证据（包含 #1079 的 nightly.60）：两条空闲会话中的发送以 `status: seen` 存储；会话元数据中
`latestUserMsgId == lastHandledUserMsgId`，仍指向上一轮；daemon 日志里没有该会话的
`session/dispatch-turn`；renderer 也没有投递警告，因为 `deliver()` 正常返回了。

## 决定

- `@lody/shared` 导出 `isSessionHistoryStatusAwaitingStart`：`pending` 或 `seen`。它是 renderer 对
  "未被认领的输入"的定义。
- 投递复查使用该谓词，因此 `seen` 轮次仍会被激活并派发。`processing`、终态和 `delivery_unknown`
  仍然跳过激活。
- 原本内联写 `pending || seen` 的 Starting 状态辅助函数和旧版提升修复，也改用同一谓词。

放弃的方案：

- 关闭或延迟 CLI 自动已读，只是恢复时序上的掩盖，并没有修正契约；而且已读回执本身是产品信号。
- 在复查前写 `latestUserMsgId`，会在恢复发送时激活 CLI 已开始或已结束的轮次。

## 验证

`packages/components/tests/session-send-journal.test.ts` 把真实的 CLI 自动已读观察器挂到实时文档上，
发送一条空闲会话消息，断言它是 `seen`、激活指针指向它，并且恰好发出一次派发 RPC。
使用旧判断时，同一测试中 `latestUserMsgId` 停留在更早的轮次。

桌面旅程 `LODY-SESSION-005`（`e2e/src/features/session-follow-up.feature`，`@P0`）用真实的
Electron renderer 和打包 CLI，通过本地通道连接脚本化 ACP。首轮完成后，它逐条向空闲 Session 发送两条
后续消息，断言 agent 按顺序、且每条只收到一次，并且没有残留未完成的发送。在使用旧判断的桌面构建上，
它 3 次运行全部失败，第一条后续消息始终没有到达 agent；修复后 3 次运行全部通过。该竞态依赖时序，
因此上面的单元测试才是确定性的防线；这个旅程证明端到端的产品路径是通的。

限制：本改动不会修复已经卡住的会话。升级后重新发送即可正常派发。
