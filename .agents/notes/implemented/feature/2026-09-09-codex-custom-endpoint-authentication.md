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
published config and the desired config, until Flock publication selects the survivor. The
Lody-owned provider state carries the non-secret setup revision as its credential generation, so
two different keys cannot have the same binding even when the endpoint and every other launch
field are unchanged. This removes the need for a same-binding pending/committed state in the
credential file. The file stores a SHA-256
digest of the canonical launch binding rather than the raw binding and its environment values.
Its versioned envelope also stores non-secret workspace/config identity so startup recovery can
enumerate an orphan after a legacy client deletes the only workspace row.
POSIX directories/files are hardened to `0700`/`0600`. Windows inherits the ACL of Lody's
per-user data directory. Every session spawn, including cold fork and edit-and-resend recovery,
hydrates through a provider-neutral process-launch boundary. The machine-local store owns the
cross-store transaction and recovery algorithm; a small adapter owns Codex detection, binding
identity, secret validation, and environment injection. Adding another machine-local provider
credential therefore extends the adapter registry instead of adding another provider branch to
session or Machine RPC launch resolution. The V2 disk codec remains unchanged, including its
legacy `apiKey` field, while the transaction core handles an opaque string secret. Codex injects
the key only on an exact binding match.

The provider uses a Lody-owned environment key and a separate ownership marker. The marker records
the previous `model_provider` selector so switching back to ChatGPT is reversible without
copying an existing `CODEX_API_KEY` or reserved provider into Lody state. Invalid JSON and
namespace collisions fail rather than being normalized or overwritten.
The reserved one-shot credential key is rejected at shared AgentConfig write boundaries, not only
by ProviderSetup parsing. Read normalization also drops credential-bearing AgentConfig rows, so
generic create/update/show paths cannot persist or disclose the secret. One case-insensitive
predicate owns this boundary, binding exclusion, generated-environment cleanup, and Settings
filtering because Windows treats differently cased environment names as the same process slot.

The feature requires a negotiated `codexCustomEndpointCredentials` capability. A setup row names
an expected non-secret setup revision and starts in `awaiting-auth`. The explicit
credential-provisioning RPC waits for that exact row on the target daemon, so an asynchronous
Flock upload cannot race config lookup. The RPC also carries a non-secret SHA-256 digest of the
renderer-confirmed launch binding with that revision applied. The daemon checks the current row
against it before requesting the key and again immediately before staging, so another writer cannot
retain the revision while redirecting the one-shot key to a different endpoint. It always requests and replaces the submitted key, even
when the same endpoint already has a credential. The revision is fresh for every submit attempt.
The daemon embeds it into the desired provider state immediately before credential staging and
publishes that revisionized config only if the setup CAS wins. The existing authentication slot
and abort signal remain live through setup synchronization, secret input, probe, credential
staging, and config publication. The final abort check runs immediately before the Flock commit,
and the slot becomes committed synchronously after that commit returns. A synchronous commit
failure remains pre-commit and rolls back the staged credential; only a later flush failure has
uncertain durability. Cancellation wins before the commit boundary and is too late afterward.
Remote HTTP endpoints are rejected; HTTPS and loopback HTTP are accepted.
GitHub and other session-only environment is added after hydration against a captured canonical
AgentConfig; those temporary values therefore reach the child process without changing the
machine-local credential lookup identity in either cold or prepared session startup.
The verification probe itself does not mutate the shared capability cache. Its result is handed to
the setup manager as a deferred publication and is cached only after the exact setup revision wins
durable AgentConfig publication inside the per-config credential mutation sequence. Cancelled,
superseded, failed, and durability-uncertain attempts publish no capabilities.
Authenticated provisioning and background setup share the same deferred probe result. The probe
retains one publication promise to deduplicate cache writes; RPC responses are ordinary values
and do not require shared object identity. The provider Dialog remains mounted and non-dismissible
while its submit promise owns provisioning, so close affordances cannot leave hidden work running.

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
them with a stale setup snapshot. Same-endpoint key rotation publishes a new credential revision;
the credential store rejects a rotation without a fresh identity before it can replace the active
key.

