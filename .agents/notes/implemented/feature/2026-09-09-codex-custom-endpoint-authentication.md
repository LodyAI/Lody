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
Its versioned envelope also stores non-secret workspace/config identity so startup recovery can
enumerate an orphan after a legacy client deletes the only workspace row.
POSIX directories/files are hardened to `0700`/`0600`. Windows inherits the ACL of Lody's
per-user data directory. Every session spawn, including cold fork and edit-and-resend recovery,
injects the key at the shared `SessionManager` process-launch boundary only on an exact binding
match.

The provider uses a Lody-owned environment key and a separate ownership marker. The marker records
the previous `model_provider` selector so switching back to ChatGPT is reversible without
copying an existing `CODEX_API_KEY` or reserved provider into Lody state. Invalid JSON and
namespace collisions fail rather than being normalized or overwritten.
The reserved one-shot credential key is rejected at shared AgentConfig write boundaries, not only
by ProviderSetup parsing. Read normalization also drops credential-bearing AgentConfig rows, so
generic create/update/show paths cannot persist or disclose the secret.

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
The verification probe itself does not mutate the shared capability cache. Its result is handed to
the setup manager as a deferred publication and is cached only after the exact setup revision wins
durable AgentConfig publication inside the per-config credential mutation sequence. Cancelled,
superseded, failed, and durability-uncertain attempts publish no capabilities.
Authenticated provisioning and background setup share the same deferred probe result. The probe
retains one publication promise to deduplicate cache writes; RPC responses are ordinary values
and do not require shared object identity.

## Failure and cleanup

A credential-changing edit is a replacement setup: the old `AgentConfig` remains published while
the desired config and in-memory key are probed. After the probe, the target daemon stores a
two-binding commit record, publishes the desired config, and prunes the old binding before
returning success. A crash before or after publication leaves the binding required by either
surviving Flock state available. Reconciliation runs once from authoritative startup state, not on
ordinary live queue drains, and removes the other binding. Its initial snapshot selects only IDs;
each ID's references are re-read inside the per-config credential mutation sequence so concurrent
publication cannot be pruned by a stale startup snapshot. A post-commit flush failure reports
uncertain durability, retains both bindings, and makes the renderer resync instead of reporting a
normal failed save. Capability-cache publication is best effort after the config commit. The
renderer therefore accepts an authenticated provisioning response even when
`capabilitiesRefreshed` is false; that flag cannot authorize failure compensation for a config
already committed. A stale or superseded setup
returns a conflict. Automatic failure cleanup names the request's exact revision, so an old request
cannot cancel a newer setup. Metadata-only edits bypass provisioning, and a replacement commit
merges the latest published name, prompt, brand, and title-generation fields instead of replacing
them with a stale setup snapshot. Same-binding key rotation consumes the setup without rewriting
the published config.

Switching to ChatGPT or deleting a provider first writes a revision-independent setup cancellation
before changing the config. The durable wildcard prevents an in-flight replacement from
republishing the custom provider and also owns machine-local credential cleanup; explicitly adding
a later setup retracts it atomically with writing the fresh setup revision. A replica therefore
cannot observe the wildcard removed while an older replacement remains the current setup. The
cancellation's optimistic projection may hide the config locally, so the following durable delete
carries the previously captured config rather than looking it up in that cache. The UI never waits
for the target machine. Its daemon reconciles the affected config ID after the cancellation is
durably applied and removes the local credential only after no published custom config or custom
setup references it. This also covers a daemon that observes only `custom → deleted` and never sees
an intermediate non-custom config, without a second cleanup row family. Generic CLI deletion of a
custom Codex endpoint now uses that same atomic wildcard-cancellation protocol. Startup recovery also unions locally
enumerated credential IDs with workspace row IDs, allowing it to collect credentials orphaned by
older direct-delete clients.

## Evidence

### Ablation review

The branch review compared each removal with the existing behavioral suites:

| Removal                                                                              | Observed result                                                                                                                                                  | Decision                                                                             |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Previous credential binding during staging                                           | Two real-store tests failed: the published endpoint lost its key during the commit window and after recovery to the old config.                                  | Retain both bindings until publication is durable.                                   |
| Cached RPC response object and its `published` flag                                  | Only reference-identity assertions failed; all response fields and the single probe/publication remained equal.                                                  | Remove the cache and assert response values.                                         |
| V1 credential reader and V2 envelope factory                                         | All seven real-store tests and setup recovery tests passed with the existing V2 writer.                                                                          | Keep one strict V2 schema; this unreleased feature has no V1 migration contract.     |
| Recomputing an already-resolved launch snapshot and requiring unused identity fields | Session execution and manager suites, plus CLI typechecking, passed.                                                                                             | Reuse the snapshot and retain only the three launch fields consumed by the resolver. |
| Requiring capability-cache success for an authenticated credential save              | New renderer tests reproduced both durable and uncertain saves being rejected; removing the condition made both pass, with uncertain results waiting for resync. | Let the committed authentication outcome own save success.                           |

No endpoint, binding, cancellation, publication-order, or crash-recovery guarantee was removed.
The V2 envelope remains unchanged. Older experimental V1 files are no longer read and require
credential provisioning again. The review used synthetic fixtures and did not send credentials
to a live provider. Component onboarding tests require Node 22 here: the installed Node 26
exposes an unavailable global `localStorage` to the test environment.

### Feature coverage

The [draft specification](../../../../specs/codex-custom-endpoint-authentication.md) owns the
behavior. Shared tests cover endpoint policy, reversible overlays, collision rejection, malformed
configuration, setup revision parsing, wildcard cancellation, publication durability, and rejection
of the protocol-owned one-shot secret at both setup and AgentConfig boundaries. CLI tests cover delayed setup
visibility, forced key rotation, cancellation during a deferred live probe, the commit boundary,
same-binding rotation with uncertain flush, real-store publication uncertainty, dual-binding crash
recovery after another drain, two-config recovery concurrent with publication, wildcard cleanup
replay, legacy direct-delete orphan enumeration, binding mismatch, digest-only binding persistence,
deferred capability publication, and credential injection at the common
session launch boundary. CLI coverage also holds an R1 credential stage across the atomic R2 merge,
rejects R1 publication, and then publishes R2. Component tests cover metadata-only edits,
per-attempt revisions, exact failure cancellation, the one-shot payload, and cancellation-first
offline config deletion through reload. A real two-replica Flock test covers atomic wildcard
retraction and setup replacement, including a setup-authoring failure that retains the barrier. A
controlled loopback relay run
with bundled Codex 0.153.4 observed a streamed
`POST /v1/responses` request with the configured model and matching bearer credential; the relay
returned an intentional 401 after recording only the boolean credential match.
