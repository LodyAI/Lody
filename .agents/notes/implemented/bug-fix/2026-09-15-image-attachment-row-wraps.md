# An image attachment group wraps instead of standing in two columns

Status: implemented
Translation: current

[中文](2026-09-15-image-attachment-row-wraps.zh.md)

## Abstract

A turn that attached many images rendered them in a hard `grid-cols-2`, and because every
thumbnail is a fixed square the group became a two-wide tower: an agent that uploaded thirteen
screenshots produced seven rows roughly 200px wide inside a 46rem conversation column, pushing its
own answer a screen and a half down. The grid is replaced by one wrapping row that fills the width
the column actually has, so the same thirteen thumbnails take three lines and the text stays in
view. Thumbnail size, cover cropping, and the preview gallery are unchanged; only the number of
tiles per line now follows the container.

## Decision

- `IMAGE_ATTACHMENT_ROW_CLASS` (`flex w-full flex-wrap gap-2`) is the single layout for a group of
  image attachments, used by `ImageGroupBubble` (agent and user) and by the user row's grouped
  `image` items. Never reintroduce a fixed column count: the tile is fixed, the container is not.
- Alignment stays with the speaker — `justify-start` for the agent's left rail, `justify-end` for
  the user's attachments — so a short group still reads as that speaker's, and only the last line
  of a long group is ragged.
- The thumbnail frame carries `shrink-0`. Flex items shrink before they wrap, and without it the
  tile that overflows a line squeezes into a non-square instead of moving down.
- The former `max-w-[26rem]` / `max-w-[32rem]` caps are dropped rather than widened. They never
  bound anything: the grid shrink-wrapped to two fixed tiles, so the cap was dead code that read
  like an intentional measure.

## Evidence

- The report was a desktop turn with thirteen agent-uploaded screenshots; the block occupied about
  a quarter of the column width and scrolled for several screens.
- Rendering the component with thirteen images at a 46rem column (a throwaway Vite page driven by
  Playwright, light and dark) shows 6 tiles per line for the agent's compact thumbnails and 4 for
  the user's large ones, against 2 before.

## Verification

- `pnpm --filter @lody/components typecheck` passes (after `pnpm --filter lody
  prepare:acp-adapters`, which the workspace needs for the ACP submodule types).
- `pnpm lint:fast` reports no errors; Prettier ran on both changed files.
- `ImageGroupBubble.stories.tsx` gains the thirteen-image agent and user cases. Its fetch mock also
  had to be repaired: the pattern expected `/api/session-images/…`, but
  `getSessionImageDownloadApiPath` emits `/api/workspaces/<id>/session-images/…`, so every story
  image had been rendering as "Failed to fetch".
- Not covered by an automated test: the layout is CSS-only and jsdom computes no styles, so a
  wrap assertion in Vitest would only re-read the class string.
