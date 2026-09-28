# Show live work in the scroll-to-latest control

Status: implemented
Translation: current

[中文](2026-09-27-scroll-to-latest-working-state.zh.md)

## Abstract

When a reader was scrolled away from the end while an Agent reply streamed, the
scroll-to-latest control stayed a plain down arrow and did not communicate that new
output was still arriving. The conversation stream now reuses its existing live-work
signal: working output renders the shared spinner, while permission waits retain the
arrow. Focused component tests and two Storybook interaction stories cover both
states; browser execution confirmed the expected icons.

## Decision

- `SessionChatStreamView` owns the control and switches its icon from the same
  `agentActivityShimmer` signal that drives live activity presentation.
- A non-empty activity label plus `agentActivityShimmer` is the working state. This
  keeps permission requests, which deliberately use the non-shimmering warning tone,
  on the ordinary navigation icon.
- No second presence subscription or new state prop was added; the existing status
  stays authoritative for both the activity row and the control.

## Evidence and limits

- The previous control rendered `ArrowDown` unconditionally at
  `packages/components/src/components/ai-gui/view.tsx`; it now renders `Spinner` for
  live work and keeps the down arrow for warning/idle states.
- `packages/components/tests/agent-activity-row.test.tsx` releases sticky follow with
  a synthetic upward wheel and asserts the working spinner and permission arrow.
- The behavior is specified in [conversation scroll](../../../../specs/conversation-scroll.md).

## Validation

`git diff --check`, Oxfmt, the components typecheck, and targeted Oxlint pass.
`tests/agent-activity-row.test.tsx` passes all 14 tests. The Storybook production
build succeeds, and a headless browser check of both new stories observes the
working spinner and waiting arrow respectively. `pnpm run docs check` remains
blocked by pre-existing broken links to uninitialized ACP submodules.

- Pull request: [#1073](https://github.com/LodyAI/Lody/pull/1073).
