# 通过 ACP 展示 Harness 工具执行

Status: implemented
Translation: current

[English](2026-09-24-dsh-tool-visibility.md)

Provider PR: [acp-extension-dsh #22](https://github.com/LodyAI/acp-extension-dsh/pull/22)

## 摘要

DSH adapter 虽能执行工具，却只将上下文压缩展示为 ACP 工具调用，导致用户看不到
具体命令和结果，审批也只有 ID。现在 provider 将原生持久化工具事件（含 PTC
内部分发）转换为标准 ACP 生命周期，并补充审批详情。会话独立状态与顺序输出
保证身份隔离及图片投递，成功结果阶段的 diff 展示实际编辑。没有终态结果的调用
明确标记结果未知；实时 stdout 和子 Agent 对话转发不在本次改动范围内。

## 决策和证据

Harness 0.1.5-rc.2 发布包 `dsh-agent-loop` 在执行前写入 `tool/call`，之后写入
包含 `tool-result` 内容块的 `tool/result` 消息。`dsh-tools` 为 PTC 另行记录开始
和结果事件，携带子调用 ID 与已解码参数。使用这些已提交事实，而不使用可能重试的
模型流工具块，避免重复展示。

`ToolCallBridge` 保留原始输入输出，通过调用 Agent 的 scoped registry 获取可选
纯展示函数。未知内容退化为 JSON，缺失图片有可见占位。展示函数失败不能抹掉原始
结果。仅成功结果阶段的 diff 作为编辑证据。审批等待前序通知；回合结束或异常
prompt 收尾时关闭未完成行，不断言实际副作用成功或失败。

本改动补充[用户提问桥接](../feature/2026-09-20-dsh-user-questions.zh.md)，不需要
修改 host UI 或共享协议。[可见性契约](../../../../specs/deepseek-harness-tool-calls.zh.md)
保持 draft。

## 验证和限制

Provider 构建、类型检查、格式检查及 ACP 边界测试覆盖普通/MCP/PTC 调用、审批
详情、重复开始、非法参数、展示函数异常、失败编辑、取消、未知内容、缺失图片、
图片顺序投递与并发会话隔离。测试数据均为合成数据，没有模型请求或用户对话。
尚未运行真实桌面/模型会话。

已尝试根目录 `pnpm check` 和 `pnpm format`，但此嵌套 checkout 缺少 workspace
依赖（`tsgo` / `oxfmt`）。文档检查仍有未初始化的其他 adapter 子模块导致的既存
断链。这些限制不替代 provider 自身验证。
