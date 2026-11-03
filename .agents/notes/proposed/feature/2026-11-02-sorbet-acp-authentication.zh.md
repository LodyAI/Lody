# Sorbet ACP 认证

Status: proposed
Translation: current

[English](2026-11-02-sorbet-acp-authentication.md)

## 摘要

内置 Sorbet 需要代理驱动的认证和明确的凭据表单协商。它使用现有 ACP 认证生命周期，声明凭据表单版本 1，并通过现有受保护的 Machine RPC 路径传递表单回复。现有字段和认证方法限制继续适用；真实 Sorbet 认证仍未验证。

## 决策与证据

与[内置 Devin](2026-09-30-builtin-devin.zh.md)一样，Sorbet 使用代理公布的认证方法，而不是专用登录命令。远程输入加密给目标机器并绑定请求和交互；秘密字段默认值不会进入保留的表单进度。行为测试覆盖协商、表单回复和拒绝过期交互，但不能证明真实 Sorbet 二进制文件的行为或其凭据存储方式。认证支持文本、秘密和单选字段，不支持任意表单或终端认证方法。

Sorbet 自有的 `sorbet.dev` credentials v1 扩展列出已保存的服务商 ID 和凭据类型，并可移除单个服务商。它不表示账户身份、凭据有效性或环境变量提供的凭据。Lody 通过目标机器上有时限的独立进程调用，而不读取凭据文件，也不将其视为 Lody ACP 扩展。远程列举和登出要求 `sorbetCredentialsRemote` 与签名 E2EE owned execution；目标机器验证签名设备属于机器所有者的 membership。列举会启动进程，因此两种操作均使用执行日志；中断的登出结果可能未知。daemon 串行化其 Sorbet 认证和凭据变更；本机 socket 断连时取消子进程，清理未确认时阻止后续变更直至恢复。此所有权仅限当前 daemon，无法协调独立启动的 Sorbet 进程。[真实进程测试](../../../../apps/cli/src/agent/sorbet-acp-credentials.real-process.test.ts)使用合成凭据；真实 OAuth 仍未验证。

Sorbet 跟踪 npm 的 `alpha` 标签，使运行时修复可以独立于 Lody 发布。不同于精确版本的 Registry 包，浮动标签不能默认使用 `--prefer-offline`，因为 npm 可能无限期保留旧元数据（[Amp 证据](../../implemented/bug-fix/2026-10-14-amp-acp-registry-binary.zh.md)）。网络失败时，只有安全清理启动进程后才可回退已有缓存；没有缓存的离线启动仍会失败。浮动标签不代表能力版本，因此显式刷新会重新探测。

本次不将现有 Promise 认证生命周期迁移到 Effect：其启动、连接和关闭依赖尚不能构成独立的原生迁移单元。
