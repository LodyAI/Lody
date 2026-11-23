# Sidebar search entry

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/598

[中文](2026-09-11-sidebar-search.zh.md)

## Abstract

The command palette needs a visible sidebar entry for users who do not use Cmd K.
Search now appears immediately below New Chat and opens the existing palette
through its shared state. Reusing the navigation row and translation keeps this
entry consistent with the sidebar; search behavior stays owned by the palette.

## Decision and evidence

The [sidebar](../../../../packages/components/src/components/loro-sidebar.tsx)
sets the existing palette state to open, making repeated activation idempotent.
It adds no route or synthetic keyboard event. The
[Spec](../../../../specs/sidebar-search.md) records the requested placement and
behavior. Validation results and any environment limits are recorded in the PR.
