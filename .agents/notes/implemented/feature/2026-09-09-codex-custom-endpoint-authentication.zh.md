# Codex Base URL 与 API Key 配置

Status: implemented
Translation: current

[English](2026-09-09-codex-custom-endpoint-authentication.md)

## 摘要

Codex setup 将机器现有的 ChatGPT 登录和带有自有 API key 的自定义端点作为同一 runtime
的两份独立配置。自定义配置复用 `AgentConfig.env`，与其他 API-key Provider 保持一致，
认证方式按配置选择。该设计明确接受 key 随 workspace 同步，并把功能范围限制在新建
Session 时选择配置。

## 决策

表单为 Responses API 生成 Codex `model_providers` 条目，并把该配置和它引用的 API key
一起存入 `AgentConfig.env`。现有 AgentConfig 写入、provider setup、进程启动和同步路径
仍是唯一生命周期。本功能不再引入机器本地凭据库、凭据 RPC、setup revision、跨存储
提交、启动 hydration、取消协议扩展或崩溃恢复算法。

生成的 provider 使用由表单拥有的 provider ID、环境变量名和标记，使表单能够更新字段、
保留无关的 `CODEX_CONFIG` 内容、恢复之前的 provider 选择，并避免接管手写配置。端点校验
允许 HTTPS 和回环 HTTP。API key 对已经处理 `AgentConfig.env` 的存储与同步边界可见；这
与现有 API-key Provider 采用相同且明确的产品取舍。

认证跟随所选配置。对于完整的生成式 API-key 配置，Lody 隐藏原生登录操作。Codex ACP
适配器还会独立检查启动时所选 provider 的 `requires_openai_auth` 字段；当其为 false 时，
跳过原生账号读取。这可防止 API-key 配置与验证修改机器上的 ChatGPT 登录，同时不改变
ChatGPT 配置的行为。

## 范围限制

实现支持在创建新 Session 时选择任一 Codex 配置。不保证已有 Session 的替换或恢复能够
安全切换认证模式，也不引入多个 ChatGPT 身份。如果未来规定共享文档不得保存 secret，
应为所有 Provider 统一设计和迁移凭据边界，而不是只为 Codex 增加特殊机制。

## 验证

共享测试覆盖生成配置的所有权、移除往返、凭据存储、端点校验和登录资格。组件测试覆盖
创建与编辑表单，并确认 API key 随 `AgentConfig.env` 提交。适配器测试覆盖所选 provider
设置 `requires_openai_auth = false` 时跳过原生账号读取。

行为所有者仍是 draft 状态的
[Spec](../../../../specs/codex-custom-endpoint-authentication.zh.md)。
