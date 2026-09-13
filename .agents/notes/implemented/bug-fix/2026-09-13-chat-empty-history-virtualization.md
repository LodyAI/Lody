# Keep empty history outside the conversation virtualizer

Status: implemented
Translation: current

[中文](2026-09-13-chat-empty-history-virtualization.zh.md)

## Abstract

A conversation could lose its first visible user message after loading history,
while still showing the agent reply. Static sharing made `leadingContent` always
non-null, allowing empty history to mount Virtua with a zero-height placeholder.
The first real user row inherited that index's zero-height cache and could be
excluded from rendering indefinitely. Empty history now renders outside Virtua,
with leading content preserved, and virtual row construction excludes placeholders.

## Cause and decision

In #646 (`0e372f0b`), a Fragment containing provenance and share requests replaced
nullable provenance. The existing empty-history early return required null leading
content, so ordinary empty conversations now produced two virtual rows with height
zero: the leading container and the empty placeholder. Hydrating a user message
and an agent reply reused the placeholder's cached height for the user row.
Virtua 0.49.1's offset search selected the later reply at the same offset, leaving
no user DOM to remeasure. A mounted React key does not invalidate the index cache.

A Chromium probe using React 19.2.0, Virtua 0.49.1, the production sticky-scroll
hook, and synthetic messages reproduced `[0, 0, 200]` at scroll offset zero with
no user DOM. Remounting after hydration produced `[0, 100, 200]` and restored it.
An initially populated history and hydration with only one user row did not fail.

`view.tsx` now treats empty history as a separate presentation regardless of leading
content. Provenance/share content remains visible in that presentation; the actual
virtualizer starts with real messages. `buildChatVirtualRows` omits the empty
sentinel, also keeping sticky-scroll counts aligned with real rows. No persisted
history, dispatch behavior, or sharing authority changes.

Removing sharing or forcing top scrolling would not repair the underlying cache
lifecycle. A virtualizer remount keyed to message count would reset scroll and
measurements on every append; the empty-history boundary is the narrower fix.

## Verification

`SessionChatHydration.stories.tsx` renders the production message list with an
explicit history-load action. The browser regression in
`tests/e2e/session-chat-hydration.spec.ts` waits for native empty-row measurement
on the old path before loading the user and agent together, then checks visibility
and ordering at the top. It also covers visible leading content before and after
hydration. The unmodified renderer fails specifically at the missing first-user
visibility assertion; the fixed renderer passes both leading-content variants.
Fixtures contain only synthetic messages; this is a component/browser
regression rather than a full workspace/transport E2E reproduction.
