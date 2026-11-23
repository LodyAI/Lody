# Linear-time history text rewrites

Status: implemented
Translation: current

[中文](2026-10-20-history-text-linear-rewrite.zh.md)

## Abstract

A user reported the desktop stalling when switching tabs. Their daemon log showed
the CLI main thread blocked for 63 s to 224 s at a time, with over 90% of the
profile in `LoroText.update` under `diffHistoryContainer`. That method runs an
unbounded Myers diff in wasm, which is fast for appends but takes minutes when a
long text is rewritten in the middle. While it runs, every RPC the renderer waits
on stalls, so tab switches, session creation and runtime-state reads all freeze.
History writes now keep the common prefix and suffix and splice only the middle,
which is linear in the text length. A large rewrite is now stored as one delete
plus one insert rather than a minimal diff.

## Evidence

Timings of `LoroText.update` (loro-crdt 1.16.3, Node 24, Linux):

| Stored text | Change                     | `update` |
| ----------- | -------------------------- | -------- |
| 23k chars   | append                     | 7 ms     |
| 23k chars   | drop the first 10%, append | 0.8 s    |
| 93k chars   | drop the first 10%, append | 11 s     |
| 93k chars   | unrelated content          | 112 s    |
| 237k chars  | drop the first 10%, append | 70 s     |
| 237k chars  | unrelated content          | 456 s    |

`diffList` pairs list items by position when it has no retained object to anchor
on. With two ~27k-char text items and one short item inserted at the front, a
direct `diffHistoryContainer` call took 13 s, because each stored text was diffed
against an unrelated replacement. `HistoryWriter` retains unchanged item objects,
so its own update path anchors correctly. The exact write that triggered the
user's stall is not identified: that would need their log entries around the
stall and the callers in their profile.

## Decision

`writeText` in `history-materializer.ts` replaces all three `LoroText.update`
calls. It compares UTF-16 code units, keeps the common prefix and suffix, and
never splits a surrogate pair, which Loro rejects. It diffs against the stored
text rather than the caller's snapshot.

- Appends and edits confined to one region emit the same ops as before. Writing
  into an empty Text is a single insert, so the Mirror storage-shape equivalence
  still holds.
- A rewrite spread over a long text becomes one delete and one insert. If another
  peer edits the middle of that same text at the same time, the merge is coarser
  than Myers would produce. These fields are agent output authored only by the
  CLI, so concurrent edits are not expected.

## Alternatives

- `update(text, { timeoutMs })` throws `Update timeout`; it does not fall back to
  another strategy, so a caller would still need this splice as the fallback.
- `updateByLine` is far faster, but it is still a line-level Myers diff (366 ms
  for the 93k-char unrelated rewrite) and still grows faster than linearly.
- Better `diffList` alignment, for example by `toolCallId`, would avoid pairing
  unrelated items. It does not bound the cost of a genuine large rewrite, so it
  is left as follow-up work.

## Verification

`tests/history-writer.test.ts` checks that a rewrite to unrelated content through
`HistoryWriter` emits exactly one delete and one insert, and that a peer
converges. The old implementation emitted 600 ops for the same change. Another
test steps through edits whose prefix or suffix boundary falls inside a surrogate
pair; without the boundary adjustment Loro throws. The shared suite and the CLI
ACP and history suites pass. The tab-switch stall itself was not reproduced end
to end in Electron.
