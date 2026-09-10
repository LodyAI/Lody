# Codex custom endpoint authentication

Status: draft
Translation: pending

## Scenario

A user setting up Codex may authenticate with ChatGPT, or may have an API key for an
OpenAI-compatible gateway. Onboarding and Settings expose both choices in the Codex provider
form. The gateway must support the OpenAI Responses API.

## Behavior

ChatGPT remains the default and retains the device-login flow. Base URL + API Key creates a
Codex model provider that uses the Responses wire API and does not require OpenAI account
authentication. Credential-bearing endpoints must use HTTPS; HTTP is allowed only for localhost
and IP loopback. The shared builder enforces the same rule as the form.

The API key is one-shot renderer state. It must never enter `AgentConfig.env`, a
`ProviderSetupTask`, logs, or another workspace-readable document. The renderer submits it
through the encrypted Machine ACP authentication-input path. The target CLI stores it in a
machine-local credential record and injects it under the generated provider's `env_key` only
when the current launch configuration names the exact credential revision and matches the
record's binding. A changed endpoint, proxy, runtime, agent type, custom launch command, or
revision must fail closed. POSIX storage uses `0700` directories and `0600` files; Windows relies
on the inherited ACL of Lody's per-user data directory.

Creation and credential-changing edits use a non-secret durable setup draft with an exact
credential revision. The credential RPC waits for that revision to become visible on the target
daemon, accepts or replaces its key through an explicit provisioning action, and probes the
staged config. A successful probe publishes the final non-secret AgentConfig and removes the
setup in one Flock commit. During an edit, the previous published config and credential remain
usable until that commit. A crash, failed verification, or cancellation therefore cannot expose
a half-configured live provider. Machines that do not advertise the credential protocol cannot
submit this mode.

The dedicated form owns only the provider entry and ownership marker it generates. Returning to
ChatGPT restores the prior `model_provider` selector and removes the generated provider and
marker. Switching modes and deleting a provider also writes a durable credential-cleanup intent
before changing or deleting the config. The target daemon replays that intent whenever it is
online and removes the referenced local revision only after no published config or setup still
uses it; cleanup does not depend on observing an intermediate config revision. Existing
`CODEX_API_KEY`, unrelated providers, and other environment values remain unchanged. A malformed
`CODEX_CONFIG`, reserved provider-id collision, or marker collision is rejected instead of
overwritten. Arbitrary hand-written Codex configuration remains an advanced environment override.

The custom endpoint changes authentication and request routing, not runtime ownership. Lody
continues to install and manage the same Codex runtime unless the user separately supplies a
runtime binary override.

## Evidence

- [Shared provider configuration](../packages/shared/src/codex-provider-config.ts)
- [Machine-local credential store](../apps/cli/src/agent/provider-credential-store.ts)
- [Provider form](../packages/components/src/components/settings/agent-config-dialog.tsx)
- [CLI authentication lifecycle](../apps/cli/src/agent/README.md#authentication)

This revision records the requested integration as a draft; it has no linked human approval.
