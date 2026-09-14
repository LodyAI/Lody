# Codex custom endpoint authentication

Status: draft
Translation: current

[中文](codex-custom-endpoint-authentication.zh.md)

## Scenario

A user may keep one Codex configuration backed by the machine's existing ChatGPT login and
create another Codex configuration for an OpenAI-compatible endpoint with its own API key.
Both configurations use the same managed Codex runtime and the existing `AgentConfig` model.

## Behavior

The Codex provider form offers ChatGPT and Base URL + API Key modes. ChatGPT remains the
default and uses the machine's native Codex login. API-key mode creates a generated
`model_providers` entry in `CODEX_CONFIG`, selects the Responses wire API, and sets
`requires_openai_auth = false`. The configured endpoint must use HTTPS, except that loopback
HTTP is allowed for local development.

The generated configuration and API key are stored together in `AgentConfig.env`, with the
same sharing and synchronization semantics as other API-key Providers. Lody does not create a
machine-local credential record or a cross-store publication transaction for this feature. The
form makes this synchronization trade-off explicit and prevents additional environment fields
from overriding the values it owns.

Authentication is selected per configuration. Starting or verifying an API-key configuration
must not invoke native Codex login or modify the machine's ChatGPT account state. The Codex ACP
adapter honors the selected model provider's `requires_openai_auth = false` before consulting
the native account. A ChatGPT configuration continues to use the existing device-login path.

The supported workflow chooses a configuration when creating a new Session. This feature does
not promise that an existing Session can switch between ChatGPT and API-key configurations, and
it does not model multiple ChatGPT logins as separate accounts.

If API keys must later be excluded from shared Provider documents, that change requires one
credential boundary for all Providers, with ownership, authorization, synchronization, offline,
and migration behavior defined before adoption. Codex custom endpoints do not introduce that
product-wide contract on their own.

## Evidence

- [Shared Codex provider configuration](../packages/shared/src/codex-provider-config.ts)
- [Provider form](../packages/components/src/components/settings/agent-config-dialog.tsx)
- [Codex adapter authentication](../packages/acp-extension-codex/src/CodexAcpClient.ts)
- [CLI authentication overview](../apps/cli/src/agent/README.md#authentication)

This revision records the requested integration as a draft; it has no linked human approval.
