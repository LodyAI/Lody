# Derive the completed assistant target without an effect mirror

Status: implemented
Translation: current

PR: [#1534](https://github.com/LodyAI/Lody/pull/1534)

[中文](2026-10-13-completed-assistant-derived-state.zh.md)

## Abstract

The conversation stream previously notified its parent of the last completed
assistant id in an effect, and the parent stored another copy in state. The
parent now derives that id from its current ConversationView with the same
index-only query used by the stream. This removes the notification effect and
the extra state update while preserving completion, empty-entry, and duplicate-id
selection rules. It is a small reduction in update paths, not a verified fix for
the separately investigated React #185 crash.

## Decision and scope

`SessionChatInterface` already subscribes to `useConversationVersion`. It memoizes
`resolveLastAssistantTurnIds(conversationView).lastCompletedAssistantMessageId`
by that view and version, returning null without a view. No additional subscription,
body lease, or full-history materialization is introduced. Switching the view or
updating its completion facts recomputes the value during render, without waiting
for a child effect to publish it.

Remove `SessionChatStream.onLastCompletedAssistantMessageIdChange`, its only
caller, the reporting effect, and the parent's session-tagged state mirror.
Header fork actions, quick actions, and review-prompt consumers continue using
the same completed-assistant target. The stream still derives its own rendering
targets using the shared query.

The broader [update-depth investigation](../../proposed/bug-fix/2026-10-13-message-list-update-depth-investigation.md)
remains proposed. Scroll transactions, synchronous layout measurement, hydration
windows, native selection, and scroll-state ownership are unchanged. Reworking
those boundaries needs a separate reproduction and behavioral acceptance; removing
this effect does not establish the original crash's cause.

## Verification

The existing stream-item, conversation-reader/hydration, and fork-destination suites
pass: three files, 43 tests. Focused formatting and lint complete; lint reports
warnings in the existing changed-file scope. Tests use this checkout's workspace
sources with dependency trees borrowed from an existing local checkout, not a
fresh frozen-lockfile installation.

The initial ordinary test command could not find Vitest. Package type checking
with the borrowed dependencies fails on missing Electron/platform dependencies
and existing SDK type mismatches, so full type checking is not claimed. The
documentation check outside the sandbox reports 82 broken links to missing ACP
submodule files, none in this change's document scope. Root check/format commands
cannot complete without installed tools. No complete root check, production crash
reproduction, or desktop device acceptance is claimed.
