# 直接派生完成的 assistant 目标，移除 effect 镜像

Status: implemented
Translation: current

PR: [#1534](https://github.com/LodyAI/Lody/pull/1534)

[English](2026-10-13-completed-assistant-derived-state.md)

## 摘要

消息流原先在 effect 中通知父组件最后完成的 assistant ID，父组件再存入一份 state。父组件现在直接从当前 ConversationView 派生该 ID，复用消息流已有的索引查询。这移除了通知 effect 和额外状态更新，保留完成状态、空消息和重复 ID 的选择规则。它只是减少更新路径的小范围改造，不是另行调查的 React #185 崩溃的已验证修复。

## 决策和范围

`SessionChatInterface` 已经订阅 `useConversationVersion`。它按 view 和 version 缓存 `resolveLastAssistantTurnIds(conversationView).lastCompletedAssistantMessageId`，没有 view 时返回 null。不新增订阅、正文 lease 或完整历史实体化。切换 view 或完成状态变化时，在 render 中重新计算，不必等待子组件 effect 发布。

移除 `SessionChatStream.onLastCompletedAssistantMessageIdChange`、唯一调用点、上报 effect，以及父组件带 session 标记的状态镜像。标题栏 Fork、快捷操作和评价提示消费者继续使用相同规则选出的完成消息目标；消息流仍使用共享查询派生自己的渲染目标。

更广泛的[更新深度调查](../../proposed/bug-fix/2026-10-13-message-list-update-depth-investigation.zh.md) 仍是 proposed。滚动事务、同步布局测量、水合窗口、原生选择和滚动状态所有权不变。这些边界的改造需要独立复现和行为验收；删除本次 effect 不能证明原始崩溃的原因。

## 验证

现有消息项构建、会话读取与水合、Fork 目标菜单三组测试全部通过：三个文件、43 项测试。定向格式检查和 lint 完成；lint 在变更文件现有范围内报告警告。测试使用当前 checkout 的 workspace 源码，依赖树复用另一个本地 checkout，没有进行新的冻结锁文件安装。

最初普通测试命令找不到 Vitest。复用依赖后的包类型检查因 Electron/platform 依赖缺失和已有 SDK 类型不匹配而失败，不声称完整类型检查通过。沙箱外文档检查报告 82 个指向缺失 ACP 子模块文件的断链，变更文档范围内没有错误。根级 check/format 命令因缺少已安装工具而无法完成。未完成根级全量 check、生产崩溃复现或桌面真机验收。
