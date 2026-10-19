# Preserve the prompt in single-question Core forms

Status: implemented
Translation: current

PR: https://github.com/LodyAI/Lody/pull/1528

[中文](2026-10-13-core-single-question-prompt.zh.md)

## Abstract

Codex single-question forms displayed `Input requested` instead of the full
question because Lody preferred the request message over the field description.
The shared bridge now reads Core field descriptions first, regardless of question
count, while retaining the legacy Claude single-question message rule. Option
descriptions already survived and remain available in the card's details dialog.
The defect was reproduced with real Codex in Lody Nightly; the local fix passed
parser, durable-history, CLI bridge and production-card tests. The patched desktop
has not been launched, and previously persisted incorrect prompts are not repaired.

## Decision and evidence

The pinned Codex adapter `b67f2eaab63247159c8cbdbd4075334f69729daf`
puts the short header in a property's `title`, the full question in its
`description`, and a generic prompt in the form's `message`. Core is pinned at
`97007e746737cae86dc17c8ed577447ceb1b2aa6`. The shared parser already handled
multiple Core questions correctly, but applied the older Claude message-first
rule to every single-question form. AgentClient then persisted the incorrect
normalized question, so the renderer received the wrong text.

Use the existing Core-form recognition in the shared parser rather than matching
provider names or special-casing the literal generic message. The adapter's
mapping is already correct; changing its generic message would hide the consumer
bug and leave other Core producers affected. Missing field descriptions retain
the existing message/header fallback. Legacy Claude forms without Core metadata
still use the request message for a single question.

```text
Core property description → shared question → permission history → question card
Legacy Claude single form message ────────↗
```

This adds to the [answer-notes bridge decision](../feature/2026-09-20-ask-question-answer-notes.md)
without changing answer associations, protocol fields or history ownership.
Current behavior is documented in the [AgentClient README](../../../../apps/cli/src/agent/README.md).

## Verification and limits

- A real Codex Plan session in Nightly produced a single selection question. Its
  card displayed the generic prompt; opening an option's details showed its full
  description. The test question was cancelled after observation.
- Before the fix, the shared choice/free-text regressions both failed with the
  generic prompt (52 existing tests passed). The CLI regression failed for the
  same reason (53 existing tests passed).
- After the fix: 56 shared tests, 58 CLI bridge/notification tests and 15 component
  tests passed. The shared tests cross HistoryWriter, export a Loro snapshot,
  reopen it and recover both the question and answer. The component details test
  now consumes a parsed Core form and asserts the full question before opening
  the production card's option description.
- Shared, CLI and components typechecks passed, as did changed-file formatting,
  lint (zero errors; existing warnings) and `pnpm run docs check`.
- PR preparation ran `pnpm format` successfully and attempted `pnpm check`.
  Outside the sandbox, full typechecking and lint passed; the CLI suite reported
  4,087 passed, one failed and four skipped. The unchanged SSH-submodule fixture
  failed with `context_unreadable`, also reproduced in isolation. The full
  components suite passed 5,182 tests in the earlier sandbox attempt; that
  attempt was stopped after filesystem/socket restrictions. All remaining root
  boundary and i18n checks passed separately. Full repository validation is not
  claimed green.
- No provider/submodule revision, lockfile or storage migration changes. Existing
  records that already contain the wrong normalized prompt remain unchanged.
  Live acceptance of the patched desktop and repository-wide checks are separate
  from the focused validation above.
