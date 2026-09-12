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
  engine turn is still working.

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
  `auto:` prefix) and engine-turn activity note/clear/replace in `apps/cli`
  (`session-transient-store`); engine-turn stamping, fork-index exclusivity,
  and end-marker emission in the kimi `acp-server`.
- Reproduced the status-side symptom in a second production session (task-wake
  variant): the engine turn's output merged into the finalized turn while
  `executionState` stayed `idle` — the same invisibility this fix's activity
  marker now covers.
- Verified end-to-end in a live OSS desktop running the branch and a locally
  built stamped runtime: a cron fire after a user turn rendered as its own
  finished turn, and session presence read `running` during the engine turn
  and `idle` after its end marker. The first-pass UI gap it exposed — the
  engine turn appeared with no origin cue — motivates the persisted
  `acpTurnOrigin` field that a follow-up renders as an origin divider.
- Full suites pass on both repos except three failures verified to reproduce on
  unmodified trees: two Claude credential-store probes and one macOS
  `/var` vs `/private/var` worktree-GC assertion in `apps/cli`, and one local
  bash-fallback e2e test in `acp-server`.
- Not yet verified end-to-end against a live session running a stamped runtime;
  that requires the next kimi managed-runtime artifact.
