# Context copy waits for a visible menu anchor

Status: implemented
Translation: current

[中文](2026-10-01-context-copy-visible-anchor.zh.md)

## Abstract

The October 1 Daily context-copy journey failed before opening the first message's
menu because its upward scroll settled at 1px on macOS and 2px on Ubuntu rather
than exactly zero. The first message was already visible, so this failure did
not establish a broken copy or export operation. The journey now waits for the
first message marker and Fork button to be fully inside the viewport before
clicking. It preserves the pointer interaction and all clipboard acceptance;
the exact source of the small scroll residual is not established by the trace.

## Evidence and decision

The [Daily run](https://github.com/LodyAI/Lody/actions/runs/36835904880) tested
`7d502f3d99fdcdbbdd43d032c6d903d4ed497e04`, the main at initial investigation.
Main advanced to `93545f01b69cb0c98ddd3f19d46540decd95a007` during this work;
the helper remains unchanged there.
The macOS and Ubuntu failure records point to the exact-zero poll in
[`ContextCopyPage`](../../../../e2e/src/support/pages/context-copy-page.ts), before
the Fork menu or clipboard assertions. Both traces record an upward wheel of
1000px; their final screenshots show the first message inside the conversation.
The poll reports 1px and 2px respectively.

This partially replaces the endpoint decision in the
[September 29 journey-drift note](2026-09-29-daily-e2e-journey-drift.md).
That change correctly moved the virtualized anchor into view to prevent a menu
opening above the viewport, but exact `scrollTop === 0` added an unrelated
numerical condition. PR #1175 does not change this helper.

A 2px numeric tolerance would admit the observed residuals but would still
substitute a scroll coordinate for the actual interaction requirement. Instead,
the existing `LODY-CONTEXT-001` regression now checks full viewport intersection
for the first prompt before hovering, and for the Fork button before clicking.
These checks reject a clipped or offscreen anchor even if it remains mounted
and satisfies Playwright's `toBeVisible`. The native wheel, pointer click,
menu-item click, rich Markdown inclusion, later-message exclusion, streaming,
reopen, isolation, and cleanup checks remain in the owning journey. No new scroll
writer, wait, product behavior, or Spec intent is introduced.

## Verification and limits

- `pnpm e2e:check` passes: suite contract, 24-scenario/249-step dry-run, TypeScript,
  31 script tests, and 18 support/fixture tests. The worktree uses an ignored link
  to already installed E2E dependencies; no install or source edits were made in
  the maintainer checkout.
- An ignored Chromium layout probe runs the changed Page Object with a real
  scrolling element, pointer-driven menu, and browser clipboard. Requested
  offsets 0, 0.5, 1, and 2px pass the exact prefix checks; Chromium reads 0.5px
  back as 1px in this environment. A partly clipped prompt at 40px, an offscreen
  prompt at 100px, and an offscreen Fork button at 2px each fail before opening
  the menu or changing the clipboard. The probe is synthetic helper evidence,
  not a real desktop integration run.
- Local `pnpm e2e:build`, `pnpm check`, and `pnpm format` stop on missing workspace
  tools (`rimraf`, `tsgo`, and `oxfmt`) and unpopulated ACP submodules. Changed
  TypeScript and notes receive a separate Oxfmt check; all changes pass
  `git diff --check`. The PR requests
  the hosted full Electron regression; its checks own the subsequent result.
- The captured failures do not prove that subpixel rounding alone caused the
  residual, nor do they verify clipboard behavior: execution stopped before
  copying. Fresh Windows/Linux integration results remain a separate boundary.

PR: [#1190](https://github.com/LodyAI/Lody/pull/1190).
