# Restore an archived session from its composer

Status: implemented
Translation: current

[中文](2026-11-03-archived-session-composer-restore.zh.md)

## Abstract

An archived conversation's disabled composer asks the user to restore it, but the restore action previously lived in the header menu or archive list. The composer now offers the existing restore action next to that prompt, with a pending state that prevents duplicate requests. Every tab of an archived workspace targets the workspace's existing restoration handler, and retained drafts and tab-close states are unchanged. The header menu remains available and restore failures use the existing feedback.

## Decision and scope

The user considered a header button and preferred the action where the disabled input explains why chatting is unavailable. The composer replaces its disabled send action with Restore only when the host supplies a restore action. The workspace owner supplies its existing handler to each conversation surface, including child and side tabs, so the action does not accidentally restore just the selected child. The handler retains its local-project availability checks and failure messages.

This builds on [archive and tab closure independence](../bug-fix/2026-09-24-archive-independent-of-tab-close.md); restoring is still explicit and does not change tab-close state. The existing composer stays mounted to preserve draft data. A visible header button was considered, but places the action farther from the explanation.

## Verification

The existing composer submission suite exercises the disabled archived input, a single in-flight restore request, preserved draft, and disappearance of the action after restoration. The Archived Storybook state renders the production composer with synthetic data. This note does not claim verification in a native mobile shell.

An isolated development desktop with a scripted Agent also created and archived a synthetic conversation, opened it from Archive, and restored it through the composer button. The conversation returned to the sidebar and its input became editable. The desktop dev-build entry for a removed automation worker had to be temporarily omitted to launch this preview; the source entry was restored afterwards.
