# Ask Question 回答备注

Status: draft
Translation: current

[English](ask-question-answer-notes.md)

## 场景与契约

用户可以选择答案并补充可选备注，而不替换所选答案。Lody 通过工作区子模块
使用公开的 Core 0.1.6 契约。标准 ACP `elicitation/create` 承载表单：带有
`_meta.lody.elicitation: { version: 1, noteFor: "questionId" }` 的字符串属性
规范化为题目的 Core `note`，保留 schema key、标题、描述和秘密标记。
`customAnswerFor` 仍是替代答案。所有选项由 adapter 提供，包括需要时的
None of the above。

备注不能满足主问题的必填要求。选择选项保留备注，输入备注不进入替代答案模式。
带备注的问题在选中选项后停留当前页，方便用户补充说明。提交必须显式触发，
取消不提交草稿。

主答案与备注通过现有 `answers` map 和 ACP `content` 中的独立 key 提交。
备注必须是字符串，空字符串或纯空白备注省略。旧字符串及字符串数组答案仍兼容。
拒绝不存在的引用、自引用、链式引用、重复关联、同时声明备注和替代答案关联，
以及非字符串备注属性。备注 key 不能覆盖题目或其他备注，不能按 `_note` 后缀推断关联。

## 职责与兼容性

```text
ACP 表单 → 共享解析器 → Core 题目 + 备注
                           ↓
                       问题卡片草稿
                           ↓
               权限响应 / HistoryWriter
                     ↙             ↘
               ACP content       历史回放
```

共享解析器在表单入口及已持久化的规范化元数据读取处校验关联。卡片维护独立草稿，
秘密备注与主答案分别遮蔽。历史保存两个值，无需迁移存储；无备注的旧记录保持原有展示。
秘密值只在视觉上遮蔽，不从底层答案记录删除。

只有解析、编辑、提交、持久化和回放全部实现后，会话 ACP 客户端才同时声明标准
`elicitation.form` 与 Core
`clientCapabilities._meta.lody.elicitation: { version: 1, answerNotes: true }`。
认证 elicitation 不声明此能力。对于未声明能力的客户端，旧流程回退仍由 adapter
负责。CLI 的能力声明不能升级单独运行的旧 renderer。

## 证据

- [Core 发布契约](../packages/acp-extension-core/README.md#elicitation-answer-notes-016)
- [共享桥接与历史测试](../packages/shared/tests/ask-user-question.test.ts)
- [组件行为测试](../packages/components/tests/ask-user-question-card.test.ts)
- [真实组件故事](../packages/components/src/stories/AskUserQuestionCard.stories.tsx)
- [实现决策](../.agents/notes/implemented/feature/2026-09-20-ask-question-answer-notes.zh.md)
