# 按接收状态分类 MCP 同步失败

Status: implemented
Translation: current

[English](2026-09-27-mcp-sync-retry-classification.md)

## 摘要

网络中断此前可能在 MCP 中表现为不可重试的内部错误或命令拒绝；通用同步提示还会让调用方恢复一个从未被接收的 Operation。机器文档同步失败现在保留为可重试的类型化错误，`fetch failed` 映射为可重试的同步不可用，而接收前的同步失败明确要求重发完整请求。其他工具只得到不含 operation ID 的通用重试提示。分类范围限于已知的 fetch 和同步来源，其他错误维持原有行为。

## 决定与证据

Issue #400 报告了四种实际输出。MCP 边界曾把精确的 `TypeError('fetch failed')` 当作 `INTERNAL_ERROR`；`syncMachineFlockDocsForRead` 传播普通错误，最终落入 `COMMAND_REJECTED`。`WorkspaceSyncUnavailableError.toLodyError()` 又把实例消息替换成统一提示，甚至让 `session_list` 收到 `operationId` 建议。四种异步 Command 入口均在接收 Operation 前同步工作区元数据。

本改动在机器文档同步边界赋予明确错误类型，在 MCP 边界识别精确的 fetch 错误，并区分通用同步提示与接收前的 Command 提示。批量条目验证继续逐项报告失败。按任意消息片段扩大分类可能把程序错误误判为可重试故障，因此没有采用。

## 验证与限制

回归测试覆盖机器文档边界、MCP 错误响应和 Operation 接受前的重试指引。没有在真实网络中断下复现。独立的 issue #398 讨论本地项目新鲜度读取是否应阻止创建 session；本记录只处理确需同步且同步失败时的分类。
