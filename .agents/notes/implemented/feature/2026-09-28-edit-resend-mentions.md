# Mentions in edit-and-resend

Status: implemented
Translation: current

[中文](2026-09-28-edit-resend-mentions.zh.md)

## Abstract

Editing the last user message previously used a bare `Textarea`, so `@` mentions,
`$` skills, and `/` commands — which the composer already supports — silently did
nothing inside the editor, and any mention text that was already in the sent
message lost its chips and expansion on resend. The inline editor now hosts the
same `CombinedMentionTextarea` as the composer, fed by one shared
`useSessionMentionSource` hook that also drives the composer's source resolution.
The save path runs the identical before-send expansion
(`useMentionPromptExpansion`) so a resent message carries the same rewritten
text and transcript spans a fresh send would.

## Decision and evidence

Two facts made the second composer worth sharing rather than duplicating: the
`mentionSource` precedence (Code Collab provider → local project → GitHub repo)
was hand-built inside `SessionChatInputArea`, and the before-send rewrite list
in `mention-expansion.ts` is the single point where `$skill`, `@session`, and
`@role` tokens become machine-readable text. Reusing both keeps the editor's
`@` resolve set identical to the composer's — a divergence would let the editor
offer files the resend could never expand.

`useSessionMentionSource` (new, in `hooks/`) owns the provider-vs-local-vs-GitHub
derivation; the composer passes `value.includes('@')` to lazily enable the file
index, while the editor passes `true` because it opens with the previous text
already loaded and must resolve its tokens on first paint.

The editor reports `{ text, mentions }` on save; `SessionChatStreamImpl` expands
through `useMentionPromptExpansion` (mounted once per stream, not per row) and
re-anchors spans after trim, so `handleEditLastUser` in
`session-chat-interface.tsx` receives the same expanded text + spans a normal
send produces and writes them onto the replacement text block. Surfaces without
a mention source (share page, tour) omit `editMentionContext` and the editor
degrades to a plain textarea.

The editor's menu uses `anchor="caret"` (new prop on `MentionTwoLevelMenu` /
`CombinedMentionTextarea`) instead of the composer's frame dock, because an
in-conversation editor's menu must track the caret like a text-completion
popup; the composer's `data-mention-frame` dock + `side="top"` stays the
default for the bottom composer. The same caller opts out of the <640px
`MentionMobilePanel` dock via `menuMobileDocked={false}` — that strip is
geometry-pinned "above the composer," which only exists for a bottom composer
on a keyboard; mid-conversation it renders off-screen, so the editor keeps the
floating caret popover on mobile too.

One shared-primitive fix surfaced by testing the new caller: `MentionInput`'s
menu-navigation keydown treated every `Enter` as a select — swallowing
Cmd/Ctrl+Enter (the owner's send/save) and Shift+Enter (a literal newline).
Both now bail before `preventDefault`, matching every other Enter modifier the
input already lets through.

## Verification

`pnpm --filter @lody/components typecheck` and oxlint on the touched files pass.
Storybook `AI GUI/UserMessageEditor` gained a `WithMentions` story seeded with a
GitHub mention source, two mentionable sessions, and stub commands; Playwright
against the running Storybook confirmed `@` opens the two-level menu
(Files/Issues/PRs/Skills/Sessions/Agent Commands), `/` opens the command menu
(whole-input only, matching the composer rule), the menu tracks the caret, and
the plain story shows no menu. Edge probing (caret tracking, Escape layering,
Cmd/Ctrl/Shift+Enter, trigger deletion, autosize cap, `/`-only-at-start, rapid
cycles, viewport resize, CSS zoom, `@`-in-mention, readOnly) surfaced and fixed
the modified-Enter swallow described above; the rest matched composer
semantics. Not yet validated end-to-end in the Electron app against a live
session.

## Edit availability correction (2026-10-06)

The mention-expansion wrapper accidentally supplied a callable `onEdit` to the
last user row even when the session owner omitted `onEditLastUser`. Unsupported
providers and other ineligible sessions therefore displayed an editor whose save
returned `false`. The stream now supplies the wrapper only when the owner supplies
the action, preserving the existing eligibility checks and mention expansion.
The first user message remains a deliberate exception to fork requirements: its
replacement uses `session/new`; later messages require an authoritative
`sessionFork` capability and a completed preceding assistant turn with an ACP ID.
This corrects callback propagation without changing edit-and-resend intent.

Correction validation: `git diff --check` passes. Typecheck, lint, and formatting
could not run because this worktree has no installed dependencies (`tsgo`,
`oxlint`, and `oxfmt` are unavailable). `pnpm run docs check` reports broken
links into absent ACP submodule files, outside this change. No runtime test was run.
