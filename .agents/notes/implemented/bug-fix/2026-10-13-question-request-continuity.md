# Preserve answers and recovery across pending question requests

Status: implemented
Translation: current

PR: https://github.com/LodyAI/Lody/pull/1533

[中文](2026-10-13-question-request-continuity.zh.md)

## Abstract

Question submissions could fail silently, request navigation erased unfinished
answers, and an input-method confirmation could submit a custom answer prematurely.
The existing response owner now shows question write failures, pending forms retain
their local state across navigation, and the custom-answer handler uses the shared
input-method guard. Only the current request is visible and answerable, and completed
requests release their drafts. Playwright reproduced the failures and verified
recovery, mouse/touch navigation, and candidate confirmation through browser events;
full desktop and physical input-method validation remain unverified.

## Cause and decision

`FloatingPermissionRequest` already caught writer failures and stored an error,
but only its ordinary-permission branch rendered that error. `QuestionRequest`
now passes it into the question card, which renders the existing localized copy
in its inset notice directly above the submit/pager actions. Secondary prose and
a small destructive-colored mark identify the failure without turning the entire
sentence red. This replaces the initial bare paragraph outside the card, which
visually detached the failure from the answer and action. The existing form keeps
its answer and notes for retry; no retry queue or new response protocol is added.

Previously the request switch replaced a keyed `QuestionRequest`, destroying its
card's local choices, custom answer, notes, and page. Pending forms now keep their
session/request identity within the existing surface. Inactive forms are hidden,
inert, and disabled, including when the active request is an ordinary permission.
Accepted answers and cancellations, withdrawn requests, and surface unmount remove
the forms and their drafts. This retains mounted form state rather than introducing
storage or a second draft cache; inactive forms still occupy memory until release.

The custom-answer handler checked only `nativeEvent.isComposing`. An Enter carrying
only the existing `keyCode`/`which` 229 signal therefore authored an answer while
the user was confirming an input-method candidate. It now uses `isImeComposingKeyboardEvent`
from the shared UI helper, matching the composer and queued editor. Ordinary Enter
keeps its existing next-page/submit behavior; no delay or second keyboard state is added.

The [request Spec](../../../../specs/permission-requests.md) remains draft and now
states the bounded retention lifetime. This adds to the
[single live prompt decision](../feature/2026-09-24-permission-prompt.md) and
[separate answer notes](../feature/2026-09-20-ask-question-answer-notes.md).
The earlier permission note's failure guarantee was implemented for ordinary
permissions but incomplete for questions; this fix closes that gap.

## Evidence and limits

- [Production response owner](../../../../packages/components/src/components/sessions/floating-permission-request.tsx)
  uses the unchanged `usePermissionResponse` writer admission boundary.
- [Real-component stories](../../../../packages/components/src/stories/FloatingPermissionRequest.stories.tsx)
  simulate rejection and acceptance at the writer boundary and publish accepted
  outcomes into synthetic history. They introduce no product appearance.
- Seven [Playwright recovery cases](../../../../packages/components/tests/e2e/composer-submission-focus.spec.ts)
  passed in Chrome, including touch, ordinary permission interleaving, exact retry
  payload, removal of completed fields, and input-method signals followed by ordinary
  Enter. Chromium ignores `which` in KeyboardEventInit; the legacy-event case explicitly
  defines that field. Before/after screenshots are ignored artifacts under
  `artifacts/usability/round2/` and `round3/`. Visual-review comparisons under
  `artifacts/usability/feedback-ui/` cover light/dark and narrow Chinese layouts;
  the recovery case checks feedback containment and placement above the action at
  390 and 1000 pixels.
- The duplicate mock-only submit check was consolidated into a stateful submission
  test that checks the resulting readonly card and answer payload. The permission
  prompt and question card suites passed all 30 component
  tests. Package typecheck still reports missing/mismatched dependencies in unchanged
  modules; no errors remain in the changed files. Desktop build was already blocked
  by CLI dependencies in the preceding queued-edit validation round and was not repeated.
- These are production-component journeys with synthetic writer/history fixtures,
  not validation of daemon delivery, provider behavior, or physical native keyboards.
  The input-method comparison replays Enter with keyCode 229; it does not drive an OS IME.
