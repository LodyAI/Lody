# Pinned conversation sections and ordering

Status: draft
Translation: current

[中文](pinned-session-sections.zh.md)

## Scenario

A workspace keeps some long-lived routine conversations, such as the scheduled
conversation that checks a mirror for updates every week. Once pinned, they mix
with every other pinned conversation and keep changing places by recent
activity. The user wants to choose the order of pinned conversations and to
place them in named pin sections, such as "Maintenance".

## Behavior

- The sidebar pin area has one default "Pinned" section followed by any number
  of user sections. The default section stays first and cannot be renamed,
  deleted or dragged; while it is empty and user sections exist, it is not
  shown. A newly pinned conversation enters the top of the default section.
- The user can create, rename and delete sections, and drag a section header to
  reorder sections. Every section header's menu offers "New section…", which
  creates an empty section; user sections also offer rename and delete.
- Pinned conversations are picked up with the pointer: a grabbing cursor and a
  lifted copy follow it, and dropping one on a conversation or the new-chat
  composer still mentions it there. Released outside the pin area, it flies back.
- While a conversation is dragged over a section, the rows at the drop position
  slide apart to open a slot of its height, and its own slot closes; the drop
  lands exactly in that slot: the row travels from where it was released into
  the slot in about 100 ms, with no jump in position or background, and hover
  stays off until the pointer moves.
- The user can drag a pinned conversation to reorder it within a section or to
  move it to another section; dropping on a section header places it at the
  top. Dropping an unpinned conversation into the pin area pins it there. The
  context menu also offers "Move to section", which places the conversation at
  the top of that section, and "New section…".
- On the desktop, a user section's header menu offers "New Chat in This Section". It
  opens the new-chat page, which names the section beside the project pills and
  keeps the project already chosen there. The conversation started from it is
  pinned at the top of that section; unchecking the section starts it unpinned.
  If the section is deleted meanwhile, the conversation lands in the default
  section.
- Deleting a section does not unpin its conversations; they return to the
  default section.
- Unpinning clears the conversation's section (`pinSectionId`) while retaining
  its `orderKey` so manual ordering in the Status view is preserved. Pinning it
  again places it at the top of the default section with a fresh `orderKey`.
- Each section can be collapsed. The collapsed state is stored only on this
  device.
- The Pinned header's "Visible Sections" menu lists every section, including the
  default one. Checked sections are shown. Toggling any checkbox keeps the menu
  open. If the default section is hidden, its list disappears and the Pinned
  header keeps the menu available. Visibility is stored on this device. Moving
  a conversation to a hidden section with "Move to section" shows that section.
- A view scope that hides a section's conversations leaves the section in
  place; while expanded, it names the hidden row count under its rows.
- Opener child conversations stay under their root conversation and move with
  it; they are not ordered independently.
- On phones the behavior is the same on the phone WebView and the native iOS and
  Android clients ([phone note](../.agents/notes/implemented/architecture/2026-11-21-status-view-on-phones.md)): a long
  press that turns into a drag reorders pinned conversations and moves them
  between sections, dropping an unpinned conversation into the pin area pins it,
  the row menu offers "Move to section" and "Move to top", and each section
  header's menu offers New section, Rename, Move up, Move down and Delete.

## Data ownership

Sections and order have the same visibility as `isPinned`: they sync to every
device, and workspace members see the same pin layout.

- **Section definitions** live in a new workspace Flock row family,
  `['pinSection', sectionId]`, with the value `{ name, orderKey }`. A section is
  one row. Renaming or dragging it writes only that row, and deleting a section
  deletes the row.
- **Conversation positions** live in session metadata (meta Flock) beside
  `isPinned`, as two new optional fields: `pinSectionId` and `orderKey`.
  Dragging a conversation writes only that conversation's metadata.
- A conversation whose `pinSectionId` is missing or names a section that no
  longer exists is shown in the default section. Until the section rows have been
  read, a conversation that names a section is not shown at all, so it never
  appears in the default section first and then jumps into its own. Deleting a section never
  rewrites conversations in bulk.

No room or document type is added. The workspace Flock already syncs as
protected content in encrypted workspaces.

## Ordering

