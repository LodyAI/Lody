# 保留 Droid AskUser 的问题和答案

Status: implemented
Translation: current

[English](2026-11-03-droid-ask-user-elicitation.md)

## 摘要

Droid 的 AskUser 表单使用内部选项 ID，并将自定义文字放在配套字段。按照旧版 Claude 表单解析会隐藏具体问题、把 ID 显示为选项，并错误回传自定义答案。共享桥接现在识别完整的 Droid 表单，在持久化问题元数据中保留可读文字，再把提交的答案还原成 Droid 的 ID 和配套字段；其他表单沿用原有解析。问题卡片目前不展示问题的短标题，并且将自定义文字作为选择的替代，包括多选问题，不能在界面中将二者组合。

## 决策

Droid 1.1.0 使用固定消息 `Droid needs your answers to continue.`、必填的 `question_N` 字段，并为有选项的问题提供可选的 `question_N_other` 配套字段。单选使用 `oneOf`，多选使用 `items.anyOf`，两者均包含 `other` 选项。桥接只接受字段、选项 ID 与唯一显示文字都能无歧义映射的已识别格式；格式不完整时拒绝。原始请求保留文字到 ID 的映射，权限历史保存普通 Core 问题和用户可读的答案。自定义文字回传为 `other` 加配套字段；缺失或无效的必填答案会取消，而不会提交无效的接受结果。若其他兼容客户端提交选择和自定义文字的组合，映射可以处理；本次不改变卡片交互。

通用 Claude 和 Core 路径保持原有消息、自定义答案和备注语义。不新增 Provider 能力、持久化答案格式或界面控件。Droid 的固定消息和表单结构是兼容边界。消息匹配但格式不符时拒绝；消息不匹配时仍走通用路径，因此 Droid 协议变化后需要重新验证。

## 验证

[共享行为测试](../../../../packages/shared/tests/ask-user-question.test.ts)覆盖单选、多选、自由文字、自定义答案、无效表单和持久化权限历史。[卡片测试](../../../../packages/components/tests/ask-user-question-card.test.ts)通过真实解析器验证显示和提交。[CLI 边界测试](../../../../apps/cli/tests/agent-client-plan-mode.test.ts)验证请求和自定义答案经 AgentClient 转换。表单格式已与 Droid 1.1.0 官方发行二进制中提取的函数对照；真实 Droid 账户和完整桌面会话尚未验证。
