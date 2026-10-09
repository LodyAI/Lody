# Session history writes

Status: draft
Translation: current

[中文](session-history-writes.zh.md)

## Scenario

A synchronized session contains an unknown future item, or a damaged old text
item. Sending a valid user turn and streaming a different item must still work.
That tolerance must not authorize creating new malformed items locally.

## Contract

- Renderer and CLI share one HistoryWriter for local Loro history changes. A reader
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
  A detached capture held by a fork survives source-cache eviction and source
  teardown. Its writer provenance remains authoritative across backend instances;
  copying never depends on the source store remaining open.
- Failed edit-and-resend can restore captured old history without reparsing it as
  new input. A one-use local rollback receipt restores only the changed range, preserving
  current content of untouched rows and subsequent appends. It captures only the affected
  stored range and rejects changes to existing row identity/order
  and edits inside that range, except a newly inserted pending user row becoming seen/read
  with every other field unchanged. It is not crash recovery or a distributed transaction.
  External provider imports remain new inputs, not privileged stored-history copies.
- Acceptance in the Loro writer means a local CRDT write. Existing repo persistence and transport
  still own durability, permissions, and remote synchronization.
- Tool fields other than type/toolCallId
  parse only changed fields without reparsing untouched tool payloads; outcome-only
  edits retain existing request information. Identity changes require complete item parsing;
  changed content blocks are parsed separately. Invalid new fields reject the command before any write.
- New history accepts existing legacy built-in CLI selector normalization without rewriting
  stored history. Steer config edits parse only changed fields.
- Queue promotion removes its queued row only after history acceptance; failed writes retain it.
- Each buffered ACP notification keeps a stable operation ID across automatic retries. If a backend
  commits only a batch prefix before a later write fails, retrying the buffered entries reuses those
  IDs and the backend treats an already-accepted ID as idempotent. Filtering and batch splitting
  preserve the ID-to-notification pairing. Separately enqueued provider notifications remain distinct
  even when their payloads match.
- Dispatch and activation checks resolve duplicate turn IDs to the last stored row,
  matching targeted history reads and writes. Earlier copies cannot revive a terminal
  last copy. Full history export preserves every stored row; this is not deduplication.
  If an attempted terminal repair leaves that identity dispatchable, the current check
  stops without replaying it or repeatedly materializing history.
- A user-status write applies to every stored copy of that user turn. The last copy
  decides whether a guarded write is accepted; earlier copies follow it without a settled
  copy regressing. A steer verdict moves only copies still in steer states. Requeueing an
  undelivered steer is refused when any copy has started or settled.
- Before appending a queued turn that history does not contain, queue promotion rereads
  session meta inside its lease. A refused steer for that turn holds the queued row until
  the steer's own history arrives or missing-history recovery settles it. An applied or
  settled steer, an active or handled turn, a settled activation, a missing-history
  tombstone or completed assistant output removes the row without appending history;
  that evidence takes precedence over a refused steer status.
- Composer steering requires authoritative ACP support for acknowledged steering,
  a live prompt, and a known unfinished assistant turn. During activity, a guide
  preference or inverted queue submission without that support appends to the
  regular Queue, including when capability information is unavailable or provisional.
  It retains queue order and editing/removal until normal promotion; it creates no
  pending-apply history entry and sends no steer request. This routing decision
  precedes delivery; submitted native steers retain the outcome rules below.
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
  `recoveryOwned` response keeps recovery with that daemon: the renderer neither retries
  nor repairs that turn. Legacy responses (no `recoveryOwned`) retain the
  pending_apply/pending/seen dispatch repair. Active, terminal, and
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

### Backend selection and display reads

