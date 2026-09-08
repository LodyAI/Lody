# 复杂 Pull Request 必须提供可视化说明

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/520

[English](2026-09-08-required-pr-visual-explanations.md)

## 摘要

Pull Request 模板现在会调用 `$show-me`，要求每位作者说明可视化选择，并自动拒绝只有文字说明、
没有结构图的大型外部改动。

## 决定

Pull Request 模板现在固定包含必填的 `## Visual explanation`。Agent 必须调用 `$show-me`，
并选择最小且有助于评审的结构图。简单改动可以改为简短说明为什么图不会帮助评审。

GitHub scope 的 authoring 规则也会把这个要求应用于同仓库 PR。它们仍不受外部贡献策略自动检查，
但负责撰写的 Agent 必须遵循模板和可视化要求。

当改动跨越 component、runtime 或 authority 边界，或者改变多步控制流、数据流时，它在语义上
属于复杂改动。策略同时定义了可自动执行的下限：新增与删除合计超过 200 行时，必须提供受支持的
结构化代码块、Markdown 图片或可供评审访问的 HTML 链接。少于 200 行但语义复杂的情况仍由
评审者要求补图。

## 执行方式

`check-pr-body.mjs` 负责识别结构图，并可直接接收改动行数、通过 `--changed-lines` 接收，或从
Pull Request event 中读取。`pr-policy.mjs` 会把 GitHub 当前记录的 additions 和 deletions 传给
校验器。这样能保持正文规则确定，同时不会假装行数能识别所有复杂度。

支持的代码块与 `$show-me` 的形式一致：Mermaid、text 树或伪代码、结构化 diff，以及 TS/JS
component 或代码结构。校验器也接受 Markdown 图片和可评审的 HTML 链接。
