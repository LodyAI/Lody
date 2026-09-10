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
through the encrypted Machine ACP authentication-input path. During verification the target CLI
keeps the candidate key in memory. After a successful live probe, it replaces the single
machine-local active credential and publishes the desired config before acknowledging success.
The credential is injected under the generated provider's `env_key` only when the current launch
configuration matches the record's complete launch binding. A changed endpoint, proxy, runtime,
agent type, custom launch command, or launch-relevant environment value fails closed. POSIX
storage uses `0700` directories and `0600` files; Windows relies on the inherited ACL of Lody's
per-user data directory.

Creation, key rotation, and launch-binding changes use a non-secret durable setup draft with an
exact setup revision. The credential RPC waits for that revision to become visible on the target
daemon, always requests a replacement key, and probes the staged config with the in-memory
candidate. Probe failure writes no credential. Probe success stores the active machine-local
credential, publishes the final non-secret `AgentConfig`, and removes the setup before the RPC
acknowledges success. A superseded RPC returns a conflict instead of publishing or reporting
success. During an edit, the previous published config remains live until publication. Display
metadata, prompt, title-generation, and other non-binding edits update the published config
directly and do not request the API key or run a probe. Machines that do not advertise the
credential protocol cannot submit credential-changing edits.

The dedicated form owns only the provider entry and ownership marker it generates. Returning to
ChatGPT restores the prior `model_provider` selector and removes the generated provider and
marker. Switching modes and deleting a provider also writes a durable credential-cleanup intent
before changing or deleting the config. The target daemon replays that intent whenever it is
online and removes the local credential only after no published config or setup still uses it;
cleanup does not depend on observing an intermediate config revision. The tombstone remains
necessary until initial Machine Flock synchronization exposes an authoritative-complete boundary
that local garbage collection can prove. Existing
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
