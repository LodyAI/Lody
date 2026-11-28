# Session automation as event perception: slot supersession and medium-independent causal depth

Date: 2026-11-28
Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/3519

[中文](2026-11-28-session-automation-event-perception.zh.md)

## Abstract

One-shot automation waits are being chained by agents to imitate timers:
each wake re-registers the next wait inside its own resume text. Real use shows
97 re-registrations of one patrol family in 13 hours, hundreds of dead-but-armed
ledger rows, walls of stale continuation notes, and cross-session message storms
the 16-hop causal budget cannot see because ledger-delivered inputs carry no
depth. This note records the converged design behind the
[Session automation events Spec](../../../../specs/session-automation-events.md):
automations perceive state transitions only (time-triggered work belongs to
Schedules), every registration occupies a slot superseded by name, and
automation continuations join the existing causal depth count derived from
history rather than transport. Recurring registration, intent-level dedup,
dispatch coalescing, clock removal and per-session outbound gates were evaluated
and rejected. The design ships in PR #3519 with synthetic integration coverage
for supersession, depth derivation, settlement and ledger retirement; the
field evidence comes from the reporters and no live multi-agent reproduction
was run.

## Field evidence

Two independent reports, both consistent with code inspection:

- [LodyAI/Lody#3477](https://github.com/LodyAI/Lody/issues/3477): one long-lived
  workspace accumulated 1105 automation rules; a single "8-minute supervisor
  patrol" family re-registered 97 times in ~13 hours; 571 waits parked in
  `matched`; 576 rules still `enabled` after their waits delivered; one receipt
  queued for ~3 hours; a dozen identical chips per Session.
- A coordinator supervising worker Sessions registered a 15-minute check whose
  resume text contained the full coordination instructions. The workspace
  recorded 1133 condition completions and 3533 capacity wakes; each wake
  re-injected the instruction text, which outranked the user's later
  conversation-level "message each other less" turn, and fanned out into
  cross-session steer traffic. A user-reported relay chain (register, wake after
  ten minutes, re-register) shows the same self-perpetuation pattern in a single
  Session.

## Verified amplifiers in current code

Each claim below was checked against the working tree on 2026-11-28:

- **Causal depth is never counted on the ledger path, not merely reset.**
  `prepareInvoke` in
  `apps/cli/src/automations/actions/session-actions-legacy.ts` inherits only
  model/mode/config values from history, so wake inputs carry no `chainDepth`
  at all. The acceptance guard in `apps/cli/src/mcp/lody-mcp-server.ts` reads
  `undefined ?? 0` for every automation-driven turn, making the 16-hop fuse
  inert for ledger loops and a free budget reset for mixed loops alternating
  between steer and re-registration.
- **Settlement regression.** In the same file's `reconcile`, a turn already
  `handled` falls through to `queued` whenever `hasAutomationSessionWork` is
  true — and that predicate includes delegated Operations still running in
  other Sessions (`hasPendingWorkForRequester`). A finished wake displays as
  "condition met, waiting to execute" for as long as any child work lives.
  The gate dates to the original automations PR (#1952), not a later regression;
  it couples the receipt's delivery contract to the Session's global work state.
- **Byte-level dedup is defeated by construction.** `registerWait` in
  `apps/cli/src/automations/storage/ledger.ts` requires program text, interval,
  expiry and reason to be identical, and timer conditions embed a fresh absolute
  timestamp per cycle; task rephrasing defeats it even without timestamps.
- **Dead rules never retire.** The one-shot continuation rule inserted by
  `finishWait` stays `enabled` forever; `publish()` deserializes every rule for
  every event; `list` returns terminal rows without filtering; nothing prunes.
- **The no-observation validation is dead code.** Registration passes
  `validateOnly: true`, but `evaluateAutomationProgram` returns right after
  parsing in that mode, so the `AUTOMATION_VALIDATION_HAS_NO_READS` error is
  unreachable and a pure `ctx.now` timer registers cleanly today.
- **Archive leaks exec/fetch-only waits.** `ctx.read` re-checks session state
  and fails archived sessions into terminal error after five strikes, but
  conditions using only `ctx.exec`/`ctx.fetch` bypass that check and poll
  forever after archival; only dispatch is blocked.
- **Wake inputs are indistinguishable from human messages.** The resume text
  becomes the entire input with no provenance, so an agent cannot tell an
  automation wake from a user turn, and a stale chained instruction re-enters
  as the newest "system instruction".
- **Clock removal cannot work.** `@opencode/codemode` 2.2.0 implements `Date`
  as a sandbox intrinsic (`stdlib/date.js`), so `Date.now()` survives removing
  `ctx.now`; `ctx.exec` can also shell out to `date`. Removing `ctx.now` would
  be signage, not mechanism, and would break legitimate freshness comparisons
  (`ctx.now - observedAt`). This reverses the initial design impulse; the real
  gates are the observation requirement and causal depth.
- **Documentation drift, in the opposite direction than first assumed.**
  `autoDeliver.merge` defaulting to `true` is the deliberate product decision
  of #3296; it is `references/settings.md` that is stale, not the schema.

## Decision

The Spec carries the contract; the reasoning that shaped it:

- **Event perception vs time.** Automation senses state transitions and process
  exits; time may schedule observation but never constitutes an event. Clock
  wake-ups already have an owner — Schedules, with human confirmation, single
  instance management and pause. An agent-built `ctx.now` relay chain is a
  confirmation-free cron that bypasses that consent surface, so the design
  refuses the demand rather than serving it better.
- **Slot supersession.** A registration belongs to its key or the unnamed
  default slot; registering supersedes the slot's unfinished wait atomically,
  including withdrawal of its not-yet-started continuation input. The proposed
  per-Session key cap was dropped in implementation: a cap nobody can size adds
  machinery without a demonstrated hazard (depth bounds path length, never
  breadth — volume is a separate, unproven concern). Rephrasing and post-compaction
  re-registration become idempotent replacement. Registration responses carry
  the active wait inventory for free, so the agent sees what it replaced and
  what is already pending without a separate `list` round-trip — this addresses
  the silent-drop risk of an unrelated wait sharing the default slot.
  Supersession never cancels a started turn: withdrawal is atomic at the
  Session input owner (`unlessActive` inbox semantics), and an input that
  already drives the runtime is left to complete on its own.
- **Causal origin frozen at registration, budget enforced at both ends.** The
  first implementation derived depth from the newest user-role turn in the
  target Session's history; review correctly rejected this because chronology
  is not causality — a depth-15 turn in Session A registering a wait targeting
  Session B would inherit depth 1 from B's unrelated human history. The shipped
  design freezes the causal origin into the registration: exact invoking-turn
  provenance when available, the in-flight turn of the requesting Session as
  CLI attribution, otherwise a human or external root at depth zero. The
  continuation costs exactly one hop over that frozen depth, registrations at
  the cap are refused with `CHAIN_DEPTH_EXCEEDED`, and continuation admission
  durably fails any row that would exceed it — a terminal `failed` receipt,
  never an endless block. Depth bounds path length, never breadth: it does not
  cap how many independent keys or targets one shallow turn may fan out to.
- **Zero-observation results are invalid.** Dynamic enforcement at evaluation:
  a result produced without any `read`/`fetch`/`exec` call fails the wait as a
  deterministic programming error on first occurrence rather than counting
  toward generic check errors. The planned static AST hint at registration was
  dropped: the dynamic gate fires on the first check anyway, and a heuristic
  that aliases defeat cannot carry its documentation weight. The counter is a
  lint-like misuse guard, not a consent proof: a program can observe without
  depending on the observation, so routing timers to Schedules remains a
  product policy carried by guidance and the causal budget, not by analysis
  of arbitrary JavaScript.
- **Provenance prefix.** Continuation inputs open with origin facts only
  (wait id, reason, registration time), in line with the invariant that text
  Lody sends to agents carries facts, never workflow direction. Richer headers
  (intervening human turns, active wait summaries) were dropped: the human's
  turns are already in the transcript, and the register/list responses cover
  inventory.

## Rejected alternatives

- **Recurring registration (`repeat`, `everyMs`), the headline ask of #3477.**
  It legitimizes the confirmation-free cron: recurring LLM wake-ups with
  external side effects are exactly what Schedules require human confirmation
  for. A bounded lease variant (`maxRuns`) merely negotiates the size of the
  bypass. Every legitimate chain-shaped need decomposes into existing owners:
  CI/PR loops are Auto delivery; child supervision is Operation Inbox receipts;
  external state is one zero-token Host-polled wait firing once on the actual
  transition; periodic judgment is a Schedule.
- **Intent-level dedup** (AST normalization stripping literals, or keying on
  reason text). Programs are opaque text; wording drift defeats any heuristic
  while the slot mechanism already covers the honest cases deterministically.
- **Dispatch-time coalescing of queued wakes.** The burst pattern is a symptom
  of chain re-registration, which the design removes. The post-fix remainder —
  genuinely independent keyed waits firing inside one long turn — is rare,
  small, and information-distinct; merging would discard facts. Supersession's
  input withdrawal covers the same-slot queue case.
- **Removing `ctx.now`.** Signage rather than mechanism (see evidence above);
  harms legitimate freshness logic while `Date.now()` remains in the sandbox.
- **A separate automation loop counter.** Two budgets with two reset semantics
  launder each other: depth 15 on one medium, switch medium, never reach the
  cap anywhere. One medium-independent causal budget is the simpler design.
- **Per-session outbound cross-session gates** (the follow-up ask in #3477's
  comments). A default-on setting nobody touches until after an incident is a
  liability, and steer-vs-queue semantics are a `lody_session_chat` question
  independent of automation. With chains dead and supervision routed to
  receipts, traffic volume collapses without new settings; the general chat
  question is recorded as an open question in the Spec instead.

## Consequences

- The automation success metric shifts: `register` usage should decrease as
  Auto delivery, group settlement, Inbox receipts and `recoverCapacity` absorb
  their proper scenarios. The MCP skill's first job becomes routing — the
  decision table leads — not teaching program syntax. Schema fields gain
  descriptions so `lody_help` output shows `ctx.read` resources and Auto
  delivery without a skill read.
- The ledger hygiene work (settlement, retirement after a 48-hour window, rule
  closing, archive cancellation, live-row list filtering) and the contract
  change (frozen causal origin with enforced budget, slot supersession with input withdrawal,
  provenance prefix, observation requirement) shipped together; archived-session
  cancellation is convergent — the wait cancels at its next evaluation, when
  the session context read fails permanently, not at archive time. Retirement
  covers the incident's dominant shape: a normally matched wait retires from
  its continuation's settlement, and historical rows self-heal through the
  hourly prune without a destructive migration — receipts stay as inspectable
  history in `activities`.
  `existing_session: "current"` for Schedules remains open in the Spec.
- `#3477` can then be answered: supersession covers its dedup intent, causal
  depth plus slot withdrawal covers the storm and stale-burst mechanics,
  retirement covers ledger growth, and the recurring-timer request is declined
  with the Schedule boundary as the reason.

## Verification and limits

- The pre-change code claims were verified by reading the working tree on
  2026-11-28; incident numbers come from the reporters. Synthetic integration
  tests cover supersession fencing, frozen causal depth with cap refusal,
  queued withdrawal and running-turn survival, zero-observation failure,
  settlement independence and terminal pruning including the normal-completion
  path; no live multi-agent reproduction was run.
- `inputConfig` — including `_lodyAutomation` and `chainDepth` — is part of the
  session document schema, so provenance survives restarts and applies to
  encrypted sessions uniformly; legacy waits without frozen provenance continue
  at depth 1 as a bounded grace before the cap binds.
- Whether depth-16 forced stops surface a comprehensible reason to users of
  long unattended pipelines is untested; the fuse is a disaster ceiling, and
  the intended answer to hitting it is re-authorization through a Schedule,
  not a larger number.
- Related active notes, cross-linked rather than superseded: the
  [automation coordinator](../../proposed/architecture/2026-10-25-session-automation-coordinator.md)
  (whose "automations do not replace Schedules" boundary this design sharpens),
  [external checks](../../proposed/architecture/2026-10-28-automation-external-checks.md),
  [managed long runs](../feature/2026-11-16-managed-long-runs.md),
  [automation guidance scope](../simplification/2026-11-21-automation-guidance-scope.md),
  and [bound agent message chains](../bug-fix/2026-10-11-bound-agent-message-chains.md)
  (the existing depth budget this extends across media).
