# Compact Roost renderer change receipts without dropping recovery evidence

Status: implemented
Translation: current

[中文](2026-10-21-roost-renderer-receipt-encoding.zh.md)

## Abstract

The renderer change journal repeats JSON field names, hexadecimal scope hashes,
UUIDs and decimal cursors for every verified native interval. Its v2 encoding
retains every row and identity while storing fixed-width fields as bytes. The
owner's checkpoint protocol, completeness checks and write transactions do not
change. Experimental v1 sessions are refused without migration or deletion.

## Decision and boundaries

`roost-history-change-codec.ts` owns a pure codec. Each value has a version byte,
flags, two full u64 cursors, the full 256-bit owner/stream scope and the full
128-bit receipt nonce. An optional structural position uses eight bytes, restricted
to JavaScript's exact integer range. Canonical lowercase UUID ID lists use a count
and sixteen bytes per ID. Every other list uses JSON in the same v2 format, without
case folding, Unicode normalization or identity truncation. This also preserves
empty strings and lone surrogates accepted by the existing ID contract.

Generation replacement can produce a `before` cursor larger than `through`.
The codec preserves this reset evidence; ordering and coverage remain the reader's
responsibility. Bad versions, reserved flags, truncated/count-mismatched records,
invalid UTF-8/JSON and unsafe positions throw rather than becoming missing receipts.

`lody_renderer_history_changes_v2` replaces v1. The existing per-stream format
gate also probes the old renderer namespace before initialization, recovery and
mutations. It caches only successful checks for the stream handle's lifetime.
There is no v1 decoder, conversion or cleanup. Existing sessions with v1 receipts
require a new test session; unrelated streams remain usable. Retire the old CLI
owner before upgrading: simultaneous old/new writers are unsupported.

The [incremental recovery contract](2026-10-16-roost-incremental-history.md) still
requires the same scope, nonce, complete cursor chain and reset evidence. Anchor
CAS, the native event-cursor write guard and all receipt rows remain. No network
round trips, history hydration, pruning, write batching or durability settings are
added or removed. This is separate from [agent idempotency receipts](2026-10-21-roost-agent-receipt-encoding.md).

Effect feature/fix assessment: the change is a pure codec plus a bounded probe in
the existing Promise-based Native owner. Migrating that owner would expand into
unfinished Session lifecycle dependencies without improving this encoding change;
the lifecycle roadmap and ownership boundaries remain unchanged.

## Evidence

Four owning suites pass 105 tests with the candidate Native addon. Coverage includes
exact UUID/arbitrary-string identities, full-width cursors, malformed records,
concurrent anchor CAS, a 129-interval chain across pagination and reopen, missing
intervals, foreign scope/nonce, reset evidence, event-cursor refusal, and old/mixed
formats rejected before writes without deletion. The existing local recovery test
now uses the same SHA-256 scope shape as the production owner.

Manual Linux x64 measurements use two vCPUs and 7.5 GiB visible RAM, Node 24.22.0,
and release Native addon `60f6b160cfc0ec70039460a9f19b3ca8e65b733e` on **both** sides.
That addon includes the separate projection and unused-outbox changes; their
savings are not counted here. The Lody baseline is
`ce653a2199e9b3ccebb33aa66d35104444244f13` (compact agent receipts already included).
Each size has six alternating baseline/candidate pairs after one discarded warmup
pair. Every observation uses a fresh process and database. Measurements remain
outside CI and the repository; no captured conversation is used.

The fixed synthetic session has a user `request`, assistant `response`, forty
completed tools containing `synthetic-result-${i};` repeated forty times, and 224
or 1024 text notifications (`increment-${i};🙂`), one notification per batch.
The session ID is `00000000-0000-4000-8000-000000000001`. At each checkpoint, the
actual Loro history writer stores the same logical state, exports an incremental
update to a peer and persists it in `SqliteRepoStore`. Reloading every saved Loro
update reconstructs the same final state. Native reopen and last-notification
replay also retain the final history. This is a same-state storage comparison,
not an independent oracle for the history reducer.

| Median metric | 224, before → after | 1024, before → after |
| --- | ---: | ---: |
| Renderer receipt rows | 226 → 226 | 1026 → 1026 |
| Renderer receipt KV bytes | 46,591 → 19,443 | 212,254 → 88,243 |
| SQLite growth | 248 → 212 KiB | 792 → 652 KiB |
| Whole streaming writes | 4448.8 → 4336.4 ms | 19470.4 → 19725.0 ms |
| Per-write p95 | 25.65 → 25.84 ms | 25.07 → 24.68 ms |
| Read missed changes, p50 | 8.01 → 7.77 ms | 29.79 → 25.44 ms |
| Reopen + full read | 93.38 → 93.36 ms | 88.67 → 104.32 ms |

SQLite growth is `page_count × page_size` above the empty Native database, excluding
WAL/SHM, the identity database and Loro control storage. Long-run growth ranges are
784–792 KiB before and 644–652 KiB after. The corresponding Loro SQLite growth is
76/200 KiB, retaining **all** incremental updates; its accumulated exported updates
are 57,946/139,240 bytes. Final logical JSON is 40,506/54,930 bytes. Loro does not
carry the same signed-update, event-journal and application-receipt contracts.

Receipt KV savings are 58.3%/58.4%; total SQLite growth falls 14.5%/17.7%. Signed
update counts/bytes stay 227/65,110 and 1027/162,734, so this is local-index savings,
not reduced Streams traffic. The long mixed run has +1.3% total-write time and
overlapping timing ranges; reopen timing and mixed-process RSS are noisy. A separate
Lody-only run removes the Loro comparison workload before evaluating that signal.
These synthetic measurements do not replace the original live-session measurement
or establish a CLI RSS reduction.

In that Lody-only 1024-notification run, four alternating pairs after one warmup
give 19,281.9 → 19,217.8 ms total writes, 20,373.8 → 20,427.4 ms write-window
process CPU, 24.13 → 24.42 ms write p95, and 29.51 → 27.68 ms missed-change read p50.
Write time is effectively unchanged at this sample size. Ordinary reopen samples
range from 86.85–128.02 ms before and 86.56–131.14 ms after; their medians are
88.90/111.93 ms, so a controlled repeated-reopen probe checks this separately.

The final codec is also measured in four fresh processes ordered baseline,
candidate, candidate, baseline. Each performs eight reopens after explicit GC;
discarding the first leaves fourteen observations per variant in two processes.
Native calls are timed identically on both sides. Reopen medians are
110.38 → 110.17 ms, with ranges 105.98–146.10 / 102.15–162.69 ms. Time before the
first stream is 67.66/67.38 ms; total measured Native-call time is 24.23/24.12 ms.
The additional renderer-format probe costs a median 0.20 ms. This did not reproduce
a consistent reopen regression; repeated observations within one process are not
independent experiments, and no general cold-start improvement is claimed.

The full repository `pnpm check`, `pnpm format` and `pnpm run docs check` pass with
the pinned published dependencies. Final validation additionally rejects a
truncated scope hash with a trailing newline, without changing bytes for valid
production hashes. The local-write suite passes this edge case with the candidate
Native addon. No dependency, release, deployment or CI timing workload is added.