Switching to ChatGPT or deleting a provider first writes a revision-independent setup cancellation
before changing the config. The durable wildcard prevents an in-flight replacement from
republishing the custom provider and also owns machine-local credential cleanup; explicitly adding
a later setup retracts it atomically with writing the fresh setup revision. A replica therefore
cannot observe the wildcard removed while an older replacement remains the current setup. A
wildcard cancellation also replaces an existing exact-revision marker, while exact cancellation
cannot downgrade a wildcard, so deletion still fences a stale replacement from another replica.
Renderer cancellation goes through one transactional `WorkspaceWriter` operation that reuses the
shared merge rule and returns the effective marker for optimistic projection; raw cancellation row
puts are not a supported path. The
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

| Removal                                                                              | Observed result                                                                                                                                                  | Decision                                                                                                 |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Previous credential binding during staging                                           | Two real-store tests failed: the published endpoint lost its key during the commit window and after recovery to the old config.                                  | Retain both bindings until publication is durable.                                                       |
| Cached RPC response object and its `published` flag                                  | Only reference-identity assertions failed; all response fields and the single probe/publication remained equal.                                                  | Remove the cache and assert response values.                                                             |
| V1 credential reader and V2 envelope factory                                         | All seven real-store tests and setup recovery tests passed with the existing V2 writer.                                                                          | Keep one strict V2 schema; this unreleased feature has no V1 migration contract.                         |
| Recomputing an already-resolved launch snapshot and requiring unused identity fields | Session execution and manager suites, plus CLI typechecking, passed.                                                                                             | Reuse the snapshot and retain only the three launch fields consumed by the resolver.                     |
| Requiring capability-cache success for an authenticated credential save              | New renderer tests reproduced both durable and uncertain saves being rejected; removing the condition made both pass, with uncertain results waiting for resync. | Let the committed authentication outcome own save success.                                               |
| Exact-case credential-key checks                                                     | Lowercase and mixed-case aliases crossed AgentConfig and binding filters even though Windows launch treats them as the reserved slot.                            | Use one case-insensitive shared predicate at every boundary.                                             |
| Same-binding key replacement                                                         | A crash after credential staging but before Flock commit lost the only copy of the previously published key.                                                     | Put the setup revision in provider state and make every credential generation a distinct launch binding. |
| Renderer cancellation row puts                                                       | A stale exact cancellation could overwrite a wildcard deletion barrier by bypassing the shared precedence.                                                       | Route cancellation through one writer operation that reuses the shared merge primitive.                  |

No endpoint, binding, cancellation, publication-order, or crash-recovery guarantee was removed.
The V2 envelope remains unchanged. Older experimental V1 files are no longer read and require
credential provisioning again. The review used synthetic fixtures and did not send credentials
to a live provider. Component onboarding tests require Node 22 here: the installed Node 26
exposes an unavailable global `localStorage` to the test environment.

### Feature coverage

The [draft specification](../../../../specs/codex-custom-endpoint-authentication.md) owns the
behavior. Shared tests cover endpoint policy, reversible overlays, collision rejection, malformed
configuration, setup revision parsing, wildcard cancellation, publication durability, and rejection
of exact- and mixed-case forms of the protocol-owned one-shot secret at both setup and AgentConfig
boundaries. CLI tests cover delayed setup
visibility, forced key rotation, cancellation during a deferred live probe, the commit boundary,
same-endpoint generation rotation with uncertain flush, synchronous commit rollback, pre-commit and post-commit crash cuts,
real-store publication uncertainty, dual-binding crash
recovery after another drain, two-config recovery concurrent with publication, wildcard cleanup
replay, legacy direct-delete orphan enumeration, binding mismatch, digest-only binding persistence,
deferred capability publication, and credential injection at the common
session launch boundary. CLI coverage also holds an R1 credential stage across the atomic R2 merge,
rejects R1 publication, and then publishes R2; another two-replica test upgrades an exact marker
to wildcard while R2 is staged and proves R2 cannot publish. Component tests cover metadata-only edits,
per-attempt revisions, exact failure cancellation, the one-shot payload, and cancellation-first
offline config deletion through reload, plus non-dismissible submission and authenticated
capability-cache degradation. A real two-replica Flock test covers atomic wildcard
retraction and setup replacement, including a setup-authoring failure that retains the barrier. A
direct writer test proves that a stale exact cancellation preserves an existing wildcard marker.
The controlled loopback relay run
with bundled Codex 0.153.4 observed a streamed
`POST /v1/responses` request with the configured model and matching bearer credential; the relay
returned an intentional 401 after recording only the boolean credential match.
