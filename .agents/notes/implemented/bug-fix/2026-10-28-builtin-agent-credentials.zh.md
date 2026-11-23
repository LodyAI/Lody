# 内置 Agent 凭据检测

Status: implemented
Translation: current

[English](2026-10-28-builtin-agent-credentials.md)

## 摘要

此前即使本地没有凭据也会自动注册 Kimi 和 Grok。默认注册现在只检查各自的凭据文件是否存在，不读取密钥。显式 CLI 选择和用户删除后的行为不变。文件存在不代表凭据有效。

Kimi 使用 `KIMI_CODE_HOME/credentials/kimi-code.json`，Grok 使用 `GROK_HOME/auth.json`，未设置时使用各自默认目录。检测在后台启动时执行；之后登录需要重启才能自动注册。仍可手动创建 Provider。
