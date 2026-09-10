# Codex Base URL and API Key setup

Status: implemented
Translation: pending

## Abstract

Codex setup offers ChatGPT device login and a Base URL + API Key mode in onboarding and
Settings. The custom mode uses a generated Responses API provider while keeping its credential
on the execution host.

## Decision

Workspace state stores only non-secret provider metadata. The renderer passes the API key through
the existing encrypted ACP authentication-input exchange. A candidate remains in daemon memory
through the live probe and is stored under `provider-credentials` only after that probe succeeds.
The store has one active record per workspace/config and binds it to the complete launch-relevant
configuration; it has no candidate generations or migration layer for this unreleased feature.
POSIX directories/files are hardened to `0700`/`0600`. Windows inherits the ACL of Lody's
per-user data directory. Every session spawn, including cold fork and edit-and-resend recovery,
injects the key at the shared `SessionManager` process-launch boundary only on an exact binding
match.

The provider uses a Lody-owned environment key and a separate ownership marker. The marker records
the previous `model_provider` selector so switching back to ChatGPT is reversible without
copying an existing `CODEX_API_KEY` or reserved provider into Lody state. Invalid JSON and
namespace collisions fail rather than being normalized or overwritten.

The feature requires a negotiated `codexCustomEndpointCredentials` capability. A setup row names
an expected non-secret setup revision and starts in `awaiting-auth`. The explicit
credential-provisioning RPC waits for that exact row on the target daemon, so an asynchronous
Flock upload cannot race config lookup. It always requests and replaces the submitted key, even
when the same endpoint already has a credential. The revision exists only in the setup and RPC;
it is not part of the published Codex config or credential record. Remote HTTP endpoints are
rejected; HTTPS and loopback HTTP are accepted.

## Failure and cleanup

A credential-changing edit is a replacement setup: the old `AgentConfig` remains published while
the desired config and in-memory key are probed. After the probe, the target daemon stores the
single active credential and publishes the desired config before returning success. A stale or
superseded setup returns a conflict. Metadata-only edits bypass provisioning, so changing a name,
prompt, brand, or title-generation setting does not ask for the existing API key.

Switching to ChatGPT or deleting a provider writes a durable cleanup intent before changing the
config. The UI never waits for the target machine. Its daemon reconciles the intent on events and
authoritative rescans, removes the local credential only after no published config or setup
references it, then consumes the intent. This also covers a daemon that observes only
`custom → deleted` and never sees an intermediate non-custom config.

The cleanup tombstone is retained because current initial Machine Flock synchronization does not
expose a proof that a local scan is authoritative and complete. Once that boundary exists, local
garbage collection can replace the tombstone without risking deletion during partial sync.

## Evidence

The [draft specification](../../../../specs/codex-custom-endpoint-authentication.md) owns the
behavior. Shared tests cover endpoint policy, reversible overlays, collision rejection, malformed
configuration, setup revision parsing, and rejection of the protocol-owned one-shot secret at the
setup-row boundary. CLI tests cover delayed setup visibility, forced key rotation, stale setup
conflicts, publication failure, durable cleanup replay, binding mismatch, and credential injection
at the common session launch boundary. Component tests cover metadata-only edits, the one-shot
payload, and the actual setup/cleanup Flock writer boundaries. A controlled loopback relay run
with bundled Codex 0.153.4 observed a streamed
`POST /v1/responses` request with the configured model and matching bearer credential; the relay
returned an intentional 401 after recording only the boolean credential match.
