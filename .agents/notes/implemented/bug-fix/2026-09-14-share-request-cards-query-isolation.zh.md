# 将失败的分享请求查询限制在自己的边界内

Status: implemented
Translation: current

[English](2026-09-14-share-request-cards-query-isolation.md)

PR：[#692](https://github.com/LodyAI/Lody/pull/692)

## 摘要

`sessionSharing:listRequests` 查询失败会摧毁整个对话：云查询在渲染期间抛出，而待确认的
分享卡片位于聊天流内部，因此最近的 `SessionChatStream` 边界用崩溃界面替换了整个对话。
现在这些卡片拥有自己的内联错误边界，降级为一行可重试的提示，对话保持挂载，同时该边界
仍然上报异常。这只是收敛影响范围；产生该服务端错误的后端故障无法在本仓库中诊断或修复，
遇到该问题的用户在查询恢复之前仍然看不到待确认的分享请求。

## 证据

用户报告的渲染进程错误，应用 0.87.0、构建 `bc60f869`：

```
Error: [CONVEX Q(sessionSharing:listRequests)] [Request ID: a99e396cc57c8c07] Server Error
Boundary: SessionChatStream
```

组件栈为 `RequestCards` → `SessionShareRequestCards` → … → `ErrorBoundary`，抛出点是
经由 `useSyncExternalStore` 快照读取到达的 `OptimisticQueryResults.queryResult`。这正是
Convex 报告查询失败的常规方式：在查询恢复之前，每次渲染都会抛出。
[`packages/platform/src/react.ts`](../../../../packages/platform/src/react.ts) 中的
`useCloudQuery` 返回 `Result | undefined`，对错误没有任何约定，因此所有调用方都继承了
这种抛出行为。

这次失败本身与对话无关，但卡片是作为聊天流的 `leadingContent` 渲染的，所以捕获它的
边界拥有整个消息列表。用户因为一个可选功能而失去了对话。

## 决定

该功能自身的决策仍记录在
[分享笔记](../feature/2026-09-09-session-sharing.zh.md)中，这里只关心其失败落在哪里。
`SessionShareRequestCards` 将 `RequestCards` 包在一个内联 `ErrorBoundary` 中
（`resetKeys` 取用户、工作区与会话，与既有的重挂载 key 一致）。回退 UI 是一行状态提示
加 **Retry**：点击后重置边界并重新订阅；若后端仍然故障，提示会立即回来，而由于边界没有
可变化的 key，不会触发自动重置循环。

该边界保留默认的 `propagateAuthErrors`，因此未认证的 Convex 错误仍会重新抛给应用的登录
恢复路径，而不是被显示成分享功能的失败。`componentDidCatch` 依旧把异常上报 PostHog，
所以这是收敛而非吞掉错误。

否决了两个替代方案。让 `CloudApi.useQuery` 容忍错误会改变公共 platform 端口契约并影响
其全部调用方，且会把硬失败一次性变成到处都是的静默 `undefined`。失败时什么都不渲染
也被否决：待确认请求会在没有任何信号的情况下消失——对发布而言是失败即关闭，但与
“Agent 从未请求过”无法区分。

## 验证与局限

`packages/components/tests/session-share-request-cards.test.tsx` 在一个替身对话边界下
渲染卡片并让云查询抛出，断言对话边界从未捕获，并断言查询恢复后点击 Retry 能重新显示
卡片。该测试在旧组件上失败。

服务端成因在本仓库边界之外：失败的查询位于托管后端，上面的 request ID 是唯一线索。在
后端修复之前，受影响的用户看到的是提示而不是待确认的分享请求。该回退界面不可达任何
可发布的操作。

## 同一份报告还暴露了失效的防循环预算

`ErrorBoundary` 的文档约定是：同一个重复错误在 `MAX_AUTOMATIC_RESETS` 次之后停止
`resetKeys` 自动恢复（见[崩溃恢复规则](../../../../packages/components/src/lib/AGENTS.md)）。
但对任何 Convex 失败它都没有生效：`errorSignature()` 以原始 message 为键，而 Convex 的
message 内嵌每次请求不同的 id ——
`[CONVEX Q(…)] [Request ID: a99e396cc57c8c07] Server Error` ——
于是同一个重复错误的每次出现都被当作新错误，预算永远到不了。用户来回切换会话时，崩溃的
子树会被无限重新渲染。同文件的 `computeErrorFingerprint()` 早就为分析分组剥离了这些 id，
只是签名没有复用它。

两者现在共用 `normalizeErrorMessage()`。放宽分组是有意的：仅在 id 或数字串上不同的两个
错误，对恢复而言就是同一个错误；查询名或错误类型不同的仍然会被区分开。

这也解释了为什么本次上报的崩溃可能一直在重复而未被察觉；进而说明：不能从崩溃报告的
render trace 推断后端失败是否具有确定性——trace 的记录点在边界之外，无论其下的子树是否
正在崩溃，它看起来都一样。

