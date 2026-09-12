# Session history writes

Status: draft
Translation: current

[中文](session-history-writes.zh.md)

## Scenario

A synchronized session contains an unknown future item, or a damaged old text
item. Sending a valid user turn and streaming a different item must still work.
That tolerance must not authorize creating new malformed items locally.

## Contract

- Renderer and CLI share one HistoryWriter for local history changes. A reader
  feature flag may replace the view, not the write contract.
- New turns use explicit message types and runtime input parsing. Legacy typed
  callback callers use the same writer through the session facade.
- Before a command changes history, validate its new turns and changed known
  fields/items. Reject invalid commands with paths/codes, retaining prior values;
  another valid command remains usable. Do not validate unrelated stored items.
- Filter unknown fields on closed new-input objects. Explicit protocol extension
  dictionaries remain JSON-valued. Preserve unknown stored fields and untouched
  unknown/damaged items; reading is not a migration or permission to scrub data.
- Existing primitive strings remain primitive; existing Text edits retain their
  container identity. Storage-layout changes are separately reviewed.
- Fork is a stored-history copy, not new-message authoring. Copy from a snapshot
  captured by the writer, retaining target initialization rows and unchanged unknown fields
  and opaque items. Explicit changes and new fork notices still require parsing.
  Prepend copied rows and reject id collisions; retain target containers.
  Caller-created JSON cannot claim this provenance. Copying does not modify the source.
- Failed edit-and-resend can restore captured old history without reparsing it as
  new input. A one-use local rollback receipt restores only the changed range, preserving
  current content of untouched rows and subsequent appends. It captures only the affected
  stored range and rejects changes to existing row identity/order
  and edits inside that range, except a newly inserted pending user row becoming seen/read
  with every other field unchanged. It is not crash recovery or a distributed transaction.
  External provider imports remain new inputs, not privileged stored-history copies.
- Acceptance here means a local CRDT write. Existing repo persistence and transport
  still own durability, permissions, and remote synchronization.
- Tool fields other than type/toolCallId
  parse only changed fields without reparsing untouched tool payloads; outcome-only
  edits retain existing request information. Identity changes require complete item parsing;
  changed content blocks are parsed separately. Invalid new fields reject the command before any write.
- New history accepts existing legacy built-in CLI selector normalization without rewriting
  stored history. Steer config and same-identity task-proposal edits parse only changed fields.
- Queue promotion removes its queued row only after history acceptance; failed writes retain it.
- A finished assistant turn may contain a legacy context-compaction activity whose
  provider terminal state was never persisted. Opening that Session may request a
  repair, but only its owning daemon may change the exact addressed turn and tool
  item, and only after live execution ownership proves that turn is no longer
  active. Turn `finished`, durable Session status, elapsed time, daemon restart,
  or missing live evidence is insufficient. The renderer requests repair only while
  the Session is inactive, browser connectivity is online, and the Session room is
  synced. An offline, reconnecting, unsupported,
  non-owning, active, or indeterminate daemon leaves history unchanged. Repair must
  inspect a remotely synced Session document, reject any live Session work, recheck
  ownership, and update only the named entry through `onlyEntryId`; a concurrent new
  turn has a different identity and remains untouched. Report `reconciled` only after
  the write is confirmed; every other result is `retry`. Retry evidence is bounded by
  the exact candidate, daemon generation, browser and Session-room connectivity, and
  stable Session activity transitions; presence heartbeats must not become polling.
- Accepted steer provenance survives both writing and read normalization. Editing and
  resending must not reinterpret a steer as an independently replayable user turn.
- External imports retain their source hashes and derived ids. A separate versioned
  stored-content baseline records the writer's actual result in the document cursor.
  Compare existing role/items/plan exactly against that baseline; never sanitize old
  content to make it match. Without a baseline, compare exact legacy source hashes.
  A local deletion is a conflict, not permission to restore deleted turns automatically.
  Baselines are bound to their own cursor's source hashes, never an independently newer
  metadata digest. Explicit conflict replacement records a fresh baseline.

This adds optional cursor metadata, not a body migration. Old readers can ignore it;
old importers do not understand the stored baseline and may still report conflicts
on projected history. This is not arbitrary downgrade safety.

## Limits and review questions

This is not a proof of arbitrary cross-version application compatibility or reader
safety. TypeScript cannot enforce untrusted inputs, semantic string constraints,
or prevent deliberate casts/raw access. A command changing an already damaged item
may need to repair that item; it cannot rely on tolerance reserved for untouched
history. The initial callback adapter supports order-preserving history edits, not
arbitrary reordering of existing turns in a plain LoroList.

The current full-Mirror read path still materializes history; this change is not
the 3000-round performance acceptance or the windowed ConversationView rollout.
Non-history control-field validation remains outside this HistoryWriter contract.

## Implementation evidence

- `packages/shared/src/{history-writer,history-write-schema,session-mirror}.ts`
- `packages/shared/tests/history-writer.test.ts` and `history-writer.contract.ts`
- `apps/cli/src/lib/assistant-turn-finalize.ts` and the capability-gated
  `session/reconcile-context-compaction` Machine RPC
- [Decision](../.agents/notes/implemented/architecture/2026-09-07-single-history-writer.md)
- [Legacy compaction repair decision](../.agents/notes/implemented/bug-fix/2026-09-11-stale-context-compaction-reconciliation.md)
- [Business-field repair and pending hash decision](../.agents/notes/implemented/architecture/2026-09-07-single-history-writer.md)
- [Imported-history baseline repair](../.agents/notes/implemented/architecture/2026-09-07-single-history-writer.md)

Draft for human review; implementation and passing tests do not grant Spec approval.
