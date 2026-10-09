# Editing imported memory profiles

Status: implemented
Translation: current

[中文](2026-10-05-memory-provider-profile-editing.zh.md)

## Abstract

Local-only name edits left the imported identity different from its provider profile.
At the user's request, the edit form now updates Nowledge Mem through its adapter
and then saves the returned display metadata in Lody. Identity IDs stay fixed;
name, description and role use the same fields as creation. Provider failure
prevents a local success, but provider success followed by local-write failure
cannot be rolled back atomically and is reported as a save error.

## Decision and evidence

This replaces the edit-only-local decision in the
[association catalog note](2026-10-05-memory-association-catalog.md).
Deletion still removes only the Lody import. The draft
[Spec](../../../../specs/agent-role-memory.md) describes the current behavior.

The typed update request uses the exact machine/provider routing.
The daemon runs nmem agents set with literal arguments; empty editable values
clear their fields. Hidden Space and provenance fields are omitted and preserved.
The editor hydrates once from inventory, so refresh does not overwrite user input.
Only a successful updated inventory is copied to the existing Flock row.

Machine tabs reuse Agents' online dots, prefer the local machine, and list its tab
first. Memory rows place the grayscale logo before the text, vertically centered.
Component and CLI typechecks passed. Tests were not run at the user's request.
Implementation: [PR #1246](https://github.com/LodyAI/Lody/pull/1246).
