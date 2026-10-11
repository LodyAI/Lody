# 恢复原生客户端的 GitHub 个人授权入口

Status: implemented
Translation: current

[English](2026-10-11-github-personal-authorization-entry.md)

## 摘要

支持云能力的原生客户端在开启个人身份后显示“需要授权”，却隐藏了完成授权所需的操作。
现在设置会显示“授权”，并通过外部浏览器打开当前工作区的 GitHub 设置页。
账号关联仍由网页完成，客户端现有的响应式查询负责显示授权结果。
这避免在原生壳内启动依赖浏览器 Cookie 的 OAuth；用户可能需要先在浏览器登录同一个 Lody 账号。

## 决策与证据

桌面及响应式移动设置中的 `canAuthorizePersonalGitHub` 原先均排除了 Electron 和原生壳。
现在工作区 slug 可用时允许这些客户端发起跳转，共用目标地址构建函数，采用
`VITE_SITE_URL` 及生产环境默认地址。打开失败沿用现有错误提示，并解除忙碌状态以便重试。
URL 不包含令牌或会话凭证。

保留网页关联流程和 `githubIntegration` 能力边界，OSS 本地桌面仍不提供云 GitHub 设置。
没有选择从原生认证客户端直接启动 OAuth，因为其跳转及 Cookie 上下文不同于浏览器。
本修复补充此前的[个人授权状态修复](2026-09-30-github-personal-identity-silent-fallback.zh.md)。

## 验证

现有 GitHub 设置测试覆盖原生客户端缺失或过期授权、外部目标地址、打开失败后重试、
网页账号关联、已授权状态隐藏操作，以及本地能力门控。
真实 GitHub OAuth 的完整流程需要真实账号，不属于这些确定性测试的验证范围。

类型、lint、格式、文档、翻译及边界检查通过。全量检查停在两个 CLI 环境相关失败；
临时目录改为规范路径并移除会话注入的 Git 包装器后，两组测试共 25 项全部通过。
