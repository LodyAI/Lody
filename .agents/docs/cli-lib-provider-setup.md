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
explicit setup retracts it in the same Flock transaction that writes the fresh setup
revision. Peers therefore observe either the wildcard barrier or the new replacement
intent, never a retraction-only state that could admit an older setup. After a merge the
owning CLI causally applies the marker, so a cancellation that raced publication still
wins. A wildcard replaces an existing exact marker, and an exact marker never replaces a
wildcard; provider deletion therefore fences every stale setup revision. The same wildcard
cancellation is the durable machine-local credential cleanup
intent; after applying it durably, the CLI reconciles that config ID and removes the
credential only when no custom config or setup remains. Restart resumes only
non-interactive states. Renderer callers apply cancellation only through the transactional
`WorkspaceWriter` operation that reuses this shared precedence and returns the effective marker;
they must not write the cancellation row directly.

Credential-changing replacements use the provider-neutral machine-local credential store. The
store owns staging, rollback, finalization, reconciliation, enumeration, and hydration; adapters
own provider detection, binding identity, secret validation, and launch injection. Adding an
adapter must not add a provider branch to session or Machine RPC launch resolution. The current
Codex adapter keeps the old launch config published during the probe. Credential provisioning
carries the renderer-confirmed binding digest. The daemon recomputes it from the exact setup plus
revision before exposing secret input and recomputes it from the current setup immediately before
staging, closing same-revision rewrite windows on both sides of the probe. The post-probe cross-store
commit may retain the old and desired machine-local credential bindings until publication chooses
one. Publishing merges the current display metadata into the verified launch config, writes
`agentConfig`, and deletes `providerSetup` in one Flock commit. Before staging, the daemon embeds
the setup revision into the desired config's Lody-owned provider state. This non-secret generation
participates in the launch binding, so same-endpoint key rotation still publishes a distinct
`agentConfig` identity and recovery can distinguish the keys. The credential store rejects a
rotation without a fresh generation before replacing the active credential. The final abort check
runs immediately before the Flock commit, and the authentication slot becomes committed
synchronously after that commit returns. A commit throw is a pre-commit failure that rolls back
staged credentials; only a later flush failure is uncertain. Cancel or timeout wins before the
commit boundary and is too late after it.

The live provisioning probe does not update the shared capability cache. The manager
publishes its result only after the exact setup wins durable AgentConfig publication,
inside that config ID's credential mutation sequence. A cancelled, superseded, failed,
or durability-uncertain attempt cannot replace capabilities for the published config.
After a durable config commit, a failed cache write does not fail credential provisioning.
The renderer uses the authenticated result and publication durability to finish the save;
`capabilitiesRefreshed` reports cache status only.

A successful flush finalizes the credential to the published binding. A post-commit
flush failure reports uncertain durability and retains both bindings; the renderer
resyncs Machine Flock and does not treat it as an ordinary failed save. Queue event
drains never use their live snapshot to prune bindings. Credential reconciliation runs
once from the authoritative startup state, and later only for a durably applied
cancellation. Startup recovery snapshots only IDs; the current config/setup references
are read inside each ID's credential mutation sequence so provisioning cannot be
followed by reconciliation from a stale global snapshot.
Credential records carry non-secret workspace/config identity and are included in the
startup ID set. This lets recovery remove an orphan left by a legacy client that
deleted an AgentConfig without writing a cancellation. The current generic
`agent-config delete` writes the wildcard cancellation and deletes a custom Codex
endpoint config in one Flock commit.
Session launch captures the canonical provider config before adding GitHub or other
session-specific environment. Hydration uses that snapshot, then merges the temporary environment
into the hydrated launch, so per-session credentials never participate in the provider binding.

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
state that reaches every member's client. The shared AgentConfig write and read
boundaries reject the reserved Codex credential environment key, including empty
values and differently cased Windows aliases, so generic config commands cannot bypass
the machine-local store.