New sessions use Loro by default. With both experimental switches enabled, the
renderer prefers Roost only when the target advertises the required history
protocol. Missing or older capabilities retain Loro before any session write.
An explicit Roost request to an unsupported target fails before metadata, history
or warm-up is created. Legacy sessions and non-renderer creation paths without an
explicit choice retain Loro.
Existing sessions keep their persisted backend when the switch changes. Commands
use the session's selected backend, with one writer for its storage. Loro-specific
container rules above apply to that backend; Roost preserves immutable sealed
segments and projects state corrections and independent permission outcomes into
the same logical turn. Structural replacement prepares a coherent branch and
atomically activates it; a failed preparation never empties the visible branch.
Cloud command clients read and write through the session's owning machine rather
than selecting a database on the calling machine. Control metadata and
delivery state remain in Loro. Local history acceptance does not establish remote
Roost synchronization.

Performance work must preserve the existing Lody conversation identity and its
owner workflow. Edit & Resend may reuse an immutable prefix through the storage
SDK's internal branch operations; it must not create or navigate to another Lody
conversation. Old writers must remain fenced, lost acknowledgments must refresh
the committed branch, and rollback must preserve later appends or refuse a
conflicting edit. A cached goal guard is valid only for its exact history version;
missing, invalid or concurrently changed cache evidence requires an authoritative
check. Cache absence never establishes that no active goal exists.

Opening a Roost conversation reads the latest active-branch window. Scrolling
up loads older logical turns through a reverse cursor. Whole-history search,
outline navigation, counts and facts must cover earlier pages without requiring
manual scrolling. These consumers load directory pages in the background and
keep body hydration bounded by their leases; opening does not await a full-history
read. Restoring a reading position loads its logical turn before declaring the
initial window ready. New messages retain the loaded prefix
and its cursor. A branch rewrite invalidates incompatible pages and refreshes the
loaded window without displaying the superseded suffix. Unloaded rows contribute
neither fabricated messages nor complete-history facts. Explicit export/snapshot
operations retain an authoritative full-read capability.

Text deltas update visible content and outline summaries without repeatedly
rebuilding unchanged whole-history business facts. Goal, permission, scheduling,
diff and status changes still invalidate their consumers. Reverse page loading
preserves retained row/body identities when their positions and content remain
unchanged. Optimization must not delay control updates or claim complete facts
for an unread prefix.

Previously synchronized history remains readable when its owner is unavailable,
including reopening the conversation, searching and navigating older cached turns.
The renderer persists a read-only projection scoped by account, workspace, machine
and session. Owner read responses bind page content, count and a durable revision
to the same observation. Consecutive changes update the affected cached rows
atomically; a missed revision stages a replacement through bounded pages while
retaining the previous coherent snapshot. Reconnection refreshes through the
existing owner transport. The cache never accepts or replays user commands, and
cannot supply history this device has never synchronized.

### Verification limits

This is not a proof of arbitrary cross-version application compatibility or reader
safety. TypeScript cannot enforce untrusted inputs, semantic string constraints,
or prevent deliberate casts/raw access. A command changing an already damaged item
may need to repair that item; it cannot rely on tolerance reserved for untouched
history. The initial callback adapter supports order-preserving history edits, not
arbitrary reordering of existing turns in a plain LoroList.

The Roost reader now uses active-branch pages; the legacy Loro reader still loads
its directory. This does not establish 3000-round performance acceptance.
Non-history control-field validation remains outside this HistoryWriter contract.
The v2 canonical form is defined for the shapes this repository writes. The full
sealed-skeleton feature (a reader-side `ref` payload fetch, payload hooks, and the
UI that consumes them) is not implemented here; this change only prevents a future
sealed turn from looking like a hash conflict once such skeletons exist.

## Implementation evidence

- `packages/shared/src/{history-writer,history-write-schema,history-materializer,session-mirror,schema}.ts`
- `packages/shared/src/session-data/{history-import,loro}.ts`
- `apps/cli/src/lib/local-project-history-sync-service.ts`
- `apps/cli/src/session/{roost-node-session,roost-history-generation,roost-rpc-session}.ts`
- `apps/cli/tests/roost-session-backend-contract.test.ts`
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
