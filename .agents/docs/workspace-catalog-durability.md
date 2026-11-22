# Workspace catalog durability and Role configuration

Local catalog persistence and remote sharing finish at different times. This explains
the [catalog write rule](../../packages/shared/src/AGENTS.md#workspace-mcp--roles); it does not introduce
another catalog or write path.

An MCP server or Agent Role row already exists once its local Flock write is durable.
The explicit upload follows that write, and a joined room can carry the document
when the one-shot upload cannot. Waiting for that upload in Settings confuses a
sharing delay with a failed edit. Reporting it as an edit failure can prompt a
duplicate retry; an upload banner offers no actionable correction to the saved row.
The CLI's explicit sync result answers a different question and remains visible.

A Role is a row in the workspace document even when its visibility is private.
Visibility does not prevent the underlying row from reaching other workspace
members' clients. This is why sensitive configuration is filtered on reads as well
as writes and why private visibility cannot make the catalog a secret store.

Permission mode is an agent-published run-config value, not a secret or a separate
auto-approval policy. A Role can pin it with the rest of its configuration, making a
second composer permission control redundant. When that control disappears, its
warning must remain visible for full-access or skip-permission modes. Presentation
details live in [composer run config](sessions-run-config.md).

An accepted Operation captures the resolved Role configuration rather than rereading
a mutable catalog on retry. Otherwise editing or deleting a Role could change what
an already accepted request executes. Session provenance describes creation; it is
not another configuration authority.

A Role's optional description gives other agents short guidance on when to call
it. The editor and shared normalizer cap it at 140 Unicode code points; discovery
list/get results expose it separately from the execution prompt prefix. Older rows
without the field display as blank. See the [description Spec](../../specs/agent-role-description.md).

Explicit Save reconciles the Role's option values against the selected agent's
authoritative, model-specific editor controls. It drops retired keys, retains valid
choices and uses current defaults for unset or invalid values. Opening or cancelling
the editor does not rewrite the catalog. Missing/provisional capabilities preserve
stored options; model and mode pins remain explicit user choices. The existing
content comparison advances the revision once when reconciliation changes the row.

Workspace startup also reconciles owned Roles against fresh runtime schemas without
opening Settings. A conditional writer transaction fences delayed probe results
against edits and deletion, then uses the same durability/upload split. See the
[schema reconciliation Spec](../../specs/agent-role-schema-reconciliation.md) for
which options may be removed and which pins remain user decisions.

A Role can also carry a machine-scoped memory identity reference. The daemon's
Provider adapter owns commands and environment mapping; neither memory contents
nor credentials enter the workspace catalog. A new turn freezes the reference,
and switching it retires the old ACP process without publishing an agent-death
event against the new turn. See the [memory Spec](../../specs/agent-role-memory.md).

Memory associations are machine-document rows keyed by
`['memory', providerId, memoryId]`, separate from workspace Role references.
They store a display name and description, not memory contents. The same writer
durability/upload split applies. Linking is put-if-absent; editing cannot resurrect
a deleted row. Deleting an association leaves the external identity and existing
Role/turn references intact. See the
[association decision](../notes/implemented/feature/2026-10-05-memory-association-catalog.md).

Project MCP defaults share this workspace document as one optional ids-array row
per project. Missing rows inherit catalog defaults; present rows replace them,
including an empty selection. Authoring resolves these defaults before accepting
a new conversation, while continuation inherits the target conversation selection.
The existing per-turn and Operation target configurations carry the resolved ids;
startup and recovery do not reapply project policy. The
[project default Spec](../../specs/project-default-mcp.md) describes UI behavior
and acceptance scope.
Memory batch import reuses these per-row writes sequentially. The editor removes
successful rows from its checkbox selection, stops on the first failed write, and
keeps remaining selections for retry; it does not roll back earlier durable rows.

Agents can propose Role creation or text edits through MCP or `lody agent-role
create/update`. Both publish a conversation card, and only its Save action writes
the catalog using the same local durability boundary. The updater applies only
specified text fields to the latest row, keeping bindings and run configuration.
Concurrent device edits may overwrite one another; there is no cross-device CAS.
The [tool guide](../../apps/cli/src/mcp/README.md#agent-role-proposals) documents
inputs, active-conversation requirements and retry receipts.

## Streams catch-up

Renderer and CLI use `@lody/shared/workspace-streams-persistence` around
`createRepoStreamsPersistence`. Meta and named Flock (`:mf`, `:wf`, `:sr`) keep
the exact Repo-owned checkpoint stores and per-resource persistence barriers.
Both native storage adapters resolve known gateway URL aliases without moving
checkpoints between replicas. Each calling package constructs its own
Streams adapter, preserving SDK class identity across pnpm peer graphs.

Checkpoint load compares the live Flock version with `serverLowerBoundVersion`.
Only a replica with no newer local clocks is eligible for the optimization; it
repeats this check after the network probe. Authenticated stream HEAD gives the
20-digit byte positions, calculated with BigInt. For a newer snapshot, bootstrap
is selected only when:

```text
catchupBytes = tailOffset - localOffset
suffixBytes = tailOffset - snapshotOffset
catchupBytes > max(1 MiB, 2 * snapshotBytes + suffixBytes)
```

Snapshot size is its wire `Content-Length`: GET the offset-specific snapshot and
immediately cancel its body. The snapshot API does not support HEAD. Some buffered
bytes may transfer; the probe does not intentionally download the whole image.
The probe budget is 1.5 seconds, including token acquisition. Unknown size,
unavailable snapshot-read permission, malformed positions and probe failure retain
incremental catch-up. An old small local image cannot reliably estimate a now-large
remote image, so it is not used. Headers select a strategy, never content authority.

Selection deletes only the current replica's checkpoint. SDK verification,
decryption, Flock merge, per-resource persistence and checkpoint save remain intact.
Writes arriving during probing or bootstrap stay on the same Flock and are exported
against the independently derived remote version. Protected mode retains its
namespace, bucket, provider and upload gate.

Named Flock joins and one-shot syncs observe the SDK's `initial_sync_timeout`.
At the next attempt, that replica bypasses its old checkpoint once. Authentication,
crypto and storage errors do not qualify. The existing room owner schedules retries;
there is no whole-transport restart or new timer. The reset budget survives adapter
recreation under the same runtime owner. The SDK default 240-second hard deadline
is unchanged; existing Meta runtime recovery remains separate. Cursor deletion
occurs on the next load, after the failed initial read, and never deletes content.
Pending writes follow the same merge/export path during forced bootstrap.

Repo 0.26.0 / CRDT 0.22.1 / Client 0.14.0 still incur local bootstrap work: Flock
imports the snapshot and loads a temporary copy to derive its remote version. A
missing upload baseline can also require an isolated observer. Repo captures the
received payload and persists it before progress. Replacing the live replica or
skipping those steps has no safe application-level contract; reducing extra decodes
requires SDK work. Reduced replay volume is not a measured mobile startup gain.
Deterministic renderer and CLI suites cover selection, concurrent drafts, timeout
recovery and durable reopen. The published Promise Repo boundary remains; native
Effect consumer migration is separate, as described in
[the Effect guide](cli-effect-ts.md#small-migrations-during-feature-and-fix-work).

Incomplete recovery metadata records an unchanged tail with unresolved dependencies,
not permission to advance a replay cursor. The renderer persists it in a separate
`<repoDbName>-incomplete-recovery` IndexedDB, within the existing rebuildable cache
family. The CLI daemon writes atomic JSON records under its workspace's
`incomplete-recovery/` directory; commands read them but save/delete only in memory,
so this metadata cannot contend with SQLite document transactions. Recognized gateway
aliases share one metadata key. Failed or timed-out IndexedDB operations degrade to
ordinary SDK recovery, with late connections closed. The SDK probes an unchanged
incomplete tail with HEAD, retains live tail observation for subscriptions, and
resumes recovery after remote progress or when a writer can supply missing data.
Read compaction keeps the SDK's default `compactionOnRead: true`.
