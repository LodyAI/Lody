# Local projects use the bounded session preview

Status: implemented
Translation: current

[中文](2026-09-17-local-project-session-preview.zh.md)

## Abstract

Workspace mode already limited GitHub worktree groups to five recent top-level
Sessions, but an expanded local project rendered its complete history and could
dominate the sidebar. Local projects now use the same five-root preview and
Show all/Show less interaction, including the rule that Sessions opened by a
visible root stay attached to it. The render and keyboard-navigation projections
share the expansion state, while collapsing a project returns it to the compact
preview for its next expansion.

## Problem and decision

The sidebar has two project-shaped session groups: GitHub repositories whose
Sessions run in worktrees, and folders registered as local projects. Only the
first used `MAX_VISIBLE_SESSIONS`, so the amount of history shown depended on
the project's storage model rather than the user's browsing task. A local
folder with a long history therefore pushed other projects below the fold even
though the equivalent repository group stayed compact.

`LocalProjectItem` now applies the existing top-level-root cap to its
opened-by tree and renders the same localized Show all/Show less control. The
cap is deliberately measured in roots, not rendered rows: an MCP-opened Session
remains directly below its opener instead of being cut away at an arbitrary
row boundary. The control's state reuses `sidebarShowFullListAtom`, with a
`local-project:<machine>:<project>` key so a local identity cannot collide with
a repository full name.

The keyboard-navigation model receives the same expansion bit and cap. This is
required even though ordinary focus navigation follows DOM rows: global
previous/next Session commands read the flattened navigation model and must not
visit history hidden by the preview. Collapsing a local project clears its
expanded bit, matching the existing repository-group behavior and preventing
an old Show all choice from unexpectedly restoring a long list later.

## Alternatives and trade-offs

Keeping independent local-project state inside each row would reduce parent
props, but the keyboard model would then have a second state source and could
drift from the rendered list. Reusing raw `machineId:localProjectId` keys was
also rejected because the same atom stores repository keys; an explicit
namespace makes the two domains disjoint. The Show all count remains the total
Session count, matching the established GitHub control, while the visibility
threshold remains a top-level-root count.

## Verification

`sidebar-local-project-row.test.tsx` covers the five-row preview, the namespaced
toggle, and the expanded seven-row result. `sidebar-navigation-model.test.ts`
covers the same compact and expanded projections, including its Show more
navigation item. Existing opened-by suites continue to cover root/child
attachment and collapsed-opener behavior.

Related: [sidebar session tree](../../../docs/components-sidebar-session-tree.md),
[issue #130](https://github.com/LodyAI/Lody/issues/130).
