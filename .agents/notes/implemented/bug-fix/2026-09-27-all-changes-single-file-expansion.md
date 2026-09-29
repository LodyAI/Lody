# Focused diffs open the selected file only

Status: implemented
Translation: current

[中文](2026-09-27-all-changes-single-file-expansion.zh.md)

## Abstract

Opening one file from the Changes list or a conversation turn rendered every
diff card expanded, forcing the user to scan unrelated files before reaching the
selected file. Diff panels now use the focused workspace path as their initial
open state in both base (All Changes) and turn modes: the selected card opens and
other cards stay collapsed. A base panel opened without a focus starts fully
collapsed; a direct turn diff without a file focus keeps its all-files-open
default. The Changes Types list also shows each file's parent workspace path so
same-named files remain distinguishable. Users can still expand any collapsed
card.

## Decision and evidence

- `SessionConversationDiffPanel` already carried `focusFilePath` when a file row
  was selected, but `DiffFileBlock` passed `defaultOpen` to every `DiffViewer`.
  That made the focus useful for loading and scroll targeting but not for the
  visible card state. The first fix applied the policy only to base mode, leaving
  focused turn diffs expanded; the policy now covers both modes.
- `shouldOpenDiffFileByDefault` applies the distinction at the panel boundary and
  reuses path-equivalence matching, so `./src/file.ts` and `src/file.ts` select
  the same card.
- The Changes Types row keeps the basename as the primary label and renders the
  parent path as a secondary line, while preserving the complete path in the
  row's title for assistive or hover inspection.
- The per-card `DiffViewer` key includes the base/conversation mode and open
  state. When focus moves to another file in the existing diff tab, the previous
  card is remounted closed and the new target is remounted open; ordinary
  collapse/expand clicks remain local to each card.

No diff data loading or file selection contracts changed.

## Validation

The focused panel-policy suite passes all 9 tests and covers focused base and
conversation modes, unfocused defaults, and equivalent path spellings. Component
`tsgo --noEmit`, Oxfmt, Oxlint, and `git diff --check` passed; the typecheck and
focused test ran with the required ACP submodules temporarily initialized and
built, then the checkout was returned to its original deinitialized state. The
direct docs check was attempted but remains blocked by pre-existing links into
uninitialized ACP submodules. The full repository suite and desktop runtime were
not run.
