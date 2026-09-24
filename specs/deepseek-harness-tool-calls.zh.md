# DeepSeek Harness 工具调用可见性

Status: draft
Translation: current

[English](deepseek-harness-tool-calls.md)

## 行为

Harness 执行工具时，对话展示工具名称、输入、状态和结果，包括 MCP 工具与
`run_code` 内部分发的工具。并行调用彼此独立，不同会话的同名 ID 不得混合。
审批必须先展示待审批调用的详情，再让用户决定。

Provider adapter 负责原生事件到 ACP 的转换，复用标准工具更新，不引入 DSH
专属 host 协议或执行机制。Harness 继续负责执行、权限、取消和持久化。
文本和图片结果可见，未知内容仍可检查。展示函数失败或图片缺失不能抹掉调用及其
原始结果。成功修改文件时可携带结果阶段的 diff；待执行或失败的编辑不得展示为
已应用的修改。中断且没有已记录结果的调用应明确显示结果未知，不得伪造成功。

仅投影 ACP 所拥有会话的事件。子 Agent 对话、模型参数增量流、子进程实时输出
不在本契约范围内。PTC 内部调用使用独立行，不保证 UI 呈现嵌套布局。

## 证据

- [Provider 实现](../packages/acp-extension-dsh/src/tool-calls.ts)
- [ACP 边界测试](../packages/acp-extension-dsh/src/adapter.test.ts)
- [决策和验证](../.agents/notes/implemented/bug-fix/2026-09-24-dsh-tool-visibility.zh.md)
