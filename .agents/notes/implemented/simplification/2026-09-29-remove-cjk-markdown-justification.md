# Remove CJK paragraph justification from conversation Markdown

Status: implemented
Translation: current

[中文](2026-09-29-remove-cjk-markdown-justification.zh.md)

## Abstract

Justifying any conversation paragraph that contained a Han character stretched
spacing in mixed Chinese and English replies. Conversation prose now stays
start-aligned during streaming and after completion, preserving one stable
alignment as text arrives. This gives up flush right edges for Chinese paragraphs
in exchange for consistent spacing in chat. The earlier rationale is preserved
in the [CJK justification decision](../feature/2026-09-28-cjk-markdown-justification.md).

## Decision

The user-facing conversation is a live, mixed-script reading surface rather than
a fixed-width publication page. Native start alignment avoids stretching
characters and English word spaces to fill each line, and does not require a
second layout pass when Streamdown hands a completed reply to the static renderer.
The renderer no longer detects Han characters for alignment; the shared style
explicitly aligns top-level paragraphs to the start edge.

The old renderer test asserted only that a Han-bearing paragraph received an
implementation-specific class. It did not observe rendered alignment, so that
stale assertion was removed with the class detection.

## Verification and limits

- The alignment Spec is [conversation Markdown alignment](../../../../specs/conversation-markdown-alignment.md).
- `git diff --check` passes. `pnpm run docs check` reports no errors for these files but exits 1 on 62 unrelated broken links to absent isolated package workspaces.
- Local `pnpm check` and `pnpm format` cannot run because this checkout has no `node_modules` (`tsgo` and `oxfmt` are unavailable). The first PR CI run found only the obsolete class assertion; after its removal, the follow-up CI passed all component shards, static checks, browser tests, and desktop smoke E2E.
