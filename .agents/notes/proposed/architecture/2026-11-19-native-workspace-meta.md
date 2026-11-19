# Native Workspace Meta behind the existing Repo API

Status: proposed
Translation: current
Language: [中文](2026-11-19-native-workspace-meta.zh.md)

## Abstract

An opt-in local mode moves Workspace Meta from the two legacy Meta Flock replicas
(CLI SQLite, renderer IndexedDB) to one native loro-repo-rs room. A separate host
process owns the engine; the daemon and desktop main each hold one connection; the
renderer uses domain IPC through main. Existing `LoroRepo` callers keep their API
because the repo runs with an incremental external metadata adapter. Legacy Meta
migrates by LWW import with bounded coverage verification. The change needed two
SDK additions, which exist only as local commits on top of loro-repo `795bafcb`. Verified with real
host processes, a real CLI document manager and a 10k/100k benchmark on Linux only;
no packaged desktop run. Implementation design: [native Workspace Meta](../../../docs/native-workspace-meta.md).
This is the new proposal the [rejected native Repo record](../../rejected/architecture/2026-10-16-native-workspace-repo.md)
asks for; the [WorkspaceData proposal](2026-10-14-workspace-data-services.md) still
owns the long-term directory contract, and both stay active.

## Decisions and rejected alternatives

- **Keep the `LoroRepo` API; replace only its Meta owner.** About 370 call sites use
  `getDocMeta`/`upsertDocMeta`/`watch`. Rewriting them to a new port was rejected as
  too large for one reviewable slice. loro-repo's v1 external metadata contract was
  also rejected: every update, receipt and read passes a full catalogue snapshot,
  which the controller clones, sorts and diffs, reproducing the per-operation room
  scan that closed #2892. The new `loro-external-metadata-v2` contract delivers
  changed rows only, and reads are served from an indexed view.
- **Subscribe from the head, page the initial state.** A changes subscription's
  initial snapshot is capped at one 4,096-row/1 MiB page, so a whole catalogue
  (30k registers at 10k documents) cannot be observed. A per-domain prefix split is
  impossible because Flock prefixes match whole tuple elements. The engine now
  accepts `snapshot: false`. The client reads bounded `start`-bounded pages, each at
  its own head; it avoids cursors, which a concurrent write invalidates. Buffered
  changes merge per key by `roomTxId`.
- **Migrate by import, not by rewriting.** Scan-and-put would mint new clocks and
  drop tombstones. Importing the complete legacy JSON export keeps registers;
  repeated or stale sources are harmless under LWW, so the same step serves the
  later workspace import. Verification with `flockReadRegisters` was rejected
  because it returns the whole room in one frame (it fails at 100k documents).
  Bounded state comparison is used instead; for keys that differ, a re-import
  showing no change proves that a newer register covers them.
- **One host process, launched by either side.** The daemon owning the engine (#2895)
  would couple Meta availability to the daemon; a host per side would race
  `files.lock`. The host idles out after its last connection.

## Consequences and limits

- Startup is still proportional to the catalogue (3.4 s at 100k documents), since
  the UI lists every document. Per-operation latency stays flat (see the design
  page). The write p99 tail matches engine auto-compaction; that is an SDK follow-up.
- Flag-off after native writes shows the frozen legacy catalogue; reverse export
  is the next slice. A commit already sent when the host dies latches that repo's
  Meta writes until it is recreated (SDK contract).
- Cloud and encrypted workspaces are out of scope: the OSS desktop is local-only.
