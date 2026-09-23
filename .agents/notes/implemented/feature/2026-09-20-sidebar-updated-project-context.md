# Updated sidebar rows show their project

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/838

[中文](2026-09-20-sidebar-updated-project-context.zh.md)

## Abstract

Updated organize mode is a recency firehose across every project, so a one-line
title no longer says where a Session lives. Top-level rows now add a second
line with the same identity mark the Project headers already use (folder,
GitHub owner avatar, or chat glyph) plus the project or section name. Nested
opened Sessions stay a single title line so the opened-by tree trunk still
meets the 30px row contract. Workspace-mode Pinned omits the line because those
rows still sit next to their project groups.

## Problem and decision

Project organize mode groups Sessions under a local folder, GitHub repo, or
Chats heading, so the group header already answers "which project?". Updated
mode drops that structure on purpose. The mixed list then showed only titles,
and a recently updated Session from another folder was indistinguishable from
one in the current project.

`SidebarUpdatedSessionList` accepts `showProjectContext`.
`LoroSidebar` turns it on for the Pinned section and the Updated bucket when
`organizeMode === 'updated'`. The second line uses `subtitle` when present
(local folder name, GitHub `owner/repo`) and falls back to `sectionLabel` for
chats. Nested children (`openedByTree.kind === 'child'`) skip the line: they
inherit the opener's project visually through nesting.

The title line keeps the existing 20px content height so disclosure, connector,
and end-slot geometry stay on that line. Title and project sit 4px apart, and
two-line rows use `py-1.5` so the pair is not flush against the highlight.
A first child under a two-line opener stretches its upward trunk (`-top-7`
instead of `-top-2`) to close the extra subtitle gap. Later siblings keep the
one-line trunk.

A nested "Show project" checkbox under Updated was tried and dropped: the extra
control made the filter noisier without changing the default, which is to show
the project line whenever Updated is selected.

The later [display-preference decision](2026-09-20-sidebar-updated-project-display-preference.md)
reintroduces that control with revised wording and muted avatar treatment after
the product requirement changed.

## Alternatives and trade-offs

Putting project identity in the hover card was already true and is not enough:
Updated is a scanning list, and hover is desktop-only. Showing the line on
Workspace-mode Pinned would also label mixed rows, but those rows still live
above project groups in the same sidebar, and the request was scoped to
Updated. Showing the line on nested children would make the tree dash because
the trunk lengths encode a 30px row.

## Verification

`sidebar-updated-project-context.test.tsx` covers local/GitHub/chat marks,
the Workspace default (no line), and nested children omitting the line.
`loro-sidebar-pinned-section.test.tsx` checks that Updated-mode Pinned shows
the line and Workspace-mode Pinned does not. Existing opened-by suites still
cover disclosure and connectors.

Related: [sidebar session tree](../../../docs/components-sidebar-session-tree.md).
