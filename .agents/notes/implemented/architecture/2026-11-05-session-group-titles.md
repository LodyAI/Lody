# Separate a conversation group's sidebar title from its first tab

Status: implemented
Translation: current

[中文](2026-11-05-session-group-titles.zh.md)

## Abstract

A root Session's `title` used to name both its sidebar row and its first tab, so
renaming either one renamed the other. The root meta now carries an independent
`groupTitle`/`groupTitleSource` for the sidebar, while every tab, root included,
keeps its own `title`. The first generated root title is copied into the group
title exactly once; afterwards the two titles change only through their own
renames. Sessions without `groupTitle` keep showing the root title, so no
migration runs and older clients that write only `title` still display.

## Decision

- `SessionMeta.groupTitle` exists only on root Sessions. Readers that name a whole
  conversation group (sidebar rows, command palette, Home, mobile lists, window
  title) use `getSessionGroupTitle`, which falls back to the root `title`. Tab
  strips, mentions and per-conversation surfaces keep reading `title`.
- Generated titles reach the group through `SessionDocument.setTitleIfSourceIn`
  and `resolveGeneratedGroupTitleUpdate`: copy when the group title is a draft, or
  when the group has no title and the root tab accepted the generated write. One
  meta upsert carries both fields. A group title that is already `generated` or
  `user` is never replaced automatically, so later agent-pushed titles rename
  only the tab.
- A user tab rename on a root with no group title first freezes the group at the
  root's current title and source (`buildSessionTabRenamePatch`). Without that
  freeze, the fallback would make the sidebar follow the tab again for existing
  Sessions.
- Sidebar rename writes only `groupTitle` (`buildSessionGroupRenamePatch`). MCP
  `lody_session_rename{,_many}` and `lody session rename` default to the tab and
  take `scope: 'group'` / `--group` for the sidebar; a child Session rejects the
  group scope.

## Alternatives

- Regenerating the group title as tabs are added was declined by the owner: the
  group name should stay stable once it is chosen.
- A one-time migration that writes `groupTitle` for every existing root was not
  used. It would open or touch every historical Session meta, and the read
  fallback plus the freeze on first rename produce the same visible result.

## Consequences

- An old desktop or daemon that predates this field renames only `title`. For a
  root with no group title, that still renames the sidebar row through the
  fallback, which matches the old behavior.
- If a user renames the root tab before the first title generation finishes, the
  group is frozen at the draft title with source `draft`, and the generated title
  still replaces it once.

## Verification

- `apps/cli/src/lib/loro/doc-title.test.ts`: copy once, draft group after an early
  tab rename, legacy user titles, child Sessions.
- `packages/components/tests/use-session-actions.test.ts`: tab and group renames
  stay independent on a real Loro repo.
- `apps/cli/src/mcp/lody-mcp-server.test.ts`: MCP tab and group scopes and the
  child rejection.
- Not verified: the desktop UI in a running app, and mixed-version replicas.
