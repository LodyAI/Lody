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
keeps the candidate key in memory. After a successful live probe, it opens a short machine-local
commit window that retains at most the currently published and desired credential bindings,
publishes the desired config, and then prunes the old binding before acknowledging success.
Either binding can still launch after a daemon crash on either side of publication; an
authoritative startup recovery retains only the binding referenced by the surviving config or
setup. Ordinary queue drains never reconcile from live Flock state because a post-commit flush
failure leaves that state ahead of the last proven durable snapshot. Startup recovery snapshots
only config IDs; it reads each ID's current references inside that config's credential mutation
sequence so a concurrent publication cannot be reconciled against stale bindings.
Every shared Machine Flock AgentConfig writer rejects the reserved credential key, including an
empty value, and AgentConfig readers discard legacy or externally authored rows that contain it.
Generic `agent-config create`, `update`, and `show` therefore cannot persist or reveal the key by
bypassing the provider setup flow. Reserved-key comparison, generated-environment cleanup,
credential binding, and Settings filtering are ASCII case-insensitive because Windows process
environments treat differently cased names as the same slot.
The credential is injected under the generated provider's `env_key` only when the current launch
configuration hashes to the record's SHA-256 digest of the canonical launch binding. The raw
binding is not persisted. A changed endpoint, proxy, runtime, agent type, custom launch command,
or launch-relevant environment value fails closed. POSIX storage uses `0700` directories and
`0600` files; Windows relies on the inherited ACL of Lody's per-user data directory.

Creation, key rotation, and launch-binding changes use a non-secret durable setup draft with an
exact setup revision. The credential RPC waits for that revision to become visible on the target
daemon, always requests a replacement key, and probes the staged config with the in-memory
candidate. Immediately before credential staging, the daemon copies that revision into the
Lody-owned provider state as `credentialRevision`. Because provider state participates in the
canonical launch binding, two API keys never share a credential identity even when every other
launch field is unchanged. One authentication lifecycle and its abort signal cover setup
synchronization, secret input, probe, credential staging, and config publication. The final abort
check and transition to `committed` occur synchronously immediately before the Flock commit.
Cancellation before that boundary wins and publishes nothing; cancellation or timeout after it is
too late and cannot return `cancelled`. Probe failure writes no credential. A durable RPC success
means the final non-secret
`AgentConfig` was published and the setup was removed. A post-commit flush failure instead reports
uncertain publication durability, retains both credential bindings, and forces the renderer to
resync authoritative config before presenting the result; it is not handled as an ordinary failed
save or automatic retry. A superseded RPC returns a conflict instead of publishing or reporting
success. A provisioning probe is side-effect-free with respect to the shared capability cache.
Its result is published to that cache only after the exact setup revision wins a durable config
publication, inside the same per-config mutation sequence. Cancellation, supersession, probe
failure, and uncertain publication leave the cache unchanged. Each submit attempt has a fresh
setup revision. Once config publication succeeds, a later capability-cache write failure is
degraded derived state rather than credential failure; the authenticated result still completes
the save. While the save is running, the provider Dialog cannot be dismissed by its close button,
Escape, or outside interaction. Automatic failure compensation may cancel only that exact
revision. During an edit, the previous published launch config remains live
until publication. Display metadata, prompt, title-generation, and other non-binding edits update
the published config directly and do not request the API key or run a probe. A replacement
publication merges the latest published metadata instead of overwriting it with the setup snapshot.
Same-endpoint key rotation publishes the new `credentialRevision` in `AgentConfig`; that Flock
generation selects the matching key during crash recovery. The credential store rejects any
rotation that reaches it without a fresh identity before it can overwrite the active key.
Machines that do not advertise the credential protocol cannot submit credential-changing edits.

The dedicated form owns only the provider entry and ownership marker it generates. Returning to
ChatGPT restores the prior `model_provider` selector and removes the generated provider and
marker. Switching modes and deleting a provider writes a revision-independent setup cancellation
before changing or deleting the config. After projecting that cancellation optimistically, the
renderer uses its captured `AgentConfig` to perform the durable config deletion instead of looking
it up again in the projected cache. That durable wildcard is both the barrier against any in-flight
replacement and the cleanup intent. Cancellation precedence is `wildcard > exact`: delete upgrades
an existing revision-specific marker, while a later exact cancellation cannot weaken a wildcard.
An explicitly new setup retracts it only in the same atomic
Flock mutation that writes the fresh setup revision: durable state therefore contains either the
wildcard barrier or the new replacement intent, never an empty interval in which an older setup can
publish. Once the target daemon has durably applied the cancellation, it reconciles that config ID
and removes the local credential only when no published custom config or custom setup still
references it. Cleanup does not depend on observing an intermediate config revision or a second row
family. Existing
`CODEX_API_KEY`, unrelated providers, and other environment values remain unchanged. A malformed
`CODEX_CONFIG`, reserved provider-id collision, or marker collision is rejected instead of
overwritten. Arbitrary hand-written Codex configuration remains an advanced environment override.
The generic CLI `agent-config delete` applies the same wildcard cancellation and config removal in
one Flock commit when deleting a custom Codex endpoint. Credential records include non-secret
workspace/config identity so startup
recovery can enumerate and reconcile a credential even when an older client deleted the only
workspace row without writing the cancellation marker.

The custom endpoint changes authentication and request routing, not runtime ownership. Lody
continues to install and manage the same Codex runtime unless the user separately supplies a
runtime binary override.

## Evidence

- [Shared provider configuration](../packages/shared/src/codex-provider-config.ts)
- [Machine-local credential store](../apps/cli/src/agent/provider-credential-store.ts)
- [Provider form](../packages/components/src/components/settings/agent-config-dialog.tsx)
- [CLI authentication lifecycle](../apps/cli/src/agent/README.md#authentication)

This revision records the requested integration as a draft; it has no linked human approval.
