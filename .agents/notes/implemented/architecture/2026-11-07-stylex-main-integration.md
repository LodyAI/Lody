# StyleX migration: main integration

Status: implemented
Translation: current

[中文](2026-11-07-stylex-main-integration.zh.md)

## Abstract

The integration retains upstream product behavior and local StyleX ownership. Verification uses the dependency versions and patches selected by main, so stale declarations do not masquerade as merge regressions.

## Decision

Integrate main through `e5109b47cb293ccaed3b0f42b37724870bd66bbe` into migration
head `f5d2890144aaf3b08d23227c8d3e5212de913fe4` in an isolated worktree. Preserve
upstream billing recovery, sidebar branch metadata and local attachment behavior
alongside local StyleX ownership; a conflict-free textual merge alone is insufficient.
Local-attachment glyphs use local StyleX sizing, and Motion retains main's pinned upgrade.

| Area         | Retained contract                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Mobile       | Full-page new chat, fold panels, native keyboard insets, edge gestures and settings navigation.                                            |
| Conversation | Quote insertion/undo, prompt suggestions, archived-session restore, share/export capability gates and lower fold layout.                   |
| Side panel   | Split/unsplit drag intent, grouped tabs, keyboard selection and Android preview lifecycle.                                                 |
| Queue        | Shared line/gutter geometry, inset tiles, roomy/airy/touch layouts, pending and scheduled row behavior.                                    |
| Styling      | No Tailwind compiler or declaration bridge; main's newly introduced utility consumers become local StyleX and typed owner props.           |
| Tests        | Preserve main's removal of shallow class/source assertions while retaining real input, ref, popup, keyboard and state-transition coverage. |

`ScrollArea.contentFullHeight` styles its owned Content part directly for full-height
fold layouts. It adds no wrapper and avoids passing a raw descendant namespace
through `StyleXStyles`. Existing InlinePicker and fold-panel owners compose their
new layout constraints in the same `stylex.props` call.

The run-configuration drawer retains its native fold-aware height capped by the
keyboard-available viewport. Component-only typechecking does not cover all renderer
constraints: Electron's consuming configuration also checks unused declarations.
Recovery-status tests assert the complete visible interval and then invisibility;
they permit Motion to remove an exited subtree instead of requiring a retained node.

## Dependency and verification boundary

The merged lockfile is regenerated with pnpm 10.20.0 in a manifest-only temporary
workspace and checked offline with `--frozen-lockfile`. That workspace uses the
exact gitlink manifests, including read-only manifests where local objects are
missing. No submodule checkout or source is modified to resolve the UI conflicts.

UI verification uses isolated module links and the versions/patches already
selected by main. In particular, quote converters share the HAST type override,
the streams package includes main's snapshot-recovery patch, and a temporary copy
of the pinned ACP core is built against its locked SDK. This avoids changing
product code to satisfy stale local declarations.

Production Storybook and real browser checks cover representative merged UI.
They do not close historical visual OPEN items or certify every runtime/cloud
branch. The existing [migration](2026-10-22-tailwind-to-stylex-migration.md) and
[design-system](2026-11-07-design-system-convergence.md) evidence retains its original
scope. The user's working tree and its 112 pre-existing dirty paths remain outside
this integration worktree.
