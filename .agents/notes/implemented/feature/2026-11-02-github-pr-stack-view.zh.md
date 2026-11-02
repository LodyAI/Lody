# GitHub Pull request 堆叠上下文

Status: implemented
Translation: current

[English](2026-11-02-github-pr-stack-view.md)

## 摘要

GitHub 现在会明确记录 Pull request 堆叠。PR 面板读取成员关系和有序成员，显示状态及指向 GitHub 的链接。堆叠详情请求失败时，面板保留已知位置并提供 GitHub 链接。由于现有同步合并接口不支持堆叠，堆叠合并仍在 GitHub 完成。

## 决策和限制

采用 GitHub 的成员关系，而非推断分支关系：相关分支不一定是已登记的堆叠。堆叠详情使用与 PR 详情相同的访问身份读取；额外请求失败不影响 PR 的使用。各层链接在 GitHub 打开；面板内切换、创建和变基堆叠以及异步合并留待后续工作。执行旧版合并前重新读取 PR，防止面板打开后该 PR 加入堆叠。

堆叠各行复用现有 PR 状态图标和颜色，并高亮当前层。链接的无障碍标签包含状态，避免仅靠颜色传达信息。视觉规则参考 GitHub 的 [Primer 图标指南](https://primer.style/octicons/usage-guidelines/)。

GitHub 文档说明了[成员关系和合并要求](https://docs.github.com/en/pull-requests/reference/stacked-pull-requests-apis-and-webhooks)以及[堆叠接口](https://docs.github.com/en/rest/pulls/stacks)。本决策扩展已有的[本地观察决策](../feature/2026-09-24-local-github-pr-observation.zh.md)；仅有本地摘要访问权限时仍在外部打开 GitHub。
