# Session automation as event perception: slot supersession and medium-independent causal depth

Date: 2026-11-28
Status: proposed
Translation: current

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
and rejected. The design is reviewed and agreed in conversation but not yet
implemented; every behavioral claim about current code was verified against the
working tree, while the fixes themselves have no validation yet.

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
  including withdrawal of its not-yet-started continuation input. The slot cap
  (proposed 4) bounds parallelism; rephrasing and post-compaction
  re-registration become idempotent replacement. Registration responses carry
  the active wait inventory for free, so the agent sees what it replaced and
  what is already pending without a separate `list` round-trip — this addresses
  the silent-drop risk of an unrelated wait sharing the default slot.
- **Causal depth derived from history.** Depth is computed when a continuation
  input is prepared: walk back user-role turns (bounded by the hop limit); the
  most recent one either carries automation provenance — continue its depth
  plus one — or is human — reset. No registration-time capture, no new wait
  columns, and CLI/MCP registration paths behave identically. Depth binding to
  Session continuity rather than one wait's lineage matches the real hazard,
  which is unattended self-propagation of the conversation itself.
- **Zero-observation results are invalid.** Dynamic enforcement at evaluation:
  a result produced without any `read`/`fetch`/`exec` call fails the wait as a
  deterministic programming error on first occurrence rather than counting
  toward generic check errors. A static AST hint at registration gives honest
  programs immediate feedback pointing at Schedules; it is UX, not a gate,
  because aliasing defeats static analysis by construction.
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

## Consequences and implementation split

- The automation success metric shifts: `register` usage should decrease as
  Auto delivery, group settlement, Inbox receipts and `recoverCapacity` absorb
  their proper scenarios. The MCP skill's first job becomes routing — the
  decision table leads — not teaching program syntax. Schema fields gain
  descriptions so `lody_help` output shows `ctx.read` resources and Auto
  delivery without a skill read.
- Proposed PR split, in dependency order: (1) ledger hygiene — settlement,
  retirement, rule closing, archive cancellation, list filtering; (2) contract
  change — causal depth derivation, slot supersession with input withdrawal,
  provenance prefix, observation requirement; (3) discoverability — schema
  descriptions, skill routing rewrite, `settings.md` merge default correction,
  `existing_session: "current"` investigation. Unit (1) is independently
  shippable bug repair.
- `#3477` can then be answered: supersession covers its dedup intent, causal
  depth plus slot withdrawal covers the storm and stale-burst mechanics,
  retirement covers ledger growth, and the recurring-timer request is declined
  with the Schedule boundary as the reason.

## Verification and limits

- Code claims in this note were verified by reading the working tree on
  2026-11-28; the design itself is unimplemented and unvalidated. No live
  multi-agent reproduction was run; incident numbers come from the reporters.
- Chain depth derivation assumes user-role turns in Session history carry
  automation provenance (`_lodyAutomation`) reliably; encrypted and legacy
  transcripts need checking during implementation.
- Whether depth-16 forced stops surface a comprehensible reason to users of
  long unattended pipelines is untested; the fuse is a disaster ceiling, and
  the intended answer to hitting it is re-authorization through a Schedule,
  not a larger number.
- Related active notes, cross-linked rather than superseded: the
  [automation coordinator](2026-10-25-session-automation-coordinator.md)
  (whose "automations do not replace Schedules" boundary this design sharpens),
  [external checks](2026-10-28-automation-external-checks.md),
  [managed long runs](../../implemented/feature/2026-11-16-managed-long-runs.md),
  [automation guidance scope](../../implemented/simplification/2026-11-21-automation-guidance-scope.md),
  and [bound agent message chains](../../implemented/bug-fix/2026-10-11-bound-agent-message-chains.md)
  (the existing depth budget this extends across media).
