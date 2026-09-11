# Durable provider setup

How the CLI creates a verified builtin agent config as durable, cancellable workspace
state instead of an in-memory wizard. Managed builtins use the queue to prepare their
runtime; user-installed Bub uses it only to verify the local command before publication.
[`apps/cli/src/lib/AGENTS.md`](../../apps/cli/src/lib/AGENTS.md) requires this page to
be read before `provider-setup-manager.ts` is changed, because the rules below bind it.

## Rows and ownership

`provider-setup-manager.ts` owns durable builtin creation for managed runtimes and Bub. The
in-progress config lives in the machine Flock under `['providerSetup', configId]` while
runtime, auth, and live-probe work is incomplete, and only the target CLI may publish
it — by writing `agentConfig` and deleting `providerSetup` in one commit. Setup rows
with executable runtime overrides are invalid.

Only managed builtins enter binary status/download handling. Bub is user-installed, so
its queued setup advances directly to the live ACP probe. A missing or broken `bub`
command leaves a failed, retryable setup row and never publishes an `agentConfig`.

Cancellation is a separate row, `['providerSetupCancellation', configId]`. After a
merge the owning CLI causally deletes any concurrently published setup or config, so a
cancellation that raced a publish still wins. Restart resumes only non-interactive
states.

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
