# Engine-opened agent turns get their own history entries

Status: implemented
Translation: current

[中文](2026-09-12-engine-turn-entries.zh.md)

## Abstract

An agent engine can open turns behind the client's back — a kimi cron fire, a
task wake — and its ACP server deliberately forwards their content. Those
updates carried no turn identity, so Lody routed them to the last client turn's
assistant entry: the user watched their real reply get folded into a collapsed
thinking block while the cron turn's status text became the visible answer,
after a daemon restart such updates were dropped outright, and the session
showed "completed" while the engine turn was still running (its process could
even be reaped by the idle GC). The fix threads a turn identity through the
wire (`_meta.lody.turnId` = `auto:<n>` plus `_meta.lody.turnOrigin` for
engine-opened turns) and routes updates by that identity: an engine-opened
turn renders as its own entry, reports the session busy until its end marker,
while boundary ids that live inside one client turn keep their legacy
rendering. The remaining limit is deployment: the kimi stamping ships with
the next managed-runtime artifact, while the Lody-side layers ship with Lody
and degrade to the old behavior for unstamped agents.

## The non-obvious constraint

Late-update routing exists for a legitimate reason: a turn's own output can
settle after `session/prompt` returns, so the finalized turn stays the routing
target with no wall-clock expiry. The same rule is what swallowed engine-opened
turns — from the routing layer's view, a cron turn's first chunk is
indistinguishable from a straggler of the turn that just ended. Any fix
therefore needs a real turn identity on the wire; boundary guesses based on
timing or prompt-flight state were considered and rejected as the primary
mechanism because consecutive engine turns and text-only engine turns are
indistinguishable without one (a cli-only heuristic remains a viable fallback
for unstamped runtimes, trading exactness for deployability).

## Ownership

- The kimi ACP server (`acp-extension-kimi` submodule) stamps every update of a
  turn the engine opened itself with `auto:<engineTurnId>` (non-numeric, so it
  can never parse back into a fork position) plus the origin kind. User-visible
  turns keep plain fork positions and carry no origin marker.
- `history-apply` in `@lody/shared` owns grouping, scoped to kimi-stamped
  turns only: an `auto:` id or `turnOrigin` marker (engine-opened) adopts the
  current entry only while it still accepts deltas — a finalized-but-unstamped
  entry left by a turn that died before producing output must not adopt an
  interrupting turn — or creates `assistant:autonomous-<turnId>`; every other
  id keeps the exact legacy last-wins restamping, because claude's per-message
  boundary uuids and codex collab child turns label boundaries inside one
  client turn and must not splinter its rendering.
- `apps/cli` routes origin-stamped (or `auto:`-prefixed) updates to a
  synthesized autonomous target even when an active/finalized target exists:
  an engine-opened turn can never belong to the client turn's entry, and
  routing early also covers rich content, which bypasses turn-aware regrouping
  at write time.
- The kimi ACP server emits `_meta.lody.turnEnded` when an engine-opened turn
  ends, and history apply finalizes the owning entry (once — a duplicate
  marker must not move the terminal timing). Without the marker the entry
  would render as perpetually streaming, because `message.finished` is the
  renderer's only streaming verdict and finalization otherwise happens only
  for client-dispatched turns. The origin is also persisted as
  `entry.acpTurnOrigin` so the UI can label such turns.
- `apps/cli` also maintains an engine-turn activity marker in the transient
  store: set on the first stamped update of an engine-opened turn, cleared on
  its end marker or on ACP process termination (liveness is process-bounded,
  never wall-clock — a turn whose marker is lost releases the session as soon
  as its process dies). `hasActiveTurn` reads it so the idle GC cannot reap
  the agent process mid-engine-turn, and the live-status RPC upgrades
  `unknown` to `running` so the session stops showing "completed" while the
  engine turn is still working. The Kimi ACP server now emits a metadata-only
  ownership marker at `turn.started`, before the first content delta, so this
  protection covers the whole engine-turn lifetime rather than starting late.
- A Session Stop for an autonomous entry resolves that entry id against the
  current marker before and inside the rewrite barrier. Only the matching ACP
  owner receives the session-wide cancel, and marker/presence cleanup stays
  owner-bound so a late Stop cannot erase a replacement engine turn.
