# 外部 PR 的会话交接

Status: draft
Translation: current

[English](pr-conversation-handoff.md)

## 场景与意图

评审者收到 Agent 撰写的 fork PR，正文只有触发任务的 prompt，没有撰写会话。
评审者必须能区分已分享、用户拒绝、无法分享和未使用 Agent 四种情况。
删除分享小节不能再静默通过贡献检查。

## 职责

每个外部 PR 保留 `### Shared conversation`，并声明唯一的 `Status:`：
`shared`、`user-declined`、`unavailable` 或 `not-used`。已分享时填写 `Link:`，
提供任意撰写工具生成的公开 HTTP(S) 会话链接。其他状态填写具体的 `Reason:`；
无法分享需说明工具及其限制，未使用 Agent 需确认贡献并非由 Agent 撰写。

开 PR 前，撰写 Agent 请求用户发布会话并等待答复。发布需要用户确认；沉默不算
拒绝，Agent 不得编造链接、拒绝或工具限制。用户拒绝时，`### Original user prompt`
保留原始任务 prompt，并追加 `#### Sharing refusal (verbatim)`，在独立文本代码块中
逐字记录拒绝回复。只允许以明确标记遮盖私密片段；占位符或完全遮盖的回复不构成证据。

## 执行与限制

缺失或无效披露进入既有外部 PR 检查结果、待处理状态和七天修正期。已有外部 PR
在下次协调检查时同样适用新契约，没有旧 PR 豁免。同仓库分支、机器人和明确绕过
政策的 PR 保持既有豁免。

校验只检查结构、链接语法和证据是否存在，不访问链接、不证明其公开可访问性、
不判断是否实际使用 Agent，也不验证拒绝回复的真实性。这些声明由评审者判断。
会话公开仍然自愿，但必须交代分享状态。

## 依据

- [贡献规则](../.github/AGENTS.md)
- [PR 模板](../.github/PULL_REQUEST_TEMPLATE.md)
- [正文校验](../.github/scripts/check-pr-body.mjs)
- [行为测试](../.github/scripts/check-pr-template.test.mjs)
