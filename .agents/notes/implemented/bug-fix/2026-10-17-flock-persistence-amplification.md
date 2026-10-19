# Stop native Flock persistence from amplifying the renderer queue

Status: implemented
Translation: current

[中文](2026-10-17-flock-persistence-amplification.zh.md)

## Abstract

After the renderer adopted the native Effect Repo in
[#1607](https://github.com/LodyAI/Lody/pull/1607) (`loro-repo` 0.23.0), the
renderer froze for 5–22 seconds at a time. Every Streams delivery that changed
nothing (an echo of the renderer's own append, a repeated bootstrap, a re-read log
entry) was journaled with a full Flock snapshot. Compaction never counted those
rows, so the IndexedDB Meta queue grew to hundreds of megabytes, and each open or
compaction replayed it synchronously on the main thread. `loro-repo` 0.23.1
restores the 0.22 journal rules: received bytes are stored once, only when they
change state; every written byte counts toward compaction; and compaction can no
longer fail a save that is already durable. Lody only upgrades the dependency. The
first open after upgrading still replays an existing backlog once, and the source
of the roughly two-second redeliveries is not established.

## Evidence

A user's renderer hang watchdog recorded two hangs of 5.8 s and 11.3 s, with one
core saturated and the stack in `Flock::import_file` under
`hydrateMetaSnapshots`. The user's IndexedDB Meta queue held 1278 rows (174 MB):
395 Flock files of about 440 KB, 243 of them unique and up to 38 byte-identical,
plus 883 JSON rows. It grew by about one file every 1.5–2 seconds. Replaying an
earlier read of 884 rows with the installed binding took 22.8 s.

In `loro-repo` 0.23.0 `src/effect/repo.ts`:

- `importFlockUpdates` incremented the revision and kept the received bytes even
  when the import changed nothing.
- `payload()` exported a full file whenever no local key had changed.
- The IndexedDB adapter appended that file to the queue instead of replacing the base.
- Compaction counted only re-exported local deltas.

The 0.22 Promise journal (`FlockPersistenceJournal.receive`) explicitly skipped
such imports: no remote event and an unchanged inclusive version mean nothing
needs journaling.

## Decision

Fix the owner, `loro-repo`
([loro-dev/loro-repo#154](https://github.com/loro-dev/loro-repo/pull/154)), rather
than patching Lody:

- Store received bytes exactly once, and only when they change a key or advance the
  inclusive version (a last-writer-wins loser still counts). Remote events never
  become local keys. A full file is used only when a changed key cannot be read back.
- Count every written byte toward the 100 KiB compaction threshold, and add a
  60-second fallback timer in the Repo background scope.
- Run compaction only after the save is durable and the durable revision has
  advanced. Its failure is reported on `persistenceFailures` and retried by the
  timer. Before this, counting received bytes made remote-only traffic reach
  inline compaction, and a failing compaction (for example quota pressure on the
  rewritten base) failed the already durable save, blocked the cursor and made
  release and close fail on every retry.
- Fold a Meta backlog of at least 64 rows or 100 KiB into the base on IndexedDB
  open, reusing the hydrated replica.
- Native Streams Flock uploads carry only the local peer's entries again. Before,
  the first local write after each join re-uploaded every peer's entries.
- Version inference uses a fresh Flock per call instead of a shadow replica that
  accumulated every bootstrap.

The rule that a cursor is saved only after its data is durable is unchanged.

Alternatives considered:

- A `pnpm patch` in Lody: rejected because the defect and its tests belong to the
  Repo owner, which ships a patch release.
- Reverting the renderer to the Promise Repo: rejected because it would undo #1607
  for a contained persistence defect.

## Follow-up: 0.23.2

An adversarial review of 0.23.1 found that the new fallback-timer compaction
could overlap a save's threshold compaction. On an adapter without
compare-and-write (`FileSystemStorageAdaptor`), an older capture finishing last
overwrites the newer base and deletes durable rows. Lody's IndexedDB and SQLite
adapters already rejected the stale write.
[loro-dev/loro-repo#156](https://github.com/loro-dev/loro-repo/pull/156)
(0.23.2) runs at most one compaction per replica and starts none after release
has begun. It also fixes three side effects that do reach Lody's renderer:

- a save below the threshold no longer waits for a running compaction;
- a failed compaction that the timer joined still schedules its retry;
- rows written during a long compaction keep the 60-second bound.

A pre-existing filesystem detached-read race is tracked in
[loro-dev/loro-repo#157](https://github.com/loro-dev/loro-repo/issues/157).

## Verification

- Against 0.23.0, 18 of the 19 original journal cases fail, and all 4
  compaction-failure cases fail. All pass on 0.23.1. Each case uses the real
  IndexedDB adapter and real Flocks, for both Meta and named Flocks.
- Replay of the field scenario (Meta with 20k entries, 150 rounds of duplicate
  bootstrap and re-read, plus echoes): 0.23.0 wrote 510 rows / 41 MB and took
  78 s to reopen; 0.23.1 wrote 32 rows / 0.1 MB and reopened in 11 ms.
- Upgrade path: a 198-row / 24 MB backlog written by 0.23.0 is folded on the first
  open (about 14 s). Later opens take 18 ms, and no data is lost.

## Limits

- The first open after upgrading replays an existing backlog synchronously once.
- Repeated deliveries still cost an import each (tens of milliseconds for a large
  Meta), although nothing is written. A read-only investigation found no Lody
  caller with a two-second period. The cadence reproduces when one Streams API
  shard returns a lagging next offset and the SDK accepts it without a
  monotonicity check, but this is unverified against the real service.
- The native Repo has no full-file fallback for exact bytes that storage rejects
  permanently. The payload stays queued and the cursor stays blocked; no data is
  lost.

Lody upgrades: [#1672](https://github.com/LodyAI/Lody/pull/1672) (0.23.1), 0.23.2 in the follow-up bump. Related: [native workspace Repo](../../proposed/architecture/2026-10-16-native-workspace-repo.md).

Current boundary (2026-10-19): native consumers and their dependent application patches were withdrawn; Repo 0.23.2 remains selected. The former Promise transport supplies stream creation again. See the [rollback decision](../simplification/2026-10-19-repo-upgrade-without-consumer-migration.md).
