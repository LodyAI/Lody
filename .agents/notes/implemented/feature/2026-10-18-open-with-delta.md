# Open with Delta

Status: implemented
Translation: current

[中文](2026-10-18-open-with-delta.zh.md)

## Abstract

Reviewing a Lody session in Delta previously required copying the worktree path or configuring a custom launcher. Delta is now a built-in desktop path launcher using `delta open <path>`. It reuses the existing local path resolution, executable probe, and native launch bridge. Like Zed, Delta is assumed to be installed with its CLI already available; the integration adds no installation flow.

## Decision and limits

The launcher passes `open` and the resolved path as separate arguments, preserving spaces and shell characters. Its persisted id is `delta`, and it uses the same settings helper as other launchers. The launcher uses the [Delta brand mark](https://delta.dev/favicon.svg), rendered with the same theme-aware `currentColor` treatment as Zed.

Keeping a custom launcher would avoid a built-in entry but leave setup to each user. A separate Delta execution service would duplicate the existing desktop boundary, so the implementation instead adds one command specification. Availability uses the existing PATH executable probe; it does not distinguish other executables named `delta`, and users must ensure the Delta app CLI is the command on PATH. Real app launch remains a manual verification requirement.

The related [file action decision](2026-09-17-markdown-file-link-context-menu.md) owns the shared native-action boundary; this addition does not change that boundary or Lody's diff viewer. See [issue #1687](https://github.com/LodyAI/Lody/issues/1687).

## Verification

The owning launcher suite checks desktop availability, browser exclusion, preference parsing, and command arguments with spaces and shell characters. The settings suite checks the selected Delta label, icon, and standard launcher helper. All 24 tests in these two suites and the components typecheck passed. Formatting, translation, documentation, and repository boundary checks passed. The full `pnpm check` stopped during ACP adapter preparation because unrelated runtime dependencies were not installed; real Delta GUI launch remains untested.
