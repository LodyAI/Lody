# Sidebar project ordering

Status: draft
Translation: current

[中文](sidebar-project-ordering.zh.md)

When a workspace contains several GitHub repositories or local project folders,
the desktop sidebar lets the user reorder peers within their section by dragging
the row handle. Local projects remain grouped by their owning machine; dragging
does not move a project between machine sections.

The chosen order persists separately for each workspace. A local project's stored
identity includes both its machine id and project id. Projects that temporarily
disappear while a machine reconnects retain their saved position, and newly
discovered projects appear after the projects with an existing saved order.

Mobile keeps its existing non-drag layout.

## Implementation evidence

- [Sidebar state](../packages/components/src/atoms/sidebar-state.ts)
- [Sidebar rendering](../packages/components/src/components/loro-app-sidebar.tsx)
- [Workspace-scoping test](../packages/components/tests/sidebar-local-project-order.test.ts)
