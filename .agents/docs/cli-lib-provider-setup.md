# Durable provider setup (managed builtins)

How the CLI creates a default managed-builtin agent config as durable, cancellable
workspace state instead of an in-memory wizard.
[`apps/cli/src/lib/AGENTS.md`](../../apps/cli/src/lib/AGENTS.md) requires this page to
be read before `provider-setup-manager.ts` is changed, because the rules below bind it.

## Rows and ownership

`provider-setup-manager.ts` owns durable default managed-builtin creation. The
in-progress config lives in the machine Flock under `['providerSetup', configId]` while
runtime, auth, and live-probe work is incomplete, and only the target CLI may publish
it — by writing `agentConfig` and deleting `providerSetup` in one commit. Setup rows
with executable runtime overrides are invalid.

Cancellation is a separate row, `['providerSetupCancellation', configId]`. A
revision-bearing cancellation applies only to that setup attempt, so late failure
compensation cannot cancel a newer revision. A cancellation without a revision is an
explicit provider-removal barrier: it cancels any in-flight replacement, and a later
explicit setup retracts it. After a merge the owning CLI causally applies the marker,
so a cancellation that raced publication still wins. The same wildcard cancellation
is the durable machine-local credential cleanup intent; after applying it durably, the
CLI reconciles that config ID and removes the credential only when no custom config or
setup remains. Restart resumes only non-interactive states.

Credential-changing Codex replacements keep the old launch config published during
the probe. The post-probe cross-store commit may retain the old and desired
machine-local credential bindings until publication chooses one. Publishing merges
the current display metadata into the verified launch config, writes `agentConfig`,
and deletes `providerSetup` in one Flock commit. Same-binding key rotation omits the
unchanged `agentConfig` write. The authentication slot becomes committed immediately
before that Flock commit; Cancel or timeout wins before this boundary and is too late
after it.

A successful flush finalizes the credential to the published binding. A post-commit
flush failure reports uncertain durability and retains both bindings; the renderer
resyncs Machine Flock and does not treat it as an ordinary failed save. Queue event
drains never use their live snapshot to prune bindings. Credential reconciliation runs
once from the authoritative startup state, and later only for a durably applied
cancellation.

## When the queue may start

In cloud or dual mode, queue processing starts only after the machine Flock's first
remote sync, so a stale local row cannot outrun a remote cancellation. The OSS local
platform has no remote transport at all: its opened SQLite-backed Flock is
authoritative, so existing rows are processed immediately and new local-data-plane rows
trigger the same queue. Never make local mode wait on `firstSyncedWithRemote`.

The durable command subscription that delivers these rows is described in
[`apps/cli/src/lib/loro/AGENTS.md`](../../apps/cli/src/lib/loro/AGENTS.md).

## Secrets

Never add authorization URLs, codes, tokens, or raw provider output to a setup row, and
never publish a row from caller-supplied auth RPC fields. A setup row is workspace
state that reaches every member's client.
