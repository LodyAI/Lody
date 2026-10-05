# Clear file-editor dirty state when undo restores saved text

Status: implemented
Translation: current

[中文](./2026-10-05-file-editor-undo-saved-state.zh.md)

## Abstract

The file editor treated every accepted content event as an unsaved edit, even when undo restored the saved text. The save hook now owns a complete-text baseline and removes the pending buffer when the editor returns to it. The toolbar, tab state and leave guard follow that same save state. Writes in flight, failed saves and unresolved conflicts continue to protect drafts; verification uses synthetic storage and real Chromium/Monaco, rather than a packaged desktop acceptance run.

## Decision and evidence

On base `11734261b5a03f914df20aa5f1f9827afd675bb9`, real Monaco restored the synthetic `qa-marker.txt` text to `QA_STARTED_20261004` with Cmd+Z while Unsaved remained, Save stayed enabled and Refresh stayed disabled. The existing seven save-hook tests passed and did not cover this operation. This establishes the defect on the inspected branch; it does not map a separately reported deployed build to this revision.

`useCodeCollabSaveText` owns the saved baseline, latest draft and active-write text. Accepted open/refresh snapshots and external applications establish the baseline; successful saves advance it to the returned text. Full string comparison avoids treating a hash collision or an undo-stack version as proof of equality. The editor's first-event suppression remains limited to initialization. Its separate provider-open guard now follows the same dirty state, so a clean undo cannot keep blocking a subsequent provider read.

Undo during a write remains pending: if B is saved after the user returns to A, the existing explicit-save drain persists A next. Failed writes never advance the baseline or release protection merely on settlement. A detected external conflict invalidates the old baseline; matching the old open text cannot dismiss it. Conflict markers remain pending editor content, and override uses the text actually resolved by the provider rather than assuming newer edits were saved.

A generation fences asynchronous save and conflict-resolution results across file switches (including A → another file → A) and accepted external replacements. Provider identity alone is not a reset: provider rebuilds may occur while the same file is being edited or saved. These decisions preserve the [external-snapshot remount protection](./2026-09-11-file-preview-replays-stale-snapshot.md).

## Verification and limits

The owning hook and component suites cover undo/redo, a successful new baseline, write success/failure during undo, coalescing edits that return to the active save text, failure retry, external replacement, file switches and conflict protection. The component suite also checks native-source edits returning to a provider's externally saved text. Tests use explicit Promises and synthetic content.

The Storybook regression uses the production file view, save hook and real Monaco undo stack; only storage is in memory. Chromium interaction checks initial A, edit B, undo A, redo B, save B, undo to now-unsaved A, redo B and Refresh, together with the real beforeunload veto. Dismissing the browser close confirmation retains the draft. Screenshots are provided with the delivery, outside committed source. The parent tab's dirty-state callback is tested; the full Session close-confirmation dialog, packaged Electron, disk RPC and deployed build are not exercised by this fixture.

Four related suites pass 74 tests, and the Chromium keyboard regression passes one test. `pnpm format` and `pnpm run docs check` pass; no relevant SHA-protected topics are registered. Full `NODE_OPTIONS=--no-experimental-webstorage NODE_ENV=test pnpm check` passes on Node 26.10.0, including all 4,774 component tests and 199 Electron unit tests; seven existing CLI/RPC tests remain skipped by their suites. The process flag only disables Node's experimental Web Storage for verification. Without it, an unchanged boot-shell test fails on Node 26; isolated Node 22.14 passes that test and the related suites (93 tests), but the full run fails an existing shared WASM import. No unrelated source or system runtime was changed. Product layout, copy, permissions, save protocol and deployment are unchanged.
