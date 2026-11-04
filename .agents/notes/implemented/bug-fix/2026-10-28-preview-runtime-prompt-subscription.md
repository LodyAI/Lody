# Complete prompt-suggestion reads in conversation previews

Status: implemented
Translation: current
PR: [#1997](https://github.com/LodyAI/Lody/pull/1997)

[中文](2026-10-28-preview-runtime-prompt-subscription.zh.md)

## Abstract

Desktop smoke journeys failed before entering the product because onboarding
crashed when its real composer subscribed to prompt suggestions. The subscription
was added on main, but the frozen tour runtime and conversation story runtime
still lacked the method. Main supplies the tour correction through #2001; this PR retains the matching
conversation-story correction. Each frozen runtime reports no suggestion and
returns cleanup through the typed read contract. Production subscription behavior
is unchanged; the remaining desktop acceptance comes from CI against the new head.

## Evidence and decision

Run `40628058358` failed all six smoke journeys at the Agent configuration heading.
Its failure screenshot shows `subscribePromptSuggestion is not a function`, rather
than a slow or absent heading. The shared composer hook introduced by #1951 calls
that required interface. `tourRuntime` was cast from a partial object, bypassing
the missing-property check. The conversation Storybook runtime had the same omission,
which also blocked the retained new-chat transition examples.

The tour fix and its behavioral isolation test are owned by
[the upstream correction](2026-10-28-onboarding-tour-prompt-subscription.md).
Rebasing this PR preserves that implementation and removes its duplicate changes;
the remaining runtime change belongs to `SessionConversationPage.stories.tsx`.
Supply the frozen read interface at each fixture owner rather than suppressing a
required method call in the production hook or loosening E2E assertions/timeouts.
The fixtures synchronously publish `null`, return a cleanup function and never
reach the outer machine/cloud runtime. Type each method against
`WorkspaceRuntime['subscribePromptSuggestion']`.

## Verification and limits

The existing tour isolation probe now runs the real prompt-suggestion hook and
asserts empty visible suggestion state alongside fixture project data. It failed
with the CI TypeError before the fix and passes afterward. Existing browser
journeys cover provider skip/pending completion and retained mobile first-send
presentation. Full desktop smoke results must be checked against the pushed head;
local browser checks do not establish Electron or device acceptance.
