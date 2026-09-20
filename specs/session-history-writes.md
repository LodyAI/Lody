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
- Provider updates classified as transient before the history boundary must never
  reach `HistoryWriter`. Builtin Codex `agent_thought_chunk` is one such update:
  it may publish a bounded live status through ephemeral presence, but it creates
  no assistant `thought` item, is absent from exports and reopens, and clears when
  the turn's presence is cleared. This is prospective only; opening a session does
  not scrub thought items persisted by older clients. Standard thought chunks from
  other ACP providers retain the normal history path.
- Tool fields other than type/toolCallId
  parse only changed fields without reparsing untouched tool payloads; outcome-only
  edits retain existing request information. Identity changes require complete item parsing;
  changed content blocks are parsed separately. Invalid new fields reject the command before any write.
- New history accepts existing legacy built-in CLI selector normalization without rewriting
  stored history. Steer config edits parse only changed fields.
- Queue promotion removes its queued row only after history acceptance; failed writes retain it.
- Manual Codex compaction owns its native turn through completion. Stop interrupts
  that turn and retains the ACP prompt until `turn/completed` confirms its outcome
  or the provider connection closes. For an in-flight prompt with a ready ACP session,
  Lody records cancellation and sends provider cancel without interrupting its owner
  fiber. The owner and unfinished history remain until ACP returns; new dispatch and
  undelivered steer stay pending. Raw steer submissions and in-flight steer configuration
  participate in the same drain. If any remain pending five seconds after
  Stop, Lody terminates the old session so connection closure can end the prompt.
  This deadline does not wait for cancel acknowledgement or restart on repeated Stop.
  Failed termination retains ownership until ACP ends. Start and interrupt
  acknowledgements, like compaction-item completion, do not release execution ownership.
  Finalizing an assistant turn settles the context-compaction markers it leaves
  open, on every path and not only after confirmed cancellation: a marker the
  provider never carried to a terminal status is persisted as failed before
  another turn is accepted. Markers superseded by a later compaction marker in
  the same turn are duplicate identities for one compaction episode — an adapter
  re-announcing a compaction already in flight — and are removed instead, so one
  episode renders as one row. A provider update that later arrives for the same
  `toolCallId` still wins.
  Opening a Session does not trigger a history-repair RPC or rewrite old outcomes.
- A steer adapter reports one final delivery outcome: `applied`, `not-applied`, or
  `unknown`. Only `not-applied` may return the same user turn to ordinary dispatch;
  `applied` is already consumed, while `unknown` becomes `delivery_unknown` in history
  with a `delivery-unknown` response. It never dispatches automatically. Explicit resend
  creates a new user turn after warning that the original may already have executed;
  it does not change the original outcome. Session execution does not infer delivery
  from Stop, transport failure, or local ownership state.
- Stop and target-prompt completion end local document/preparation/configuration/verdict
  waits, releasing the steer queue and rewrite lease. This does not cancel the raw request
  or discard its verdict. Exception: a handoff adapter may answer the yielded prompt before
  reporting a submitted steer's verdict, so its completion waits for that verdict; the
  steered prompt is the next turn, never cancellation-drain work. Already-applied ownership transfer finishes atomically; queued
  steers must not begin preparation for a stopped target. Failed outcome persistence must
  still release the application lease and permit cancellation cleanup.
- Execution owns steer status and exact-id recovery activations in `steerTurnStatuses`.
  A refusal never rewinds producer-owned `latestUserMsgId` or clears another input's
  missing-history marker. The watcher projects results when history arrives and clears
  recovery entries on ordinary claim, terminal projection, or missing-history failure.
  RPC application acknowledgements are presentation hints, not renderer history writes;
  a delayed acknowledgement cannot resurrect a terminal entry. Applied steer provenance
  excludes the entry from ordinary restart dispatch.
- Cancelling a turn carries an explicit pending-input policy. User Stop promotes a
  provably `not-applied` steer; Edit & Resend, access revocation, and cleanup preserve it.
  If Stop wins while an `applied` result is pending, the late result must not transfer
  ownership or replay that user turn. The first cancellation policy wins repeated races.
- Pre-prompt ACP lifetime is independent of pending input: Stop uses promote/discard,
  Edit & Resend preserve/keep, and access revocation preserve/discard. Edit & Resend must
  retain the process that owns its prepared replacement. Create/restore fences remain.
- Proven non-delivery survives a promotion write failure. The CLI returns `promotion-failed`
  with the error instead of implying successful recovery or unknown delivery. A daemon's
  `recoveryOwned` response keeps recovery with that daemon: the renderer retries a proven
  promotion failure once through the same RPC and surfaces persistent failure. Legacy
  responses retain the pending_apply/pending/seen dispatch repair. Active, terminal, and
  removed turns cannot be revived. Timeout or unknown delivery never authorizes retry.
- Foreground run configuration belongs to its turn's Effect signal. Once that turn is
  interrupted, an in-flight configuration request may finish, but it must not issue a
  later configuration mutation or persist the interrupted turn's runtime patch.
  Steer configuration obeys the target's local-wait signal and the same mutation fence.
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
- [Business-field repair and pending hash decision](../.agents/notes/implemented/architecture/2026-09-07-single-history-writer.md)
- [Imported-history baseline repair](../.agents/notes/implemented/architecture/2026-09-07-single-history-writer.md)
- [Interrupt pending input exactly once](../.agents/notes/implemented/bug-fix/2026-09-14-interrupt-pending-input-exactly-once.md)
- [Steer Stop and recovery ownership](../.agents/notes/implemented/bug-fix/2026-09-16-steer-stop-recovery-ownership.md)
- [Versioned turn hashes and primitive metadata insertion](../.agents/notes/implemented/architecture/2026-09-14-versioned-history-hashes-and-primitive-metadata.md)

Draft for human review; implementation and passing tests do not grant Spec approval.
