# packages/history-import - Maintainer Guide

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
Root `AGENTS.md` applies; this file adds package context.

Pure domain logic for importing a local agent CLI's own conversation history
into a Lody session. No process spawning, no Loro doc, no repo, no logger, no
network: every function here is a deterministic transform over values.

| Module            | Owns                                                          |
| ----------------- | ------------------------------------------------------------- |
| `replay-import`   | ACP replay notifications -> `SessionHistoryInput[]`.           |
| `materialize`     | Replay -> history rows + turn hashes + replay digest.          |
| `decisions`       | Refresh / conflict-resolution decisions over those hashes.     |
| `catalog`         | Catalog rows, import keys, external-history meta.              |
| `hashing`         | Stable JSON + sha256 used by the turn hashes.                  |

`apps/cli/src/lib/local-project-history-sync-service.ts` is the only orchestrator:
it owns the ACP subprocess, the Loro session doc, the machine Flock catalog write,
and every clock read. Keep IO there.

## Invariants

- Clocks and ids are injected. `materializeReplay` takes `nowIso` and
  `buildExternalHistoryMeta` takes `lastSyncAt`; callers pass `getServerNow()`.
  A hidden `Date.now()` here would make an import non-reproducible and would make
  the benchmark measure the wrong thing.
- Turn hashes cover transcript content only (`role`, `items`, `plan`) via
  `stableJson`, never ids/timestamps/read state — those are assigned at import
  time and would otherwise turn every re-import into a sync conflict.
- Entry ids are content-addressed (`provider:acpSession:turn:<index>:<hash16>`),
  so re-importing an unchanged transcript reuses the same Loro list keys.
- `HistorySourceSessionInfo` is a structural subset of the ACP SDK's
  `SessionInfo`. Do not depend on `@agentclientprotocol/sdk` here.

## Benchmarks

`pnpm --filter @lody/history-import bench` measures the two costs a long
conversation pays, on a deterministic synthetic replay:

1. import: replay notifications -> history rows -> Loro doc -> snapshot;
2. open: snapshot -> `LoroDoc` -> Mirror state, the render-ready history.

`--notifications=<file>` benchmarks a locally captured replay and
`--repo=~/.lody/loro-repo/<workspace>/repo.sqlite3 --session=<sessionId>`
benchmarks phase 2 against a real local session doc. Neither artifact may be
committed (root `AGENTS.md`: fixtures are synthetic).

Baseline on an M-series laptop, real ~170-turn / ~5k-item session doc: phase 2 is
~3ms `LoroDoc.import` plus ~445ms of Mirror construction, and phase 2 dominates.
Mirror init walks every container (one `LoroMap` per message item plus a
`LoroText` per text item), so its cost tracks container count, not bytes.
