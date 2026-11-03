# Sorbet ACP 认证

Status: proposed
Translation: current

[English](2026-11-02-sorbet-acp-authentication.md)

## 摘要

内置 Sorbet 需要代理驱动的认证和明确的凭据表单协商。它使用现有 ACP 认证生命周期，声明凭据表单版本 1，并通过现有受保护的 Machine RPC 路径传递表单回复。现有字段和认证方法限制继续适用；真实 Sorbet 认证仍未验证。

## 决策与证据

与[内置 Devin](2026-09-30-builtin-devin.zh.md)一样，Sorbet 使用代理公布的认证方法，而不是专用登录命令。远程输入加密给目标机器并绑定请求和交互；秘密字段默认值不会进入保留的表单进度。行为测试覆盖协商、表单回复和拒绝过期交互，但不能证明真实 Sorbet 二进制文件的行为或其凭据存储方式。认证支持文本、秘密和单选字段，不支持任意表单或终端认证方法。

Sorbet 自有的 `sorbet.dev` credentials v1 扩展列出已保存的服务商 ID 和凭据类型，并可移除单个服务商。它不表示账户身份、凭据有效性或环境变量提供的凭据。Lody 通过有时限的本机独立进程调用，而不读取凭据文件，也不将其视为 Lody ACP 扩展。daemon 串行化其 Sorbet 认证和凭据变更；断连时取消子进程，清理未确认时阻止后续变更直至恢复。此所有权仅限当前 daemon，无法协调独立启动的 Sorbet 进程。[真实进程测试](../../../../apps/cli/src/agent/sorbet-acp-credentials.real-process.test.ts)使用合成凭据；真实 OAuth 仍未验证。

本次不将现有 Promise 认证生命周期迁移到 Effect：其启动、连接和关闭依赖尚不能构成独立的原生迁移单元。
