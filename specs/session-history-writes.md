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
  container identity. New writes store an ordinary metadata string (tool `title`/`status`/
  `kind`/`toolCallId`, a `locations[].path`) as a primitive, and create a Text container
  only for fields that stream (`text`/`thought`, `markdown`, a tool block's `text`/`output`
  and nested `content.text`, a worktree step's `output`). The rule holds at every nesting
  level: nested tool/worktree metadata such as `command`, `path`, `args`, `cwd`,
  `terminalId` and `input` values is primitive, never Text. This is an insertion policy:
  not a migration, no rewrapping of stored values, and no validation constraint on old or
  future payloads. Storage-layout changes are separately reviewed.
- Fork is a stored-history copy, not new-message authoring. Copy from a snapshot
  captured by the writer, retaining target initialization rows and unchanged unknown fields
  and opaque items. Explicit changes and new fork notices still require parsing.
  Prepend copied rows and reject id collisions; retain target containers.
  Caller-created JSON cannot claim this provenance. Copying does not modify the source.
  A fork's detached capture belongs to the fork operation and survives source-cache
  eviction until explicitly released. Ordinary store-scoped captures become invalid
  on teardown; release remains safe after teardown.
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
- Manual Codex compaction owns its native turn through completion. Stop interrupts
  that turn and retains the ACP prompt until `turn/completed` confirms its outcome
  or the provider connection closes. For an in-flight prompt with a ready ACP session,
  Lody records cancellation and sends provider cancel without interrupting its owner
  fiber. The owner and unfinished history remain until ACP returns; new dispatch and
  undelivered steer stay pending. If the raw prompt remains pending five seconds after
  Stop, Lody terminates the old session so connection closure can end the prompt.
  This deadline does not wait for cancel acknowledgement or restart on repeated Stop.
  Failed termination retains ownership until ACP ends. Start and interrupt
  acknowledgements, like compaction-item completion, do not release execution ownership.
  The CLI persists unresolved compaction as failed after confirmed cancellation,
  before accepting another turn.
  Opening a Session does not trigger a history-repair RPC or rewrite old outcomes.
- If Stop wins while a submitted steer awaits acceptance, a later successful ACK must
  not transfer ownership, change the source invocation or settle the source as handled.
  Mark that exact steer user turn `canceled` before returning `stale-turn`, without
  changing dispatch pointers. Keep the current cancellation owner until provider completion.
  Do not requeue the accepted steer: rejection of the local ownership transfer is not
  proof of non-delivery.
- Accepted steer provenance survives both writing and read normalization. Editing and
  resending must not reinterpret a steer as an independently replayable user turn.
- External imports retain their source hashes and derived ids. A separate versioned
  stored-content baseline records the writer's actual result in the document cursor.
  Compare existing role/items/plan exactly against that baseline; never sanitize old
  content to make it match. Without a baseline, compare exact legacy source hashes.
  A local deletion is a conflict, not permission to restore deleted turns automatically.
  Baselines are bound to their own cursor's source hashes, never an independently newer
  metadata digest. A baseline written before hash versions existed has no version field
  and is v1, matching a v1 cursor; treating the absent field as "not v1" discards a
  legitimate projected baseline and misreports a normal append as a conflict. A genuine
  v1/v2 mismatch is still rejected. Explicit conflict replacement records a fresh baseline.
- Canonical turn hashes are versioned. v1 hashed `{role, items, plan}` verbatim; v2 hashes
  a canonical item form so a sealed tool_call skeleton and the full tool_call it was sealed
  from produce the same hash, and a source change limited to tool payload bytes does not
  alter a turn's identity. A missing version means v1. Every hash is compared only against
  a hash of its own version; the stored cursor records the version of its own
  `importedTurnHashes` and the sync metadata versions its own `replayDigest`
  independently, because a conflict marker may advance only the metadata. A v1 document
  cursor is never read as v2, which would manufacture a false `prefix_mismatch`. A version
  mismatch without the replay history needed to recompute is an error, not a permissive
  guess. New imports use v2; existing v1 canonicalization is unchanged.

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
The v2 canonical form is defined for the shapes this repository writes. The full
sealed-skeleton feature (a reader-side `ref` payload fetch, payload hooks, and the
UI that consumes them) is not implemented here; this change only prevents a future
sealed turn from looking like a hash conflict once such skeletons exist.

## Implementation evidence

- `packages/shared/src/{history-writer,history-write-schema,history-materializer,session-mirror,schema}.ts`
- `packages/shared/src/session-data/{history-import,loro}.ts`
- `apps/cli/src/lib/local-project-history-sync-service.ts`
- `packages/shared/tests/history-writer.test.ts`, `history-writer.contract.ts`,
  `history-storage-policy.test.ts` and `session-history-import-port.test.ts`
- `apps/cli/tests/local-project-history-sync-service.test.ts` and `local-project-history-sync-writer.test.ts`
- [Decision](../.agents/notes/implemented/architecture/2026-09-07-single-history-writer.md)
- [Versioned turn hashes and primitive metadata insertion](../.agents/notes/implemented/architecture/2026-09-14-versioned-history-hashes-and-primitive-metadata.md)

Draft for human review; implementation and passing tests do not grant Spec approval.
