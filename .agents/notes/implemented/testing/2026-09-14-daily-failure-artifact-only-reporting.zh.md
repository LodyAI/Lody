# 将 Desktop Daily 失败证据仅保留在 Actions artifact

Status: implemented
Translation: current

[English](2026-09-14-daily-failure-artifact-only-reporting.md) | 中文

## 摘要

Desktop Daily 失败上报原本尝试把每段 WebM 录像上传到托管的失败 Issue，但
GitHub CLI 不接受工作流的 GitHub App installation token 进行媒体上传。reconciler
现在为每次失败运行发布一条幂等的纯文本摘要，并把录像、trace、截图、日志和运行时证据
留在现有 Actions artifact 中。这样无需引入长期用户凭证，也消除了二次上报失败；代价是
维护者需要打开 Actions run 才能检查证据。

## 证据

[上报 run 34819857885](https://github.com/LodyAI/Lody/actions/runs/34819857885)
成功协调了 [Issue 507](https://github.com/LodyAI/Lody/issues/507)，找到并下载
canonical Daily artifact，也准备好了评论，随后在执行 `gh issue comment --attach` 时因
`unsupported authentication type` 失败。GitHub Actions 提供 GitHub App installation
token，而 GitHub CLI 的附件上传器只接受 OAuth token、classic personal access token 和
fine-grained personal access token。

[GitHub 将 `GITHUB_TOKEN` 定义为 installation access token](https://docs.github.com/en/actions/concepts/security/github_token)，
而
[GitHub CLI v2.100.0 uploader allowlist](https://github.com/cli/cli/blob/v2.100.0/internal/attachments/client.go#L71-L84)
不包含 installation token。

更早的运行没有验证到这条路径：当时 canonical evidence 没有索引到录像，因此同一命令
只发布普通评论，没有实际执行媒体上传。

## 决策

Daily reconciler 保留 `actions: read` 以发现 suite 和 canonical artifact，保留
`contents: read` 以 checkout 可信上报代码，并保留 `issues: write` 以维护失败 Issue。它不再
下载 artifact，也不再安装单独的 GitHub CLI binary。每次失败运行只发布 bot-owned 摘要
marker、commit、workflow-run 链接和 artifact 名称；重新运行时会找到该 marker，不会重复
评论。

PR failure reporter 保持不变。本次决策只覆盖观察到故障后明确要求调整的
default-branch Daily failure Issue。它保留
[Desktop Daily 平台启动说明](2026-09-08-desktop-daily-platform-bootstrap.zh.md)描述的
macOS-first canonical artifact 选择，只改变 artifact 的呈现方式。产品行为和 E2E 场景
覆盖不变，因此不需要修改 Spec。

## 备选方案与取舍

fine-grained personal access token 可以保留内联视频，但会仅为诊断便利引入长期用户凭证。
将证据保留在 Actions 中，可以继续使用现有短期 workflow token 和 artifact 保留控制。
Issue 读者会失去内联播放，但纯文本评论仍会标识准确的 run 和 artifact。

## 验证

policy 测试覆盖 artifact 存在与不可用两种摘要、稳定的逐 run marker，以及不出现
user-attachment URL。工作流审查确认 Daily 不再包含下载 evidence 或调用 GitHub CLI
上传附件的步骤。托管的 `workflow_run` 只能在变更进入默认分支且后续 Daily run 完成后
实际执行。
