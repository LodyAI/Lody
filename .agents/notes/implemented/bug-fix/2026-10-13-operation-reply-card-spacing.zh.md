# Operation 行在下方预留 surfaceGap

Status: implemented
Translation: current
PR: [#1547](https://github.com/LodyAI/Lody/pull/1547)

[English](2026-10-13-operation-reply-card-spacing.md)

## 摘要

Operation 完成与进度系统行——"收到回复"卡片、已创建会话卡片和批量结果——
此前在轮次之间只使用普通的 8px 消息 padding。卡片上方的间距由上一轮自带的
底部 padding 组合后已达到 16px 的 surfaceGap，但下方只有 8px，带边框的卡片
紧贴下一轮的行首，视觉上粘连。现在包含 Operation 条目的行上方保留消息
padding、下方预留 `surfaceGap`，批量结果标题与其卡片之间增加了小间距。
代价是会话占用的高度略有增加，换来清晰的对象边界。

## 决策与依据

[节奏 Spec](../../../../specs/conversation-rhythm.zh.md) 拥有间距契约，现已
声明 Operation 系统行是轮次之间的富表面。取值由 `surface.ts` 的
`conversationSurface.operationSurface` 承载，`ChatItem` 在系统消息包含
`isOperationSurfaceItem` 时应用它；`OperationCompletionBatchView` 改为
`gap-1.5` 纵栈，使"N 项任务结果"标签不再直接贴在第一张卡片上。

顶部 padding 保持不变是有意的：该卡片报告的是上一轮发出的请求，应与上一轮
更近、与下一轮更远；仅扩大下方预留即可修复拥挤的一侧，同时不削弱归属关系。
曾考虑过对称的 `paddingBlock: surfaceGap`，因上述原因放弃。

## 验证与限制

`@lody/components` 类型检查与 Oxfmt 通过；message-content-guards 与
session-relation-card 测试共 28 项通过。间距依据 `view.tsx`/`surface.ts` 中
行 padding 的组合关系验证；本工作区未截取前后对比图，视觉差异按 token 取值
（卡片下方 8px → `surfaceGap` 约 16px）推断而非像素测量。
