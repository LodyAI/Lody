# A fallback generator for provider-owned session titles

Status: implemented
Translation: current

[中文](2026-10-03-provider-owned-title-fallback.zh.md)

## Abstract

Handing title generation to the ACP adapters (2026-09-08) made a silent adapter
failure leave a Session on its creation draft forever: generation inside the adapter
is best-effort and signals nothing, and Lody had deliberately chosen no fallback.
Observed in the wild: a Claude Code routed through a gateway whose upstream rejects
its title call never titled any Session — every dispatched child Session kept the
Role prompt's first line as its visible name. Turn finalization now arms a delayed
check (90s) for provider-owned Sessions whose title is still missing or still a
replaceable draft; Lody's isolated generator then runs as the safety net under the
same draft-only write guard, and a provider title arriving later still replaces a
locally generated one. The residual cost is one duplicate isolated generation for a
provider that delivers slower than 90s after turn end, which the write guard makes
harmless.

## Evidence and decision

The 2026-09-08 decision recorded the accepted trade-off explicitly: "a failed
generation now leaves the draft title rather than falling back to Lody's generator."
What changed is evidence about how often that path fires. In the case that motivated
this note, Claude Code 2.1.284 (via the acp-extension-claude adapter) asked for
session titles on the Session's own model with thinking disabled; the gateway
(DashScope's qwen-cn, glm-5.3) rejects thinking-off requests with
`enable_thinking parameter is restricted to True`, so every title call failed, the
adapter swallowed it, and every Session on that provider — typically one Agent Role
dispatching another — stayed on its draft title for its whole life. The same failure
class also blocks Claude Code's own auto-mode classifier requests, so the symptom
surface is wider than titles. The adapter cannot report the failure (its own title
module is best-effort by design), which leaves the title's state as the only signal
Lody can observe.

The fallback therefore arms from turn finalization, not from a push-detection
mechanism: after a completed turn, if ownership still says the provider generates
titles (identity table or the persisted `sessionTitle` capability, with runtime
overrides revoking identity as before) and the title is still missing or
`titleSource: 'draft'`, a single delayed check is scheduled. The check re-reads the
title state at fire time, so a title that landed inside the window — provider push,
user rename, or a locally generated title — cancels the work without side effects.
`shouldFallbackGenerateSessionTitle` (shared `ai.ts`) owns the predicate;
`provider-title-fallback.ts` owns the scheduling with injected ports and clock;
`message-handler` splits its generation core (`generateSessionTitleIfMissing`) out of
the ownership-gated create-time path so both callers share the in-flight dedupe and
the draft-only conditional write.

The 90-second window exists for the providers that do deliver: Claude's adapter
generates at turn end via a small-model call (seconds), Codex right after its first
turn (observed 21 minutes from create, but the turn itself took that long — the
window starts at turn end), Grok right after the first prompt. A title still absent
90s after a completed turn is not coming from that turn. If a later turn's provider
push does arrive after a local fallback title, `maybeStoreAgentSessionTitle`'
s existing `['draft', 'generated']` write guard lets the provider title replace it.

## Alternatives considered

Retry-on-provider-failure was rejected as impossible at Lody: the adapter signals
nothing on failure, so there is no failure event to key on; only the title's absence
is observable. Checking immediately at turn end (no grace window) was rejected
because it races every provider that delivers within seconds — the exact duplicate
generation the original decision avoided; the window converts that race into a
delayed, guarded check. Checking only from the second turn onward was rejected
because dispatched child Sessions routinely run exactly one long turn, which is
precisely the case that motivated the fallback.

## Limits

The check lives in the daemon process: a daemon restart inside the window loses the
timer until the next turn finalizes (acceptable — the next turn re-arms it, and a
Session with no further turns keeps its draft, as before). Sessions on providers
whose titles arrive later than 90s after turn end get a locally generated title that
the late provider title then overwrites. The fallback uses the Session's first user
prompt as generation input, exactly what create-time generation would have used.

## Validation

`shouldFallbackGenerateSessionTitle` cases cover owner/non-owner, missing/draft/
user/generated title states, and absent Sessions. `provider-title-fallback.test.ts`
drives the scheduler with a manual clock: arms only for owner Sessions, generates
from the first user prompt after the window, skips when a provider title or user
rename lands inside it, keeps the earliest deadline across overlapping turns,
treats overridden runtimes as non-owner, skips empty prompts, and cancels on
dispose. No live Claude/Codex/Grok session was driven end to end through the
fallback path; the motivating gateway failure was verified directly against its
upstream (stock gateway yields no title, patched gateway titled the Session), but
that verification belongs to the gateway's own fix.
