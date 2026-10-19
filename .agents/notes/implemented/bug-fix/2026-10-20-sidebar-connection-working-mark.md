# Use the sidebar working mark for connection loading

Status: implemented
Translation: current

[中文](2026-10-20-sidebar-connection-working-mark.zh.md)

## Abstract

The sidebar connection pill used a rotating ring while session rows used the
sidebar's shared 3×3 working mark, making two active states look unrelated.
`ConnectionPill` now uses the same `WorkingGrid` at its existing 12px size and
keeps the pill's running tone and accessible label. The grid already belongs to
the sidebar and preserves its compositor-friendly animation; this change does
not extend it to other surfaces.

## Decision

- Use `WorkingGrid` for loading, reconnecting and syncing states in the sidebar
  connection pill, matching the mark used for active sidebar sessions.
- Keep the existing 12px footprint, badge tone, and `aria-label`; offline stays
  a static danger state without an icon.

## Verification

- `git diff --check` passed.
- `pnpm check`, `pnpm format` and `pnpm run docs check` could not complete because
  this nested worktree has no `node_modules`; required tools such as `tsgo` and
  `oxfmt` are unavailable. The documentation check also reported existing
  repository-wide status and `AGENTS.md` size findings.

## Pull request

- [PR #1738](https://github.com/LodyAI/Lody/pull/1738) (draft).
