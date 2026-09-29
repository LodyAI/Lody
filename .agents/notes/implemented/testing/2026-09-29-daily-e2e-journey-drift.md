# Realign Desktop Daily journeys with the current UI and ACP sessions

Status: implemented
Translation: current

English | [中文](2026-09-29-daily-e2e-journey-drift.zh.md)

## Abstract

Desktop Daily Issue #507 kept failing after the desktop UI changed, because several page objects selected controls by retired labels or matched unrelated overlays. The journey selectors now target the current controls and the message or dialog they belong to. MCP and fork journeys distinguish a Turn's ACP session from separate title generation, and worktree cleanup tolerates a transient terminal relay disconnect while still requiring observed cleanup. The first PR full run passed 22 of 24 macOS journeys and exposed two more stale selectors, now corrected. The next run passed all 24 macOS journeys; Windows and Linux still need a new Daily run.

## Evidence and decision

The [September 29 full Daily run](https://github.com/LodyAI/Lody/actions/runs/36539627906) built successfully on macOS, Linux, and Windows, then failed six or seven of 24 scenarios per leg. The macOS and Linux logs repeatedly show a missing `Agent Provider` heading, old theme button and preview-item selectors, a Goal dialog lookup for the current popover, and a project removal lookup matching both the dialog and a success toast. Context copy targeted the first fork button on the page and timed out while its menu item stayed outside the viewport. Linux also found the same attachment prompt in both history and the pending-message surface. These are locator failures: each replacement stays scoped to the user-visible action or history row being asserted.

The MCP startup assertion selected the last `session-new` event. Title generation launches another ACP session without the Turn's selected MCP, so the last event may belong to the title. The synthetic ACP fixture now marks title and Turn sessions using the existing `LODY_TITLE_AGENT` environment signal. The journey waits for the Turn session and its own completed prompt before checking its MCP startup configuration. This keeps an actually empty Turn selection observable as a failure.

The September 28 run also failed the queue journey on all three platforms: the queued prompt appeared on multiple page surfaces, so its global text locator resolved to multiple elements. The queue Page Object now finds the row through its `Remove from queue` control and the row's prompt. The September 29 run passed this journey, but the ambiguous locator remained a repeatable failure mode.

On Windows, `terminal.list` returned `terminal_socket_closed` immediately after Session archive. The terminal relay rejects pending requests on socket close and connects again on the next request. Cleanup polling now represents this transport error as a nonmatching observation and continues until the relay returns an empty terminal list; persistent unavailability still times out. This does not establish why the socket closed.

The Windows fork and session-management journeys timed out after their source prompt. Their [artifact screenshot and trace](https://github.com/LodyAI/Lody/actions/runs/36539627906) show the source response completed under the intended project. The old fixture found its ACP prompt event only through a `realpathSync` equality between the recorded `cwd` and the synthetic project root; the artifact did not retain the ACP event log, so the exact path difference cannot be established. The fixture now marks title versus Turn ACP sessions and correlates the completed prompt with the Turn session id. It also keeps its synthetic event log in the scenario artifact for future path diagnosis.

The [first PR full run](https://github.com/LodyAI/Lody/actions/runs/36563017669) passed 22 of 24 macOS journeys. Its failure screenshots showed that the theme selector is a button with `role="combobox"`, so a Playwright button-role lookup cannot find it. After the final Agent Provider deletion, the current empty machine page shows `No agents on <machine> yet`, not the retired `No providers on this machine yet.` copy. The follow-up assertions now use the actual role and current empty-state text, in both supported locales.

The [follow-up PR full run](https://github.com/LodyAI/Lody/actions/runs/36570175372) built the desktop and passed all 24 macOS journeys and 249 steps, including both previously failing settings journeys.

## Verification and limits

The changed files pass Oxfmt and `git diff --check`. `pnpm e2e:check` cannot start in this nested worktree because the E2E package has no installed `@cucumber/cucumber`; `pnpm e2e:build` stops at the CLI clean step because `rimraf` is absent. Root `pnpm check` and `pnpm format` likewise stop on missing tools. Repository guidance skips `pnpm install` in nested checkouts, so the built-Electron smoke could not start locally. `pnpm run docs check` reports 62 broken links to unpopulated ACP submodule paths, with no finding in this note pair. The hosted PR full suite passed 24 of 24 macOS journeys; Windows and Linux still await a new Daily run.
