# Preserve the Chat Landing draft across New Chat navigation

Status: implemented
Translation: current

[中文](2026-09-15-chat-landing-new-chat-draft-preservation.zh.md)

## Abstract

The local-project New Chat action treated an existing Chat Landing draft as disposable and cleared
it through a URL command, even though every other project entry reused the workspace-owned draft.
New Chat navigation now changes only the selected target and every Chat Landing entry within a
workspace reuses the same Composer content. The draft still clears after the first turn is accepted,
and different workspaces remain isolated.

## Problem

The sidebar had two paths to the same project landing. Clicking the project row navigated with only
the project selection and retained the draft, while clicking its New Chat button added a fresh
`resetDraftKey`. `chat-landing.tsx` interpreted that key as an instruction to replace persisted text,
pasted-text state and mention ranges with an empty value, and also released attachments and the
reserved Session id. Switching to an existing Session and returning through the New Chat button
therefore destroyed unsent input.

This behavior was separate from the workspace scoping introduced by
[the workspace-window draft fix](2026-09-11-workspace-window-composer-drafts.md): the storage key was
correct, but one navigation path explicitly erased the value stored under it.

## Decision

- A workspace has one Chat Landing draft, independent of which project is selected or which
  new-conversation entry point opened the landing.
- The local-project New Chat button reuses the ordinary project-landing navigation callback. There
  is no URL-level draft-reset command and no mount effect that can interpret navigation as a clear.
- Project selection remains route state and may change without changing draft ownership.
- A successful first-turn write remains the automatic release boundary. Explicit removal of an
  individual attachment remains available to the user.

Keeping a separate blank draft for each New Chat click was rejected because it conflicts with the
single visible Chat Landing Composer and makes unsent text unreachable. Keeping the reset command
only for attachments was also rejected: text, pasted content, mention ranges, attachments and the
reserved Session id form one submission draft and must not be split by navigation.

This refines the draft guarantee in the
[desktop window Spec](../../../../specs/desktop-windows.zh.md), which remains a draft pending human
review.

## Verification

The component draft suite proves that the workspace-owned prompt survives Landing unmount and Jotai
store recreation through durable storage. The route parser suite rejects the removed reset command,
so project selection and stale URLs cannot revive destructive behavior.

- `pnpm --filter @lody/components exec vitest run tests/chat-landing-draft-persistence.test.tsx tests/chat-landing-derived.test.ts tests/chat-landing-selection-url-sync.test.ts`
- `pnpm --filter @lody/components typecheck`
- `pnpm lint` (from the outer workspace)
- `pnpm run docs check`
