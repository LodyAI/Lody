# Prompt Shortcut touch focus ordering

Status: implemented
Translation: current

[中文](2026-10-07-shortcut-touch-focus.zh.md)

## Abstract

A mobile touch on a Prompt Shortcut could flash the menu without inserting its
Prompt. WebKit blurs the textarea before click and temporarily exposes caret zero
when focus returns, so focusing after starting asynchronous preparation cancels
that request. Row selection now restores focus and the saved selection before
starting preparation; preparation keeps the loading/error menu open. Phone and
tablet WebKit browser tests pass; a physical iOS app has not been tested.

## Cause and decision

The observed order was `touch → blur → click → prepare → focus(caret 0) → cancel`.
The query closes on the temporary zero caret, then reopens when selection returns,
explaining the flash. This is independent of body download latency: even an
immediately resolved prepared body reproduced the failure.

`MentionItem` captures both selection endpoints, focuses, restores the selection,
and only then calls `onMentionAdd`. `MentionRoot` reopens the menu when preparation
begins so loading and retry feedback survive the transient query close. Existing
abort/generation fences still reject edits, dismissals and obsolete results. This
repairs the focus ordering instead of weakening cancellation or adding a timer.
The earlier [body prefetch](../feature/2026-09-29-prompt-shortcut-body-prefetch.md)
reduces download waits but cannot prevent this cancellation.

## Verification

The navigation suite simulates WebKit's transient focus caret with explicit promise
completion, covering floating/docked selection, a failed preparation, and dismissal
before completion. All four added cases fail on the original code because their
signals are already aborted. The existing menu/navigation suites pass 59 tests.
The prepared Shortcut Storybook fixture and Playwright touch tests pass in WebKit
at 390px and 820px, asserting inserted text, retained focus and a closed menu.

The full component suite passes all 556 files / 4,836 tests.
Root typechecking/lint, formatting, i18n, import/platform/public boundary checks,
and documentation checks pass. Full `pnpm check` stops in two untouched CLI tests:
process-group termination reports `kill EPERM`, and recursive Git transport reports
`context_unreadable` from the environment's Git credential wrapper.