Sections and conversations are ordered by fractional index strings, using
Loro's TypeScript implementation `@loro-dev/fractional-index`, which is
byte-compatible with the Rust `loro_fractional_index` crate. The package is not
yet published to npm, so it is vendored unchanged into `packages/shared` under
its MIT license, recording upstream commit `8932e46ef197`, and replaced by a normal
dependency once published. Each move generates one new key, between the moved item's new
neighbours, with random jitter, so that two devices inserting at the same
position do not produce the same key. Equal keys are ordered by id, so every
client shows the same order.

Pinned conversations without a `orderKey`, including those pinned before
this feature, sort after the keyed conversations in their section and keep
their recent-activity order among themselves. There is no migration.

## Compatibility

- Only optional fields and one row family are added. No existing field changes
  format.
- Older clients ignore the unknown `pinSection` rows when parsing the workspace
  Flock and keep showing all pinned conversations as one list ordered by time.
- Unpinning on an older client leaves `pinSectionId` and `orderKey` in
  place. Newer clients read those fields only while `isPinned` is true, so the
  stale values are harmless. Pinning again on a newer client places the
  conversation back in the default section.

## Out of scope

- Placing each run of a scheduled task into a section automatically. Routine
  tasks that need a fixed place use a destination that reuses one conversation
  (`own_session` or `existing_session`) and are pinned once.
- Private, per-member pin layouts.
- Encrypted workspaces on the native iOS and Android clients, which do not open
  encrypted workspaces at all yet. The phone WebView supports them.

## Permissions

Every member with workspace write permission can create, rename, delete and
drag sections, including in encrypted workspaces; read-only members can only
view them and are not offered section management. Members already write the workspace Flock, for example when creating
a private Agent Role. A write path that rejects a `pinSection` row from a
member with write permission is a gap to fix, not a reason to narrow section
management further.

## Evidence

Implementation:

- Layout and move planning: `packages/shared/src/pinned-sections.ts`; vendored
  ordering library: `packages/shared/src/vendor/loro-fractional-index.ts`
- `pinSection` rows and unknown-family handling: `packages/shared/src/workspace-flock.ts`
- Session fields: `packages/shared/src/schema.ts`; pin writes:
  `packages/components/src/hooks/use-session-actions.ts`
- Catalog snapshot and writes: `packages/components/src/lib/workspace-catalog-room.ts`,
  `packages/components/src/lib/workspace-catalog-write.ts`
- Pointer drag and mention delivery: `packages/components/src/components/pinned-rows-dnd.ts`,
  `packages/components/src/lib/pinned-drop-settle.ts`, `packages/components/src/lib/session-mention-drag.ts`
- Sidebar: `packages/components/src/components/sidebar-pinned-sections.tsx`,
  `sidebar-updated-session-list.tsx`, `loro-app-sidebar.tsx`; new chat in a section:
  the chat route's `pinSection` search, `components/chat/pin-section-target-pill.tsx`,
  `lib/session-submission.ts`; mobile:
  `packages/components/src/components/mobile/mobile-chat-list.tsx`
- Protected content selection: `packages/shared/src/workspace-streams-content.ts`
- Scheduled task destinations: `packages/shared/src/schedule-types.ts`

Executed validation (unit and jsdom tests, not a running app):
`packages/shared/tests/pinned-sections.test.ts`, `packages/shared/tests/workspace-flock.test.ts`,
`packages/components/tests/workspace-catalog-write.test.ts`,
`packages/components/tests/loro-sidebar-pinned-section.test.tsx`,
`packages/components/tests/sidebar-navigation-model.test.ts`,
`packages/components/tests/mobile-chat-list-preview-cap.test.tsx`,
`packages/shared/tests/status-view.test.ts`. Storybook end-to-end
(`packages/components/tests/e2e/sidebar-status-focus-drop.spec.ts`): a row moved
into another section and a section reordered by dragging its header. A non-owner
Member sealing a `pinSection` row is tested at the encrypted room level
(`apps/electron/src/main/services/e2ee-runtime.test.mjs`); the hosted gateway's
admission is not exercised. Phones: see the [phone note](../.agents/notes/implemented/architecture/2026-11-21-status-view-on-phones.md#verification).
