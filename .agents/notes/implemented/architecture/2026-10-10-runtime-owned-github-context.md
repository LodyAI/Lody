# Runtime-owned GitHub credential contexts

Status: implemented
Translation: current

[中文](2026-10-10-runtime-owned-github-context.zh.md)

## Abstract

Discarding a managed GitHub preparation and starting a local runtime with the same
Session ID left broker enrollment inconsistent with the runtime's missing policy.
This caused later turns to fail with `github_context_missing`. Credential authority
now belongs to a distinct Effect-scoped lease retained by the runtime across
adoption; native runtimes never consult historical broker enrollment. Preparation
control has a separate Effect scope, and failed retirement blocks replacement.
The Session/ACP/worktree Promise orchestration remains explicit legacy glue;
this change does not claim its complete Effect migration or deployed validation.

## Decision and ownership

This extends [local native authentication](../../implemented/feature/2026-09-29-local-project-native-github-auth.md)
and [ordered identity fallback](../../implemented/architecture/2026-10-03-github-identity-fallback.md).
The [updated draft contract](../../../../specs/github-identity-fallback.md) retains
conversation-owner network identity and separate turn-requester commit attribution.

The broker's `acquireContext` is an Effect acquire/release resource. Each acquisition
creates a unique token and pinned context file, even for an unchanged Session and
owner. Its immutable context includes Session and machine identity; its workspace
is the owning broker. There is no Session-keyed enrollment or mutable per-Session
context file. Exact-lease release is idempotent; broker shutdown also revokes its
remaining leases. Missing platform token capability retains the native path.

`SessionCredentials` is an explicit native/managed runtime capability, outside
`SessionConfig`. The temporary `acquireSessionCredentialsLegacy` facade gives
Promise callers a scope-owned handle and shared close receipt. Preparation acquires
it inside its compensation region; failure before sandbox/Session creation closes
it. The same Session retains it on adoption; termination closes it. Cold startup
covers document, process launch, and post-launch persistence failures as well.
Fallback uses the incoming launch config rather than a merged prepared environment.
Commit identity preferences are no longer stored in network credential policy.

Create, continue, stale-agent recovery and steer validate the runtime's exact live
lease and trusted owner. Native mode does nothing. Invalid managed state fails
closed; owner changes revoke the old capability and terminate its runtime, without
changing the identity under existing helpers or replaying the operation. Steer
validation precedes provider submission and retains the final synchronous Stop
fence. Lifecycle events from an older Session cannot evict a replacement instance.

## Effect boundary and retirement

`makePreparationControl` uses Effect v4 Scope, Deferred and an owned TTL fiber.
Its temporary facade publishes completion back to Promise code after leaving the
Effect runtime; all close callers share a completion receipt. Claim closes this
control scope, not the credential/resource scope. Synchronous peek/claim and
publish-before-start semantics remain unchanged.

The current manager still owns raw ACP and worktree startup through its existing
Promise completion barriers. It is not wrapped wholesale and declared Effect-native.
A future bottom-up migration can replace those dependencies and the admission
facade; see the [roadmap](../../proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.md)
and [CLI Effect guide](../../../docs/cli-effect-ts.md). Only the resource and clock
leaves migrate here, so no new cross-layer Effect-to-Promise-to-Effect process
runner is introduced. Runtime resources are not reparented by closing a Scope.

Retirement remains discoverable after removal from the preparation catalog and
while creation returns late. Disposal errors, including rollback before resource publication, stay in the retirement receipt;
replacement cannot treat them as success. Unconfirmed process termination revokes
credential authority but retains workspace ownership. Cleanup waits on existing
raw startup barriers can still remain pending; this is an explicit unresolved
ownership state, not proof of release or permission to overlap a cold start.

## Verification and limits

The broker suite exercises real scoped acquisitions against its request handler:
releasing generation A rejects its token while same-Session generation B remains
authorized. Manager suites cover managed registration followed by local preparation
with the same ID, native environment preservation, adoption retaining its lease,
sandbox failure, disposal before start, document/spawn/persistence failures,
termination, owner-transfer revocation, and stale runtime exit events not removing
or finalizing their replacement. Existing preparation tests cover
expiry, cancellation, replacement and late resource return; failed cleanup now
asserts blocked retirement. Turn execution, environment, termination, native Git
helper and gh/runtime suites also pass. Tests use synthetic identities and existing
controlled signals/virtual clocks; no real credentials or production network were
used in the new regression cases. CLI type checking, repository documentation checks, public/platform boundaries
and the process-boundary guard pass.

Rejected approaches: a local-only guard leaves stale authority; revoking by Session
ID can revoke a replacement; swallowing missing policy weakens managed isolation.
No application restart, live daemon patch, package release or deployed recovery
verification was performed. There is no PR yet.
