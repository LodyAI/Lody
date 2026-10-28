# 保留批量创建会话时的 MCP 选择

Status: implemented
Translation: current

[English](2026-10-26-mcp-batch-create-selection.md)

## 摘要

`lody_session_create_many` 接受 MCP 服务器选择，但把批量条目转换为单会话创建命令时丢弃了该字段，导致显式选择回退到目标默认值。现在仅在字段已提供时才将其透传，保留省略、`[]` 和非空选择之间的区别。边界测试检查了已接受的规范命令、冻结的分发配置和实际创建配置；临时删除透传后，该测试按预期失败。

## 调查结果

- `SessionCreateBatchItemShape` 已接受可选的 `mcpServerIds`，MCP README 也说明省略表示使用目标默认值，`[]` 表示不选择任何服务器。
- 批量默认值和条目值会先合并，再转换为单会话输入。转换时遗漏了服务器选择，因此已接受的 Operation 无法冻结调用者请求的服务器。
- `buildMcpRunConfigCanonicalCommand` 专门处理 ACP 控制项，不包含 MCP 选择；缺失字段应在批量到单项的显式映射中补齐。

## 决策

仅当 `mcpServerIds` 不为 `undefined` 时，将它复制到单会话创建输入。这个条件属性既保留正常默认值解析，也保留显式空数组，无需增加辅助函数或状态。既有的规范命令和冻结目标配置路径会继续把选择传递到接受、恢复和实际创建阶段。

## 验证

回归测试调用真实批量创建处理函数，并分别传入省略、空数组和 `['server-a', 'server-b']` 三种条目。测试检查已接受的规范命令、冻结的逐目标分发配置和会话物化时收到的配置。临时删除透传行后，规范命令中的三个选择都变成省略值，测试失败；恢复透传后测试通过。临时变更没有进入最终差异。

测试使用 Node 26.12.1，并复用另一个 worktree 中已安装的依赖；Node 运行时下载到 npm 隔离缓存。PR 中会记录完整检查状态和环境限制。

## Review

[Draft PR #1907](https://github.com/LodyAI/Lody/pull/1907) 附有红灯和绿灯终端截图及定向回归证据。
