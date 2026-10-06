# DeepSeek Harness 会话分叉

Status: draft
Translation: current

[English](deepseek-harness-session-fork.md)

## 场景

用户从 DSH 会话末尾或选定的历史轮次之后分叉，包括原会话仍在继续运行的情况。

## 契约

Provider 声明标准 ACP session fork 和 Core `forkAtTurn` 版本 1。根 prompt 入队被领取后及助手输出携带不透明原生 `turnId` 元数据。指定轮次的分叉复制到对应已结束轮次为止、包含结束事件的原生前缀；格式错误、未知和未结束目标必须报错，不得回退。不指定轮次时，仅在没有开放轮次的情况下复制完整快照，也允许复制空会话。源会话运行后续轮次时，仍能从更早已结束轮次分叉，且不取消或重新加载源会话。

包含压缩替换和插件状态的原生历史仍作为原生历史保存。Provider 创建独立根 Agent，保留源血缘及前缀配置，使用请求中的目标 cwd 和 MCP。无需重放文本 prompt 或调用模型。子会话原生持久化检查点成功后才能返回成功；失败时释放运行时资源。源 prompt 完成前也需等待已结束前缀落盘，以支持立即跨进程读取分叉。如果持久化失败可能残留产物，错误需给出子会话 ID 供诊断，不能声称已删除。

客户端负责显示历史复制和 Git worktree 行为；分叉不回滚文件。缺少 Provider 轮次标记的旧历史不得猜测精确切点。原始事件仍可读取时，可以按前缀恢复压缩前上下文。ACP load/resume 和未结束轮次内部截断不属于本版本。

## 证据和限制

- [适配器契约及验证](../packages/acp-extension-dsh/README.md#session-forks)。
- [实现决策](../.agents/notes/implemented/feature/2026-10-06-dsh-session-fork.zh.md)。
- ACP 边界测试和固定版原生事件存储探针覆盖复制及重建；模型续聊与实际磁盘重启尚未验证。
