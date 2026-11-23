# 让一次上下文压缩不再渲染成 n 行堆叠提示

Status: implemented
Translation: current

[English](2026-09-20-stacked-context-compaction-rows.md)

## 摘要

一次上下文压缩可能在对话里显示成多达六行连续的「正在压缩上下文」，除最后一行外全部
永久转圈。成因在宿主之上：压缩标记是一个合成的 ACP tool call，历史按 `toolCallId`
合并，而两个 adapter 在 runtime 重复声明一次已在进行中的压缩时都会新造 id —— 于是终态
更新落地时只有最后一个 id 仍被关联。修复落在三层：Kimi ACP server 在压缩进行中忽略重复
声明；Claude 扩展在 turn 边界把被放弃的 legacy tool call 结算为 `failed`，而不是留在
`in_progress`；宿主在助手 turn 收尾时结算或移除该 turn 遗留的所有未终结标记。宿主这层
最先惠及用户：adapter 作为独立版本的 managed runtime 发布，已安装的旧 adapter 在重新
构建之前仍会继续产生重复 id。

## 发现

从 `~/.lody/loro-repo` 解出真实会话文档后，可以把两类情况区分开。合法多次压缩的 turn，
其标记之间隔着数百个 item，且每个标记都到达了终态。问题形态是彼此相邻、中间没有任何
内容的标记：`session-eec5b16a…` 的 `assistant:a5111fb7…` 在 items 109–114 有六个标记，
五个 `in_progress`、一个 `completed`，各自带着独立的 `context-compaction:<uuid>`。

产生这些数据的版本中，发射点是 Claude 扩展的 `status` 分支：每收到一帧
`status: "compacting"` 就 `randomUUID()` 新造 id，没有「已在压缩」守卫。已发布的
`claude-acp.js`（2026-09-19 构建）仍是这段代码；守卫直到 2026-09-20 的 submodule
升级才进入 `main`。

横向审计其余 adapter：`codex` 用 Codex thread item id、`dsh` 用 runtime 自带的
`compactionId`，本身即幂等；`pi` 复用同一个按 key 的 activity，并在 `finally` 里清扫
所有未结算项，是参考实现；`grok` 根本不发压缩标记。只有 `kimi` 的
`onCompactionStarted` 存在同类缺陷。

## 决策

三处改动，因为单独任何一层都覆盖不全。

`acp-extension-kimi` 在 `activeCompaction` 已存在时从 `onCompactionStarted` 提前返回。
这是该 adapter 的根因修复，与 `ContextCompactionLifecycle.start` 已有的守卫一致。

`acp-extension-claude` 在 `reset()` 中把仍打开的 legacy tool call 结算为 `failed`。
原注释以 ACP `ToolCallStatus` 没有 cancelled 态为由不做处理，但替代结果是一行永久转圈，
且宿主本来就把未结束的压缩视为 failed。`compaction_update` 呈现保留其 `cancelled`
终态；Lody 并未声明 `clientCapabilities.session.compaction`，真正触达用户的正是 legacy
呈现。

宿主在 `markAssistantTurnFinished` 中无条件结算标记。此前的
`settleContextCompactionAsFailed` 开关只在「恰好知道 provider 失败」的路径上生效；而一个
在已结束 turn 上仍打开的标记，无论原因都是陈旧的，因此该开关连同其传递链一并删除。
被后续压缩标记取代的标记按移除处理而非标记为 failed：它们是同一次压缩的重复身份，本身
从未报告过结果，标成 failed 只会把 n 个转圈换成 n 个假失败。之后若 provider 仍为同一
`toolCallId` 发来更新，以该更新为准，因为历史按 id 合并。

曾考虑只在渲染层归并这一段连续标记，已否决：那只治症状，且是唯一无法同时修正持久化记录
的位置，陈旧标记会留在导出和分享的历史里。

## 验证

`acp-extension-claude`：1369 个测试通过。一处既有断言被修改——从 stream 心跳打开的压缩
现在会在 turn 边界收到终态 `failed`，这正是本次变更的行为。

`acp-extension-kimi`：`lody-session-updates.test.ts` 通过（10 个测试）。消融该守卫会让
新增的重复声明测试失败，证明它确实能捕获回归。

宿主：`assistant-turn-finalize`、`message-handler-acp-batching`、
`session-execution-service`、`local-project-history-sync-service` 均通过。消融收尾清扫
会让三个新增测试失败。`message-handler-acp-batching` 用例跨越真实的 `SessionDocument`
边界，覆盖重新加载以及迟到的 provider 更新覆盖已结算状态。

未验证：没有针对重新构建的 managed runtime 做端到端运行。在 adapter 重新构建并发布之前，
用户看到的是宿主这层清扫的效果。

## 后续

`codex` 与 `dsh` 在压缩被中断时仍可能遗留单个标记，因为二者都没有 turn 边界清扫。宿主
清扫已覆盖该情形，因此未对它们做 adapter 改动。
