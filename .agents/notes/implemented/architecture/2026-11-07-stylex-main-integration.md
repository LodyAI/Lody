# StyleX migration: main integration

Status: implemented
Translation: current

[中文](2026-11-07-stylex-main-integration.zh.md)

## Abstract

The integration retains upstream product behavior and local StyleX ownership. Verification uses the dependency versions and patches selected by main, so stale declarations do not masquerade as merge regressions.

## Decision

Integrate main `6cc2de53c529733cbd50ef6658a7b9692acd1b55` into migration head
`f5d2890144aaf3b08d23227c8d3e5212de913fe4`. Resolve the 133 conflicting paths
in an isolated worktree, then retain the two import unions needed by the subsequent main update. The new local-attachment action glyphs use local StyleX sizing; Motion retains main's pinned dependency upgrade. Preserve main's product behavior and the migration's
local StyleX ownership; a conflict-free textual merge alone is insufficient.

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
