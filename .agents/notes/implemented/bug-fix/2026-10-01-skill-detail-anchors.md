# Keep skill fragments in their detail document

Status: implemented
Translation: current

PR: [#1193](https://github.com/LodyAI/Lody/pull/1193)

[中文版](2026-10-01-skill-detail-anchors.zh.md)

## Abstract

Skill detail links to headings opened the host route in a new tab and lost the
detail, because the renderer treated fragments as external links and emitted no
heading ids. Details now opt into GitHub-style heading ids and handle fragment
navigation within their own body, including focus movement. Other Markdown
callers retain their existing behavior, and the skill source remains unchanged.
The fallback supports its rendered headings; full Markdown parsing and native
mobile focus behavior remain separate verification boundaries.

## Decision

The latest main inspected before implementation was
`7d502f3d99fdcdbbdd43d032c6d903d4ed497e04`. Searches of existing PRs for skills,
skill detail, anchors and B04 found no effective fix; the related merged dialog
width and settings design PRs did not supply heading navigation.
The final main recheck reached `93545f01b69cb0c98ddd3f19d46540decd95a007`;
the three relevant renderer/detail sources were unchanged, and no open PR
provided this fix.

The [detail body](../../../../packages/components/src/components/settings/skill-detail.tsx)
owns fragment lookup, URL decoding, scrolling and focus. It matches only headings
inside that body, avoiding global id lookup and CSS interpolation of untrusted
fragments. Invalid or missing destinations are consumed without route navigation.
The [renderer](../../../../packages/components/src/components/ai-gui/markdown-renderer.tsx)
opts into heading generation and ordinary fragment anchors only for details.
`github-slugger`, already locked transitively, is declared directly to preserve
Unicode and duplicate collision behavior rather than introducing a second slug
algorithm. The fallback uses the same slugger and rendered inline text.

Native browser fragment navigation was insufficient: the host router owns the URL,
and several mounted documents can contain the same heading. Applying anchor
behavior globally would also broaden this fix to conversation navigation.
The [draft contract](../../../../specs/skill-detail-navigation.md) owns the resulting
user-visible behavior. No skill catalog, scanning, dispatch, or source edits are
part of this decision.

## Verification

The owning regression suite exercises real detail rendering, an injected render
failure, encoded Chinese fragments, duplicate and nested headings, scoped lookup,
invalid targets, unchanged external links, and search/focus after dialog close.
Its scroll boundary is injected because jsdom does not lay out pages; Chromium
verification uses the synthetic `InternalAnchors` Skills story.

Replacing the three renderer/detail sources with their inspected main versions
made all three selected anchor regressions fail; restoring the fix passed all
nine tests. Chromium confirmed real body scrolling, heading focus, stable URL,
external new-tab behavior, and preserved query/opener focus after Escape.
`pnpm check` passed type checking and lint, then stopped at the unchanged
`boot-shell.test.tsx` storage-unavailable case (4,595 component tests passed,
one failed); that failure also reproduced in isolation. The separately run
Electron suite passed 199 tests. Formatting, i18n, import/platform/public-boundary
guards, and the documentation check passed.

Production account navigation,
native mobile sheets, Safari, and fallback syntax outside its existing subset are
not covered by this change.
