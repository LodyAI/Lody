# All Changes opens the selected file only

Status: implemented
Translation: current

[中文](2026-09-27-all-changes-single-file-expansion.zh.md)

## Abstract

Opening one file from the All Changes list rendered every changed-file diff card
expanded, forcing the user to scan unrelated files before reaching the selected
file. Base diff panels now use the focused workspace path as their initial open
state: the selected card opens, other cards stay collapsed, and an unfocused
base panel starts fully collapsed. Conversation and turn-scoped diffs retain their
existing all-files-open behavior; users can still expand any collapsed base card.

## Decision and evidence

- `SessionConversationDiffPanel` already carried `focusFilePath` when a row was
  selected, but `DiffFileBlock` passed `defaultOpen` to every `DiffViewer`. That
  made the focus useful for loading and scroll targeting but not for the visible
  card state.
- `shouldOpenDiffFileByDefault` applies the distinction at the panel boundary and
  reuses path-equivalence matching, so `./src/file.ts` and `src/file.ts` select
  the same card.
- The per-card `DiffViewer` key includes the base/conversation mode and open
  state. When focus moves to another file in the existing diff tab, the previous
  card is remounted closed and the new target is remounted open; ordinary
  collapse/expand clicks remain local to each card.

No diff data loading or file selection contracts changed.

## Validation

The focused panel-policy suite passes all 9 tests and covers base mode with and
without focus, conversation mode, and equivalent path spellings. Component
typechecking, Oxfmt, Oxlint, `git diff --check`, and `pnpm run docs check` pass.
The full repository suite and desktop runtime were not run.
