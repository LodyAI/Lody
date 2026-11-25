# Today

Experimental daily outline notes ([Spec](../../../../../specs/today-outline.md)).

| File                                                          | Role                                                                                                                        |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `today-page.tsx`                                              | Full-page route surface                                                                                                     |
| `today-pinned-column.tsx`, `use-open-today.ts`                | Column pinned beside the sidebar; `use-open-today.ts` opens a day in it or as the page                                      |
| `today-window.tsx`                                            | Desktop standalone Today window (route `$workspaceName/today-window`): pin keeps it on top                                  |
| `today-view.tsx`                                              | Day stream shell: calendar, member menu, surface, picker, drag layer; window-top toolbar                                    |
| `today-day-section.tsx`                                       | One day: lazy page store, rows with inline mentions, to-do checkboxes; 200+ visible rows are virtualized                    |
| `today-breadcrumb.tsx`                                        | Focus view breadcrumb ("Today › date › ancestors"); the view and its node menu live in `today-view.tsx`                     |
| `today-selection-bar.tsx`                                     | Floating actions of a block selection (to-do step, Convert to task, Copy, Delete); a bullet click selects, so also its menu |
| `outline.stylex.ts`                                           | Outline geometry shared by rows and the surface (the fold toggle's overhang)                                                |
| `today-command.tsx`                                           | "Open Today" command placeholder, listed only while the experiment is on                                                    |
| `today-stream.ts`                                             | Which days show, local date and midnight math                                                                               |
| `today-session-mention.tsx`, `today-session-status.ts`        | Inline conversation and member mentions; a conversation's sidebar-derived status                                            |
| `today-mention-picker.tsx`, `today-members.ts`                | The `@` picker (All / People / Conversations) and the workspace members it and member mentions read                         |
| `today-mention-status-menu.tsx`                               | Status menu a mention's icon opens (`useSessionActions`)                                                                    |
| `today-dnd.ts`                                                | Drop projection for node and sidebar drags                                                                                  |
| `today-convert-dialog.tsx`, `today-convert-dialog-header.tsx` | Convert to task: the new-conversation surface in the landing's dialog layout, under a breadcrumb header                     |
| `editor/`                                                     | Single Lexical editor, rich LoroText binding, outline and mention keys, mention decorators, block selection, caret geometry |

Data model and undo: `packages/shared/src/today-outline.ts` (a mention is one marked U+FFFC;
[decision](../../../../../.agents/notes/implemented/architecture/2026-11-20-today-inline-mentions.md)); identity and links:
`packages/shared/src/today-types.ts`, `packages/shared/src/session-link.ts`; page stores:
`src/lib/today/today-page-store.ts`, `src/providers/today-page-store-cache.ts`.

Desktop window cold-open phases: `src/lib/today/today-window-boot-timeline.ts`; main logs them with its own
milestones as one `[today-window] boot timeline` JSON line per open.

The top day opens from the workspace's local page store as soon as the matching runtime is ready.
The local standalone window starts the conversation metadata scan after the first day paints.
Mentions use the projection as it becomes available. Earlier days acquire their page stores
near the viewport.

The local desktop can retain one previously opened Today renderer while another product window
remains. The hidden window goes to the root route and releases its workspace runtime. Reopening
binds a new day and shows the window once its local outline or retry UI commits. If the binding
times out, main replaces the renderer with a cold open. Cloud windows use the normal close path.

The standalone window currently starts its own runtime. A [shared-renderer proposal](../../../../../.agents/notes/proposed/architecture/2026-11-25-today-shared-renderer.md) records the companion experiment and what runtime ownership would require.
