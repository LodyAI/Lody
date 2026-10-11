# 会话收尾状态

Status: draft
Translation: current

[English](session-finalization-status.md)

Agent 的 prompt 返回后，宿主可能仍在处理历史、用量和工作区信息。
当实时 presence 明确报告 `running + phase: finalizing` 时，会话显示
**收尾中…**，而不是隐藏活动提示或继续显示思考中。

收尾期间会话仍然忙碌。这个文案不会释放执行权、改变停止行为，或绕过现有
排队／引导发送规则。presence 清除后活动提示消失；新一轮 prompt 运行时恢复
正常活动提示。初始化和权限提示保留原有优先级。
历史中的完成记录本身不能证明会话正在收尾。未报告该可选阶段的旧宿主保留
原有活动显示。

## 依据

- `apps/cli/src/session/session-execution-service.ts` 发布该阶段。
- `packages/components/src/components/sessions/session-chat-interface.tsx` 显示文案。
- [决策记录](../.agents/notes/implemented/bug-fix/2026-10-06-finalizing-status-label.zh.md)。
