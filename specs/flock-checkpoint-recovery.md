# Flock checkpoint recovery

Status: draft
Translation: current

[中文](flock-checkpoint-recovery.zh.md)

## Behavior

After an upgrade or restart, persisted local edits remain available. A stream
checkpoint must never skip records absent from its loaded replica. Flock version
vectors, including inclusive vectors, are maximum-clock summaries, not proof that
all keys are present.

Accepted remote data must be saved before stream progress advances. A persistence
callback resolves after the resource write, not after scheduling it. Failed writes
retain pending data and prevent checkpoint advancement.

Renderer Meta and named Flocks recover data and checkpoints together through
loro-repo's IndexedDB replica capability. Legacy independent Flock cursors are not
copied. The first connection without a bound checkpoint bootstraps and merges with
local data. Existing renderer LoroDoc cursors remain separate and are outside this
Flock guarantee. Meta recovery markers bypass the actual bound checkpoint.

CLI SQLite retains its CRDT data but does not reuse legacy durable cursors. Until
upstream SQLite supports atomic replica recovery, Flock progress belongs to each
loaded object in memory; documents also use memory progress. Transport rebuilds
and process restarts replay remote data. This costs additional download, not loss
of unsent local edits. Local-only composition starts no cloud transport.

## Limits and acceptance

Wire and snapshot codecs do not change. This does not promise that an old writer
can safely share a database with a new writer, or that rollback preserves the new
durability guarantees. It does not repair historical remote snapshots whose
records are already absent: those need trusted replay/recovery evidence. A vector
comparison must not authorize publishing a purportedly repaired snapshot.

Acceptance covers migration from the old IndexedDB layout, preservation of local
records, same-vector repairs surviving reopen, isolated progress for overlapping
replicas, persistence failure/retry, actual-checkpoint recovery bypass, and a late
older key reaching a local-plane reader. Browser power loss and production remote
history completeness require separate validation.

## Evidence

- [Upstream repair](https://github.com/loro-dev/loro-repo/pull/132)
- [Implementation decision](../.agents/notes/implemented/bug-fix/2026-09-17-flock-checkpoint-migration.md)
