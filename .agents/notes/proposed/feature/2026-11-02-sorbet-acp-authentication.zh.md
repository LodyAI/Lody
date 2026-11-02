# Sorbet ACP 认证

Status: proposed
Translation: current

[English](2026-11-02-sorbet-acp-authentication.md)

## 摘要

内置 Sorbet 需要代理驱动的认证和明确的凭据表单协商。它使用现有 ACP 认证生命周期，声明凭据表单版本 1，并通过现有受保护的 Machine RPC 路径传递表单回复。现有字段和认证方法限制继续适用；真实 Sorbet 认证仍未验证。

## 决策与证据

与[内置 Devin](2026-09-30-builtin-devin.zh.md)一样，Sorbet 使用代理公布的认证方法，而不是专用登录命令。远程输入加密给目标机器并绑定请求和交互；秘密字段默认值不会进入保留的表单进度。行为测试覆盖协商、表单回复和拒绝过期交互，但不能证明真实 Sorbet 二进制文件的行为或其凭据存储方式。认证支持文本、秘密和单选字段，不支持任意表单或终端认证方法。

本次不将现有 Promise 认证生命周期迁移到 Effect：其启动、连接和关闭依赖尚不能构成独立的原生迁移单元。
