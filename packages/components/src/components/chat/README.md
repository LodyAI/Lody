# components/chat

The new-chat landing and the reusable composer shell it renders. Binding rules
live in [AGENTS.md](AGENTS.md); this file is the directory index and the
reasoning behind those rules.

## Ownership

| Area                   | Owner                                                                                                                                                                                    | Responsibility                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Composer shell         | [`chat-composer.tsx`](chat-composer.tsx)                                                                                                                                                 | Prompt, attachment chips, status, selector slots, and actions.                                   |
| New-chat orchestration | [`chat-landing.tsx`](chat-landing.tsx)                                                                                                                                                   | Selector and draft state, mobile sheets, submission, and `ChatComposer` inputs.                  |
| Landing layout         | [`chat-landing-view.tsx`](chat-landing-view.tsx)                                                                                                                                         | Render-only layout around `ChatComposer`.                                                        |
| Derived selection      | [`chat-landing-derived.ts`](chat-landing-derived.ts)                                                                                                                                     | Pure landing selection state.                                                                    |
| Selector controls      | [`chat-landing-selectors.tsx`](chat-landing-selectors.tsx), [`unified-project-selector.tsx`](unified-project-selector.tsx)                                                               | Project and branch wrappers over shared selectors.                                               |
| Attachment menu        | [`attachment-add-menu.tsx`](attachment-add-menu.tsx)                                                                                                                                     | The single "+" menu and per-turn MCP selection.                                                  |
| Reference chips        | `comment-reference-*`, `visual-annotation-reference-*`                                                                                                                                   | State and rendering for outgoing references.                                                     |
| Host chrome            | [`context-switch.tsx`](context-switch.tsx), [`machine-pairing-dialog.tsx`](machine-pairing-dialog.tsx), [`web-chat-landing-screen.tsx`](web-chat-landing-screen.tsx)                     | Context controls and host-specific entry points.                                                 |
| Submission             | [`submission/`](submission/AGENTS.md)                                                                                                                                                    | Composer submission lifecycle and local rules.                                                   |
| Draft persistence      | [`../../atoms/local-storage-cache.ts`](../../atoms/local-storage-cache.ts), [`../../atoms/chat-landing-draft.ts`](../../atoms/chat-landing-draft.ts)                                     | Durable text and in-memory attachment state, scoped by workspace.                                |
| Attachment uploads     | [`../../hooks/use-chat-landing-image-draft.ts`](../../hooks/use-chat-landing-image-draft.ts), [`../../hooks/use-chat-landing-file-draft.ts`](../../hooks/use-chat-landing-file-draft.ts) | Image and file upload state, including Electron's local transport.                               |
| Held sends             | [`session-pending-messages.tsx`](session-pending-messages.tsx), [`session-pending-sends-host.tsx`](session-pending-sends-host.tsx)                                                       | In-memory sends awaiting attachments; pending cards reuse delivered layouts and cached previews. |

