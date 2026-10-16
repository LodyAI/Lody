# Daemon history writes cost the size of the turn, not the size of the change

Status: implemented
Translation: current

[中文](2026-10-14-daemon-history-writes-scale-with-turn-size.zh.md)

Follow-up: [nested subagent windows](2026-10-16-subagent-history-windows.md)
extend the coverage beyond this original tool-only decision. The limitations
below describe this change at the time it landed.

## Abstract

In a tool-heavy session whose history grew to tens of megabytes, the CLI daemon spent
seconds per flush on its main thread writing agent output. Every tool batch serialized
the whole history, and text batches serialized the whole target turn twice. The busy
thread then missed the 120-second deadline of the Streams initial sync, so local writes
stopped reaching other devices until the burst ended. Streaming batches now write
through a window: the target turn's fields, its trailing items, and the tool items
they update wherever those are stored. A version-checked `toolCallId` index locates
those tool items. On a synthetic 28 MiB history a batch dropped from 0.5–1.4 s to
1–3 ms. The index still rescans the history once after any write it did not make
(about 150 ms at that size).

## Root cause

`appendACPNotificationsToAssistantEntry` marked a batch `entryBound` only when every
update was a plain text or thought chunk, because a tool update may belong to an older
turn. Every other batch went through `HistoryWriter.update`, which reads the history
with `list.toJSON()`, produces a new array and diffs it back. Stall profiles from the
reported session sampled exactly that stack, with `toJSON` ← `readAll` ← `update` ←
`applyAgentBatch` at 67–87% of inclusive time.

Making tool batches entry-bound would not have helped. When one turn holds most of
the conversation, the entry-bound path costs more than the whole-history path: it
calls `read(id)` and then `updateEntry`, which serializes the turn twice, and then it
diffs every item. Measured on a synthetic history with 16,000 items in one turn
(28 MiB of JSON):

| Batch                               | Before    | After  |
| ----------------------------------- | --------- | ------ |
| `tool_call_update` near the tail    | 531 ms    | 2.8 ms |
| new `tool_call`                     | 558 ms    | 1.7 ms |
| text chunk (entry-bound)            | 1,047 ms  | 0.9 ms |
| tool call far back in the same turn | 1,442 ms¹ | 1.1 ms |
| tool call in an older turn          | 531 ms    | 1.2 ms |

¹ The tool batch forced through the entry-bound path, as a proposed fix suggested.

## What changed

- `HistoryWriter.updateTail(turnId, toolCallIds, updater)` gives the shared planner
  a set of window rows. The target row has every field except `fileDiff` and only its
  tail items: the last item, extended back across adjacent text/thought items. Each
  referenced tool call stored outside that tail gets one single-item row. The writer
  diffs the changed fields with a partial map diff and writes the item ranges with
  `diffHistoryListRange`, which leaves items outside the range unread and unwritten.
  Everything is prepared before the first CRDT mutation, as with the other writer
  methods.
- The writer keeps a `toolCallId → (row, item)` index, valid only at the document
  version it recorded. Its owner rule matches the whole-history planner: the newest
  row holding the id, and the first such item within that row. The writer updates the
  index after its own window writes and after field writes, since those cannot add a
  tool item. Any other local or imported change makes the next window rebuild it, and
  a position that no longer holds the id forces a rebuild too.
- `targetLocalToolCallIds` sits next to the applier. It decides whether a batch is
  target-local: text, thought, plan and no-op updates, plus tool calls that are not
  subagent tasks. Subagent tasks and events, Devin subagent internals, rich contents,
  and singleton items keep the whole-history path. So do duplicated target rows and
  inline legacy storage, for which `updateTail` returns false.
- The entry-bound fallback no longer calls `read(id)` before `updateEntry`.

## The tail boundary

Compaction merges adjacent same-type text/thought items and parses `<thinking>` tags
in the touched turn. Starting the tail on a text/thought item preceded by another one
would let a parse split a thought out of the tail without merging it into the stored
thought before it. So the tail extends back across text/thought neighbours.

The whole-history path also re-sanitizes and re-parses every text item of a touched
turn. The window does this only for the tail. Items before the tail went through the
same sanitizing and parsing when they were last written, so they are already settled.
A legacy item written by an older build without those passes keeps its stored form
until something rewrites it.

## Alternatives considered

- **Entry-bound tool batches.** Measured slower (see the table), and they would route
  an older turn's tool update to the current turn.
- **Scan for tool calls on every batch instead of indexing.** A full scan reading only
  each item's `type` and `toolCallId` costs 50–130 ms at this size. A new `tool_call`
  must prove its id is absent everywhere, so that cost would apply to almost every
  batch.
- **Maintain the index from document events.** This avoids the rescan after imports,
  but it depends on how Loro reports containers created inside an import. The version
  check is simpler to prove complete. Revisit it if rescans show up in profiles.
- **Upload the local backlog when the Streams initial sync times out.** That would
  shorten the outage but leave its cause, and it changes `@loro-dev/streams-crdt`
  protocol behaviour. It belongs to that package's owners.

## Verification and limits

`apps/cli/tests/session-history-storage.test.ts` checks the following:

- **Same result as the old path.** A scripted stream gives the same stored history
  through `applyAgentBatch` as through the previous whole-history `update`. The stream
  covers text merges, a split `<thinking>` tag that compacts into the thought before
  it, plans, `acpTurnId`, and tool calls in the tail, far back in the target turn, in
  an older turn, and announced only by an update.
- **Peer writes.** A tool item a peer stores, and then shifts by inserting before it,
  still receives later updates instead of being duplicated.
- **Duplicated targets.** Duplicated target rows keep the whole-history behaviour.

Removing the tail extension, the segment rows, the index version check, or the
segment offset each fails at least one of these tests.

The table comes from synthetic Loro fixtures in Node on one machine. Read it as
ratios, not budgets.

What is unchanged:

- Building the index and rebuilding it after a foreign write still cost a full
  scan.
- Rich `contents` batches and subagent batches still go through the whole history.
- The `operation-progress` preview (`readStored`) and the usage-update user-id
  fallback still read the whole history.
- Snapshot export still runs on the main thread (#1455).

The window is a method of the one writer described in
[single history writer](../architecture/2026-09-07-single-history-writer.md), not a
second write path. The renderer-side counterpart of this problem is
[streaming cost scaled with conversation length](2026-09-16-streaming-cost-scales-with-conversation-length.md).
