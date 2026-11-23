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

- `pnpm format` passed. `pnpm run docs check` passed with repository-wide
  warnings about older notes without translations and `AGENTS.md` size.
- `pnpm check` passed typecheck, lint and Effect lint. Its `test:ci` phase failed
  on unrelated five-second UI test timeouts and CLI tests. The focused
  `workspace-identity.test.tsx` suite passed all 9 tests, including assertions
  for the shared mark in syncing state and its absence offline.
- `git diff --check` passed.

## Pull request

- [PR #1738](https://github.com/LodyAI/Lody/pull/1738) (draft).
