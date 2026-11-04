# Core question visibility and wait presentation

Status: implemented
Translation: current

[中文](2026-10-21-dsh-question-wait-presentation.zh.md)

## Abstract

Lody displayed DSH user questions as permission waits and appended a growing work
duration while waiting for the person to answer. The pinned DSH adapter already
uses standard ACP form elicitation with Core metadata; Lody intentionally bridges
that form onto its durable request/response queue. The conversation now identifies
pending questions through that metadata and uses answer-specific copy; user waits
omit the live work-duration suffix. Pending prompts also read already-hydrated tail
bodies beyond unrelated loading gaps. The wire/storage protocol and human-answer
requirement remain unchanged; live DSH and full desktop verification are separate
from the synthetic regression checks.

## Decision and evidence

[Issue #1786](https://github.com/LodyAI/Lody/issues/1786) points to the compatibility
bridge in `AgentClient.unstable_createElicitation`. The pinned provider's
[user-question bridge](../../../../packages/acp-extension-dsh/src/user-questions.ts)
already sends `elicitation/create` with `_meta.lody.elicitation`. Replacing this
with another provider-specific path or introducing a new session status would
unnecessarily change mixed-version behavior. The existing question card and answer
serialization accept Core-only metadata without Claude/Codex aliases.

The active conversation uses the same pending-question predicate as its composer,
gated by live presence. The durable `requestPermission` state remains compatible
with existing clients, while the visible activity label distinguishes questions.
Warning activity no longer mounts the ticking work-duration label. Completed-turn
timing and response persistence are unchanged. Desktop inbox already checks
`requestKind: ask_user_question`; the shared notification catalog already has
question-specific copy. Hosted push delivery is outside this local fix's boundary.

This adds to the [question continuity decision](2026-10-13-question-request-continuity.md).
The [live-status guide](../../../docs/sessions-live-status.md) owns current behavior.
Tests exercise Core-form parsing, real question-card selection/cancellation and
ACP response content, plus a deterministic 255-second wait. The synthetic reader
regression below covers both enrichment of an existing tool and a synthetic new
tool. The four owning suites contain 74 passing tests. Component typecheck and
i18n checks pass; scoped lint has no errors. Four existing question-recovery
browser journeys pass in system Chrome. Manual visual, live DSH, and full desktop checks remain unperformed.
Root formatting passes; `pnpm check` stops while building the Claude ACP submodule
because its dependencies are absent. Repository docs check reports ten
links into uninitialized Kimi/Pi/Grok submodules, outside the changed documents.

## Question visibility during partial hydration

The user also reported a missing question card while other output continued
streaming. The CLI persists the request before publishing waiting presence, but
presence and history reach the renderer independently. `useConversationTail`
returned a contiguous prefix that stopped at the first unloaded body. Thus an
unrelated older body could hide an already-hydrated question in a newer turn,
while the independently windowed message stream kept displaying updates.

The hook now additionally exposes identity-stable `availableTurns` from the same
leased window, skipping unloaded bodies. The composer permission queue and activity
question predicate consume that selection. Existing contiguous-history consumers,
read leases, epoch fencing, cache ownership, and storage contracts stay unchanged;
no full-history mirror or second loading path is introduced.

A real-Loro reader/React regression holds older body reads behind an explicit
promise, imports a Core question alongside concurrent text into the hydrated active
turn, and asserts both text and form are visible before turn completion or releasing
the old reads. Both request shapes failed before the selection fix and pass after it;
releasing the gate retains a single form. This reproduces a concrete cause matching
the reported symptom, but does not establish the exact transport state of the user's
original session.
