# Simplify the static share dialog copy

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/682

[中文](2026-09-14-share-dialog-copy.zh.md)

## Abstract

The setup screen of the static share dialog stacked four explanatory paragraphs.
It now keeps the public link-access line and a single image/file-attachment line.
The removed paragraphs disclosed that the published package includes thinking and
tool records, that the title is public in link previews, that later messages are
not added, and that runtime settings and typed terminal output are omitted.
Capture, projection and publication behavior is unchanged; only the confirmation
copy shrank. The revoke and post-revoke notices were tightened in the same pass,
keeping the irreversible-download warning. The sharing Spec and the sharing
component instructions drop the first-screen disclosure obligation to match.

## Decision

The extra paragraphs repeated material the product owner judged redundant and
crowded the single primary action on the setup screen. The first screen now says
only that anyone with the link can view the conversation and that images are
shared while file attachments are not. The published package is identical to
before: `session-share-export.ts` and `session-share-package.ts` still project and
omit the same fields, readers still receive thought and tool content, and typed
terminal output remains omitted on the wire.

The same pass tightens the revoke and post-revoke wording. The revoke confirmation
keeps the warning that downloaded copies cannot be recalled, because that is the
irreversible consequence of the action.

This intentionally removes the only in-product disclosure that a share can contain
sensitive thinking/tool records, that its title is public in link previews, and
that terminal output is dropped. Keeping that disclosure is not an unnoticeable
side effect; it is the requested change. `specs/session-sharing.md` no longer
requires the confirmation screen to disclose the omissions, and the sharing
`AGENTS.md` now describes the reduced first screen instead of mandating the broader
disclosure.

## Verification

`node scripts/check-i18n.mjs` passes after removing the two unused keys
(`sharing.static.contentNotice`, `sharing.static.historyOmissions`) and updating
`sharing.static.attachmentNotice` in both locales. The full `@lody/components`
suite passes (462 files, 3519 tests), including the manager and settings tests that
render the surviving `sharing.static.publicNotice`; `tsgo --noEmit` and oxlint pass.
Full workspace `pnpm check` was not run.
