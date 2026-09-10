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
The store binds credentials to the complete launch-relevant configuration. Its normal state has
one active binding. The post-probe commit window may hold exactly two bindings, the currently
published config and the desired config, until Flock publication selects the survivor. It has no
candidate generations or migration layer for this unreleased feature. The file stores a SHA-256
digest of the canonical launch binding rather than the raw binding and its environment values.
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
it is fresh for every submit attempt and is not part of the published Codex config or credential
record. The existing authentication slot and abort signal remain live through setup synchronization,
secret input, probe, credential staging, and config publication. The slot becomes committed in the
synchronous boundary immediately before the Flock commit: cancellation wins before that point and
is too late afterward. Remote HTTP endpoints are rejected; HTTPS and loopback HTTP are accepted.

## Failure and cleanup

A credential-changing edit is a replacement setup: the old `AgentConfig` remains published while
the desired config and in-memory key are probed. After the probe, the target daemon stores a
two-binding commit record, publishes the desired config, and prunes the old binding before
returning success. A crash before or after publication leaves the binding required by either
surviving Flock state available. Reconciliation runs once from authoritative startup state, not on
ordinary live queue drains, and removes the other binding. A post-commit flush failure reports
uncertain durability, retains both bindings, and makes the renderer resync instead of reporting a
normal failed save. A stale or superseded setup
returns a conflict. Automatic failure cleanup names the request's exact revision, so an old request
cannot cancel a newer setup. Metadata-only edits bypass provisioning, and a replacement commit
merges the latest published name, prompt, brand, and title-generation fields instead of replacing
them with a stale setup snapshot. Same-binding key rotation consumes the setup without rewriting
the published config.

Switching to ChatGPT or deleting a provider first writes a revision-independent setup cancellation
before changing the config. The durable wildcard prevents an in-flight replacement from
republishing the custom provider and also owns machine-local credential cleanup; explicitly adding
a later setup retracts it. The UI never waits for the target machine. Its daemon reconciles the
affected config ID after the cancellation is durably applied and removes the local credential only
after no published custom config or custom setup references it. This also covers a daemon that
observes only `custom → deleted` and never sees an intermediate non-custom config, without a second
cleanup row family.

## Evidence

The [draft specification](../../../../specs/codex-custom-endpoint-authentication.md) owns the
behavior. Shared tests cover endpoint policy, reversible overlays, collision rejection, malformed
configuration, setup revision parsing, wildcard cancellation, publication durability, and rejection
of the protocol-owned one-shot secret at the setup-row boundary. CLI tests cover delayed setup
visibility, forced key rotation, cancellation during a deferred live probe, the commit boundary,
same-binding rotation with uncertain flush, real-store publication uncertainty, dual-binding crash
recovery after another drain, wildcard cleanup replay, binding mismatch, digest-only binding
persistence, and credential injection at the common
session launch boundary. Component tests cover metadata-only edits, per-attempt revisions, exact
failure cancellation, the one-shot payload, and setup/cancellation Flock writer boundaries. A controlled loopback relay run
with bundled Codex 0.153.4 observed a streamed
`POST /v1/responses` request with the configured model and matching bearer credential; the relay
returned an intentional 401 after recording only the boolean credential match.