Attachment preparation and history publication share the final card layout;
see [attachment rendering](../ai-gui/session-files-rendering.md#upload-to-history-continuity).
`useSessionPendingMessages` separates ready accepted inputs into individually keyed
UI rows and leaves attachment preparation in the trailing slot. It retains local
bodies until matching formal history is hydrated; only real owner receipts mark
delivery. The wrapper component keeps the standalone pending-message surface.

## Home dashboard transitions

The Now summary and running session rows reuse the sidebar's
[`WorkingGrid`](../../ui/working-grid.tsx): a 12px grid centred in the existing
14px icon slot, with the shared animation and reduced-motion behavior. A zero
running count keeps a muted static grid, without the active accent colour.

[`home/home-dashboard.tsx`](home/home-dashboard.tsx) owns board selection, the summary
segments and their typed View Transition; [`home/home-dashboard-host.tsx`](home/home-dashboard-host.tsx)
supplies the live models and device-local preference. The landing stage in
[`web-chat-landing-screen.tsx`](web-chat-landing-screen.tsx) re-centres when board height changes.
The transition rules in [`../../tailwind/index.css`](../../tailwind/index.css) move the
segments, labels, fold control and pill with that same stage change. Snapshot stacking
is explicit: pill below segments, persistent labels above both. Changing summaries
cross-fade at natural size inside the segments' animated bounds, so their text never
scales or covers a neighbouring label. DOM z-index alone cannot order extracted snapshots.
The [owning note](../../../../../.agents/notes/implemented/feature/2026-10-16-home-week-tiles.md#transition-layering-correction-2026-10-18)
records the failure and browser verification.

[`home/week-bento.tsx`](home/week-bento.tsx) keeps each agent's icon beside its name and
session share, above its own meter, rather than collecting icons in the tile header.

The plan-usage Provider picker in [`home/tiles.tsx`](home/tiles.tsx) closes when a
Provider is selected, including the current selection. Its radio items explicitly
set `closeOnClick`; Base UI otherwise keeps radio menus open.

The stage also tells its group how tall it is: [`landing-stage.ts`](landing-stage.ts) provides
the stage and group elements, and `useLandingRoom` turns them into the height the dashboard may
take (the stage less the rest of the group, independent of the dashboard's own height). The
dashboard converts that to rows for `layoutHomeNow`, folds the "now" board when one row per list
does not fit, and `now-board.tsx` opens a whole list by growing the pressed tile over the board
while the rest steps back (`home/focus-motion.ts`). [Why](../../../../../.agents/notes/implemented/feature/2026-10-16-home-week-tiles.md#fitting-the-window-2026-10-18).

## Why the rules read the way they do

- **Composer measurement outside layout.** `chat-composer.tsx` uses
  `textarea-measurement.ts` to measure a hidden fixed textarea with resolved text
  and box metrics. The live textarea receives its final height once. Resetting
  the live height to `auto` temporarily expands the sibling conversation viewport
  and can clamp its reading offset even if the final height does not change.
  Empty drafts still skip measurement and use the minimum height.

- **MCP as a second menu level.** The workspace MCP catalog is multi-select and
  unbounded, so it cannot sit in the footer selector row. Desktop has hover and
  opens a submenu; touch does not, so mobile pushes the panel onto the same
  surface with a back row.
- **The 20-row picker cap.** The complete option set is unbounded; the cap keeps
  the menu mountable while search still ranks over everything. The project
  picker uses `DropdownMenuSearchInput` for mount-owned autofocus and to route
  typing back to search after pointer movement focuses a project row.
- **Project context material.** The selected project and its Private segment use
  the same raised tokens as the machine and worktree controls above the composer.
  [Decision](../../../../../.agents/notes/implemented/bug-fix/2026-09-27-project-context-pill-elevation.md).
- **Effective project access.** A project is only really shared when its machine
  is too, which is why the badge combines both bits instead of reading the raw
  project bit.
- **`onSelectionUrlSync` as replace.** With the URL mirroring composer steering, a
  sidebar project-row click is either an identical-URL no-op or an ordinary search
  change, never a history entry per keystroke.
- **Applying a "Recently used" row in two steps.** Setting the agent seeds that
  agent's per-agent defaults; writing model/options before `appliedTargetKey`
  names the new agent lets those defaults overwrite the row that was just applied.
- **Direct-authoring the accepted history entry.** The new conversation then
  renders the first message immediately, without waiting for room sync.
- **Workspace-scoped drafts.** The workspace slug scopes every part of a new-chat
  draft before the workspace id resolves. Every peer workspace window uses the
  same durable localStorage contract; its launch relationship and the selected
  project do not change draft ownership or lifetime. New-chat navigation selects
  a target but does not clear the draft; an accepted submit does.
- **Menu focus returning to the prompt.** Leaving focus on the model/agent trigger
  after Esc or an outside dismiss makes Enter re-open that menu.
- **The drop target living in `chat-landing-view.tsx`.** A session dragged from the
  sidebar writes a mention into the composer this layout renders, and nothing above
  it participates, so plumbing the handle up to `chat-landing.tsx` would buy
  nothing.

Chat Landing no longer emits the legacy onboarding project-source, project-selection,
or agent-selection events. Onboarding owns its route-scoped flow, step and operation
telemetry; see [event semantics](../../../../../specs/onboarding-analytics.md).

## New-conversation wallpaper

`web-chat-landing-screen.tsx` places the optional `WallpaperBackdrop` behind its
existing focus scope and composer. The decoration cannot receive pointer events;
its transparency, blur and vignette never filter text or controls. The full-height
alpha fade reaches zero at the bottom, preserving the docked composer's existing
surface. With an image selected, the outer composer dock is transparent so it
does not cut the remaining fade off at its top edge. The input plate keeps its
own fill and shadow; ordinary conversation docks remain opaque. Selection and local persistence belong to
[Appearance settings](../settings/README.md#wallpaper).
