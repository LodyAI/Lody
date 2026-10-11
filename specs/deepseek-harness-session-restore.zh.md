# DeepSeek Harness 会话恢复

Status: draft
Translation: current

[English](deepseek-harness-session-restore.md)

## 场景与契约

客户端在 ACP 运行时停止后继续已有 DeepSeek Harness 会话。Provider 声明标准 ACP
`loadSession` 和 session `resume`。两者均通过 Harness 恢复原生会话原 ID，不分叉，
也不创建带历史重放 prompt 的替代会话。Harness 负责存储锁及未结束轮次的恢复。
会话不存在或被占用、cwd 不匹配、被委派子代理的身份以及持久配置不可用时明确失败。

返回前，适配器挂载已存储的 Agent preset，恢复模型与推理选择，读取原生权限和 Plan
状态，并完成请求中 MCP 服务器的初始化。下一次 prompt 之前作出的模型选择也需持久化。
激活失败时释放运行时及 MCP 名称预留，修正问题后可以恢复同一身份。原生恢复可能追加
修复事件，因此这不是只读历史接口。

`session/load` 在返回前回放根会话的用户消息、助手文字／思考／图片、工具事件和标题。
合成注入上下文不作为人类消息展示。历史子代理会话不属于本契约。必要图片内容缺失时
load 失败。`session/resume` 恢复运行时而不回放聊天历史。两者重建用量统计，但不重复
计算历史工作；后续增量仅覆盖新增工作。两种操作均不回滚项目文件。客户端负责显示去重。

## 证据

- [适配器行为与原生探针](../packages/acp-extension-dsh/README.md#session-restoration)。
- [实现决策](../.agents/notes/implemented/feature/2026-10-09-dsh-session-restore.zh.md)。
- [独立的分叉契约](deepseek-harness-session-fork.zh.md)。
