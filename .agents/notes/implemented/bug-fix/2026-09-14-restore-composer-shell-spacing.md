# Restore composer shell bottom spacing

Status: implemented
Translation: current

[中文](2026-09-14-restore-composer-shell-spacing.zh.md)

## Abstract

PR #655 moved the desktop session composer's 8px bottom spacing from the shared shell into the
clickable composer card so the strip could focus the prompt. Its follow-up class merge also made
the session shell's original `pb` disappear, leaving landing and in-session composers with
different spacing ownership. The spacing is restored to the shared shell, while blank shell
clicks now focus the prompt directly so the editing-focus behavior remains available.

## Decision

- Keep the shared shell's `pb-[calc(...)]` for both landing and in-session composers.
- Keep the session card at its original `py-1.5`; do not duplicate the desktop bottom space inside
  the card.
- Focus the prompt only when a primary mouse press lands on the shell itself, canceling the
  browser's default mousedown focus handling first so selectors, attachments, and prompt
  interactions retain their existing targets.

## Evidence

- The regression came from `b5746d02` / PR #655, which added both the card `pb-3.5` and the
  desktop-only shell `pb-[max(...)]`; `tailwind-merge` discarded the shared shell padding.
- The existing composer focus browser journey covers clicking the shell's bottom area and typing
  afterward.

## Verification

- `git diff --check` passes.
- The existing `composer-submission-focus` browser journey is the intended regression
  coverage for clicking the restored shell bottom area and typing afterward.
- Automated pnpm checks were attempted but could not start: even `pnpm --version` hung in this
  worktree, so typecheck, Vitest, Prettier, and `pnpm run docs check` remain unexecuted.
