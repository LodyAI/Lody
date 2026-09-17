# 共享对话链接取代 PR 交接字段

Status: implemented
Translation: current

[English](2026-09-17-shared-conversation-pr-handoff.md)

## 摘要

Pull Request 的 Context handoff 不再要求撰写 Agent 填写九个分项摘要与评审清单，
保留逐字原始 prompt 作为必填证据，并新增可选的 `### Shared conversation` 槽位
放置已发布 Lody 对话的公开链接——存在时它承载完整的撰写上下文。对于 fork 方式
的 pull request，Agent 会先请用户发布该对话；发布始终需要用户在应用内确认。

## 决定

`PULL_REQUEST_TEMPLATE.md` 移除了 `### Instructions for reviewing agents` 和
`### Authoring context`。这些必填字段与撰写对话已记录的内容重复，填写的值退化为
评审者无法对照真实会话核实的样板文字。

`### Shared conversation` 现在紧随 `### Original user prompt`，为 Context
handoff 块收尾。原始 prompt 继续作为必填的逐字证据，因为分享链接可能被撤销，
而 PR 正文是永久的。

该小节为可选：不存在可共享对话时作者整节删除，而不是在必填字段中声明缺失。
自动校验只约束外部 fork PR——恰恰是最不可能持有 Lody 分享的人群——且对话共享
本身仍是 draft 状态的进行中切换。在那里强制该字段只会增加摩擦，却无法覆盖规则
真正针对的 Agent；面向 Agent 的义务写在 `.github/AGENTS.md` 中。

发布遵循[对话共享](../../../../specs/session-sharing.md)：Agent 可以通过工具发起
请求，但只有用户能在已登录的应用中确认。因此 scoped 规则写为"开 fork-based
PR 前请用户发布"——handoff 块本就是外部专用，同仓库工作不会触发该请求——而不是
规定自动发布步骤，并禁止编造分享 URL。

## 执行方式

`check-pr-body.mjs` 不校验 `### Shared conversation`；context-handoff 标记内
仅 `### Original user prompt` 仍为必填。逐字段校验器随对应小节一并移除。同仓库
PR 不受自动检查约束，发布共享对话的请求规则也只适用于 fork-based PR。

## 验证

对 `.github/scripts` 各套件运行 `node --test`，覆盖了更新后的合法样例与省略可选
小节的用例。该新契约尚未在真实 pull request 上执行过。
