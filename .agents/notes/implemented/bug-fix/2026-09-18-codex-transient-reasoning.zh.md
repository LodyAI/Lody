# Codex reasoning 是实时状态，不是会话历史

Status: implemented
Translation: current

[English](2026-09-18-codex-transient-reasoning.md)

## 摘要

内置 Codex 先前会把 `agent_thought_chunk` 送入普通 ACP 历史回调，因此本应临时的 reasoning
会在轮次结束后仍被看见，也会出现在导出和重新打开的会话中。现在客户端只在进入
`HistoryWriter` 前截获这些 Codex chunk，提取有长度上限的当前摘要，并借助会话既有的临时
presence owner 作为 `running.detail` 发布。活动行只在 presence 新鲜时展示它；普通的
assistant/tool 更新会清空它，轮次清理也会移除它。已有的持久化 thought 条目不会被改写，
因为打开历史不等于迁移或获得删除用户数据的授权。

## 决策

### 在 ACP 客户端边界截获

在 renderer 过滤只会把已经持久化的 item 藏起来。在 history applier 过滤又太宽泛：其他 ACP
provider 的标准 `agent_thought_chunk` 仍有正常的 transcript 契约。`AgentClient` 已知当前选择的
provider，因此它是最窄的边界：可以让仅属于 Codex 的 reasoning 不进入任何下游历史消费者，
同时不改变其他 provider。

### 只传递有上限的实时标签

`SessionActivePresenceController` 是 live 会话状态唯一的发布者和清理者。`running.detail` 最多
承载 280 个字符，presence schema 会拒绝更长的值。这样状态行仍有用，但不会把 presence 变成
另一份 transcript 存储。tool、answer 或 plan 都会清除标签，轮次结束时 controller 也会清除
整个 presence。

## 验证

`agent-client-session-preparation.test.ts` 证明 Codex thought 不会调用历史回调，而非 Codex
thought 仍会调用；它还验证 tool 会清空实时标签。`session-active-presence.test.ts`、
`presence.test.ts` 和 `session-status-machine.test.ts` 覆盖 presence 发布、schema 长度限制和
running 状态形状。既有组件 typecheck 证明活动行读取新的临时 detail。
