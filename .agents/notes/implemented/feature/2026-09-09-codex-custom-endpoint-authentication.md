# Codex Base URL and API Key setup

Status: implemented
Translation: current

[中文](2026-09-09-codex-custom-endpoint-authentication.zh.md)

## Abstract

Codex setup supports a machine's existing ChatGPT login and a custom endpoint with its own API
key as separate configurations of the same runtime. The custom configuration reuses
`AgentConfig.env`, matching other API-key Providers, and authentication is selected per config.
This intentionally accepts workspace synchronization of the key and limits the feature to
choosing a configuration for a new Session.

## Decision

The form generates a Codex `model_providers` entry for the Responses API and stores both that
configuration and its referenced API key in `AgentConfig.env`. The existing AgentConfig write,
provider setup, process launch, and synchronization paths remain the only lifecycle. There is no
machine-local credential store, credential RPC, setup revision, cross-store commit, launch
hydration, cancellation extension, or crash-recovery algorithm for this feature.

The generated provider uses an owned provider ID, environment key, and marker so the form can
update its fields, preserve unrelated `CODEX_CONFIG` content, restore the previous provider
selection, and avoid claiming hand-written configuration. Endpoint validation accepts HTTPS and
loopback HTTP. The API key is visible to every storage and synchronization boundary that already
handles `AgentConfig.env`; this is the same explicit product trade-off as existing API-key
Providers.

Authentication follows the selected config. Lody hides the native login action for a complete
generated API-key configuration. Independently, the Codex ACP adapter checks the selected startup
provider's `requires_openai_auth` field and skips native account inspection when it is false. This
prevents API-key setup and verification from changing the machine's ChatGPT login while leaving
ChatGPT configurations unchanged.

## Scope limit

The implementation supports selecting either Codex configuration for a new Session. Existing
Session replacement or resume is not guaranteed to switch authentication modes safely, and
multiple ChatGPT identities are not introduced. A future no-shared-secrets policy should be
designed and migrated as one Provider-wide credential boundary rather than added only for Codex.

## Verification

Shared tests cover generated config ownership, round-trip removal, credential storage, endpoint
validation, and login eligibility. Component tests cover create/edit form behavior and confirm the
API key is submitted in `AgentConfig.env`. Adapter tests cover skipping native account reads for a
selected provider with `requires_openai_auth = false`.

The owning behavior remains draft in
[the Spec](../../../../specs/codex-custom-endpoint-authentication.md).
