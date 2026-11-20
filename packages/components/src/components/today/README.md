# Today

Experimental daily outline notes ([Spec](../../../../../specs/today-outline.md)).

| File                                                | Role                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------ |
| `today-page.tsx`                                    | Full-page route surface                                                        |
| `today-pinned-column.tsx`                           | Column pinned beside the sidebar                                               |
| `today-view.tsx`                                    | Day stream shell: calendar, member menu, surface, picker, drag layer           |
| `today-day-section.tsx`                             | One day: lazy page store, rows, session rows                                   |
| `today-stream.ts`                                   | Which days show, local date and midnight math                                  |
| `today-session-node.tsx`, `today-session-status.ts` | Session node line and status mapping                                           |
| `today-dnd.ts`                                      | Drop projection for node and sidebar drags                                     |
| `today-convert-dialog.tsx`                          | Convert to task with the new-conversation surface                              |
| `editor/`                                           | Single Lexical editor, LoroText binding, keys, block selection, caret geometry |

Data model and undo: `packages/shared/src/today-outline.ts`; identity and links:
`packages/shared/src/today-types.ts`, `packages/shared/src/session-link.ts`; page stores:
`src/lib/today/today-page-store.ts`, `src/providers/today-page-store-cache.ts`.
