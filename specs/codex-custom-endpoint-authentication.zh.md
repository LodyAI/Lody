# Codex 自定义端点认证

Status: draft
Translation: current

[English](codex-custom-endpoint-authentication.md)

## 场景

用户可以保留一个使用机器现有 ChatGPT 登录的 Codex 配置，同时创建另一个使用自有 API
key 的 OpenAI 兼容端点配置。两份配置使用同一个托管 Codex runtime，并复用现有
`AgentConfig` 模型。

## 行为

Codex provider 表单提供 ChatGPT 和 Base URL + API Key 两种模式。ChatGPT 仍是默认项，
使用机器上的 Codex 原生登录。API-key 模式在 `CODEX_CONFIG` 中生成并选择一个
`model_providers` 条目，使用 Responses wire API，并设置 `requires_openai_auth = false`。
端点必须使用 HTTPS；本地开发时允许回环地址使用 HTTP。

生成的配置与 API key 一起保存在 `AgentConfig.env`，其共享和同步语义与其他 API-key
Provider 相同。Lody 不为此功能建立机器本地凭据记录或跨存储发布事务。表单会明确提示
这一同步取舍，并阻止附加环境变量覆盖其管理的值。

认证按配置选择。启动或验证 API-key 配置时，不得执行 Codex 原生登录，也不得修改机器
的 ChatGPT 账号状态。Codex ACP 适配器在读取原生账号之前，先遵守所选模型 provider 的
`requires_openai_auth = false`。ChatGPT 配置继续使用现有设备登录流程。

受支持的流程是在创建新 Session 时选择配置。本功能不承诺已有 Session 能在 ChatGPT 与
API-key 配置之间切换，也不会把多个 ChatGPT 登录建模为独立账号。

如果未来要求 API key 不进入共享 Provider 文档，应先为所有 Provider 定义统一的凭据
边界，包括所有权、授权、同步、离线和迁移行为，再逐步采用。Codex 自定义端点不会单独
引入这项产品级契约。

## 证据

- [共享 Codex provider 配置](../packages/shared/src/codex-provider-config.ts)
- [Provider 表单](../packages/components/src/components/settings/agent-config-dialog.tsx)
- [Codex 适配器认证](../packages/acp-extension-codex/src/CodexAcpClient.ts)
- [CLI 认证概览](../apps/cli/src/agent/README.md#authentication)

此修订将所请求的集成记录为 draft；尚无对应的人类批准链接。