- Goal actions that need a prompt treat the engine marker as the session's
  occupied prompt slot. Their worker waits for a matched end marker, process
  termination, or successful Stop to release it, then rechecks before provider
  submission. The Kimi start marker closes the former pre-first-stamped-update
  window; unstamped providers still retain the old limitation.
- Session deletion is also an engine-release boundary: MessageHandler clears the
  marker and notifies Goal waiters before dropping transient session state, so
  eviction cannot strand a waiter on a deleted session.

## Alternatives and trade-offs

- Cli-only boundary detection (seal the finalized turn after the finalize drain
  and route everything later to an autonomous entry) covers the main case with
  zero cross-repo coordination, but cannot split consecutive engine turns,
  loses the boundary across daemon restarts, and hard-codes a kimi special
  case. Kept as a possible fallback, not implemented.
- Stamping plain engine turn numbers as fork positions was rejected: Lody
  parses `session/fork` targets back out of `turnId`, so engine turns must be
  non-numeric.
- Grouping every stamped id (the first revision of this fix) was rejected on
  review: it splintered claude's per-message boundary uuids into empty entries
  and stole the fork-relevant `acpTurnId` from the real reply entry, and it
  pulled codex collab child output out of the parent turn's inline rendering.
- A generic owner-routing tier for ordinary stamped ids (route a late chunk of
  turn N back to turn N's entry) was dropped to keep the blast radius
  kimi-only: a straggler that crosses into the next turn keeps its pre-existing
  merge behavior rather than gaining a new code path.
- Representing an engine owner as a synthetic client `activeTurnId` was rejected:
  client-release waiters identify actual `TurnRuntimeState` owners, so an
  `auto:<n>` id would create false release signals. A separate engine-release
  waiter preserves the boundary while still letting Goal admission wait.
- Task-wake turns now render as their own entries too, separating a held
  subagent's report from the user turn that prompted it. This is consistent
  with the engine's own turn model but is a visible change worth validating in
  the subagent UX.
- Left as follow-ups: replay/import does not classify cron fires, so a
  reloaded session can still surface cron-fire XML as ordinary user messages;
  the UI does not yet label autonomous turns by origin or show the cron
  turn's trigger prompt.

## Evidence and verification

- Reproduced from the production session wire (`~/.kimi-code/.../wire.jsonl`):
  a cron turn firing one second after a user turn completed had its final text
  persisted as the visible reply of that user turn's assistant entry.
- New unit coverage: engine-turn separation, cross-batch continuity, the
  died-before-output adoption hole, end-marker finalization (and its
  once-only terminal timing), claude multi-uuid last-wins, and codex collab
  inline restamping in `@lody/shared`; autonomous-target gating (origin and
  `auto:` prefix), metadata-only start-marker routing, and engine-turn activity
  note/clear/replace in `apps/cli` (`session-transient-store`); engine-turn
  stamping, fork-index exclusivity, start/end marker emission in the kimi
  `acp-server`; and restoration of legacy completed-turn forkability.
- Reproduced the status-side symptom in a second production session (task-wake
  variant): the engine turn's output merged into the finalized turn while
  `executionState` stayed `idle` — the same invisibility this fix's activity
  marker now covers.
- The first-pass UI review exposed an engine-turn presentation gap: without a
  source cue, an autonomous entry is indistinguishable from a user turn. That
  motivates the persisted `acpTurnOrigin` field; the origin divider remains a
  follow-up and is out of scope here.
- Validation results are scoped by package. The full `apps/cli` suite ran
  262/263 files with 2,749 passed, one failed, and three skipped; the sole
  failure is the known macOS `/var` vs `/private/var` worktree-GC assertion.
  The Kimi `acp-server` suite ran 15/16 files with 163 passed and one failed;
  the failure is the known local bash-fallback e2e assertion. The components
  suite ran 455/456 files with 3,477 passed and one failed in the unchanged
  `app-store-review-prompt-hook.test.tsx` test. The changed-scope focused
  tests, including the legacy Fork regression, passed.
- Focused follow-up coverage verifies autonomous Stop owner matching and
  replacement protection, engine-release Goal admission, deletion-boundary
  release, metadata-only start-marker routing, legacy completed-turn
  forkability, and the pre-provider engine recheck.
- Full live behavior has not yet been verified against a managed runtime
  carrying the new Kimi start/end markers; that requires the next kimi
  managed-runtime artifact.
