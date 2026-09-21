# Bridge Harness user questions through ACP

Status: implemented
Translation: current

[中文](2026-09-20-dsh-user-questions.zh.md)

PR: [Lody #840](https://github.com/LodyAI/Lody/pull/840)

Provider PR: [acp-extension-dsh #21](https://github.com/LodyAI/acp-extension-dsh/pull/21)

## Abstract

Harness presets exposed `ask_user_question`, but the ACP adapter supplied no
answerer, so calls failed with `NO_PROVIDER`. The adapter now registers an
Agent-scoped answerer and sends standard ACP forms through Lody's existing Ask
Question flow. Core answer notes preserve multi-select choices plus custom text;
no host production code or shared contract changes were needed. Cancellation
releases tool waiters, although SDK 1.3 cannot dismiss an individual sent form.

## Decision

The [Core contract](../../../../packages/acp-extension-core/README.md) assigns
questions to `elicitation/create`. Codex's `CodexElicitationHandler` demonstrates
capability negotiation, explicit property associations, and native-answer
conversion; its transport is different, so DSH uses its pinned SDK's
`AgentSideConnection.unstable_createElicitation`.

```text
Harness tool → userQuestions.ask (live/root checks)
             → Agent-scoped answerer → per-session queue
             → ACP form → existing Lody question card
             ← native answers ← validated ACP content
```

Generated positional keys avoid collisions with native ids. Single-select Other
uses `customAnswerFor`; multi-select uses `noteFor` only after Core answer-notes
negotiation. An explicit, collision-free Other option allows custom-only input.
Without notes support, clients retain replacement-only Other. The adapter
restores original ids and removes only its own synthetic option from answers.
Plan-review detail is included in the question body and approval remains an
explicit option label; there is no automatic Plan/permission transition.

Native `userQuestions.ask` remains responsible for `CALLER_NOT_LIVE` and
`DELEGATED_CALLER`. Scoped registration plus exact ACP ownership prevents cross-
session routing. Cancelled waiters never overtake an active request; abort,
session cancel/close, and disconnect release waiting tools. Invalid replies,
decline, and transport failures are not converted into empty successful answers.

Core is already published at 0.1.6, so only DSH's dependency advances. The root
lockfile already overrides Core to `workspace:*`; its resolved importer is
unchanged. Profile revision v13 invalidates generated profile/probe identities.
A local Prettier configuration preserves the existing submodule style without
depending on an enclosing repository's configuration. The old test asserting
only the profile revision literal was removed as non-behavioral coverage.

## Verification and limits

- DSH build and 34 unit tests pass, including real SDK transport, multiple
  questions, custom text, invalid answers, queue cancellation and failure recovery.
- The optional native smoke test uses actual pinned Harness tool, service and
  Cordis scope dispatch with synthetic agent/catalog boundaries. It verifies
  answer delivery, two-session routing, live/root rejection, cancellation,
  decline and the existing approval waterfall without model/network calls.
- A direct check runs actual generated forms through Lody's shared parser,
  permission outcome builder and response builder, preserving multi-select/custom.
- The four existing full-profile settings smoke cases pass under Node 24.15.
  Under Node 22.20 their launcher exits before ACP initialization; this runtime
  startup difference remains undiagnosed; no runtime fix is included here.
- DSH `format:check` passes. Root `pnpm check` and `pnpm format` were attempted
  but are blocked by missing checkout dependencies (`esbuild` and `oxfmt`).
- Root documentation and public-boundary checks pass after initializing their
  referenced submodules; no protected document topics are registered.

SDK 1.3's legacy connection exposes no per-request cancellation option. A late
reply is ignored, but an independently aborted tool's card can remain until
host dismissal or turn cancellation. No live desktop/model interaction was run.
See the [draft Spec](../../../../specs/deepseek-harness-user-questions.md) and
the existing [answer notes decision](2026-09-20-ask-question-answer-notes.md).
