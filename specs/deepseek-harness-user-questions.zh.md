# DeepSeek Harness 用户提问

Status: draft
Translation: current

[English](deepseek-harness-user-questions.md)

## 行为

存活的根 Harness Agent 调用 `ask_user_question` 时，Lody 展示已有 Ask Question
卡片，并将用户提交的答案返回给等待中的工具。模型是否拥有该工具仍由 preset
决定，`minimal` 不因此新增工具。任何权限模式下，问题都需要用户交互。

DSH adapter 负责原生协议与 ACP 的转换。标准 `elicitation/create` 和 Core
`_meta.lody.elicitation` 复用现有 host 的解析、交互和答案持久化，不增加 DSH
专属 host/UI 协议。问题 id 和选项标签原样往返。支持多问题、单选、多选、自由
文本和 Other。声明 Core answer notes 能力的客户端可同时返回多选结果与 custom
文本；旧客户端保留替换式 Other。生成的表单 key 和仅供自定义答案使用的 UI
选项不得与原生 id 或选项标签冲突。

Plan-review intent 使用通用问题卡片展示问题与完整计划详情。adapter 返回选择
的标签，包括声明的批准标签，不改变 Plan Mode 或权限策略。

Harness 保留精确存活实例与运行时根 Agent 校验。adapter 只接管自身 Agent 作用域
的问题。每个 session 独立排队。abort/cancel/close 释放当前和排队工具，跳过已取消
的等待项，忽略迟到答案。用户拒绝、非法答案、客户端能力缺失和传输失败均作为
工具失败返回，不伪装成成功的空答案或隐式批准。

## 限制与证据

SDK 1.3 的旧 AgentSideConnection 无法取消单个已发出的表单请求。工具 abort 会
释放 adapter 等待，但已发送的卡片可能保留到用户关闭或整轮取消。本修订不保证
独立工具 abort 时立即移除卡片。

- [Provider 实现与兼容策略](../packages/acp-extension-dsh/README.md#user-questions)
- [Core 答案备注契约](ask-question-answer-notes.zh.md)
- [实现与验证](../.agents/notes/implemented/feature/2026-09-20-dsh-user-questions.zh.md)
