# Settings components

## The shared editor grammar

`emoji-field.tsx` is the one emoji control (button + lazy `emoji-picker-panel`
+ reset), shared by the Agent Role and Prompt Shortcut editors so a catalog
entry's glyph is the same affordance everywhere.

`form-primitives.tsx` owns `Section`, `Field`, `FormMessage` and
`AutoGrowTextarea` (a one-row field that tracks its content's height; it must
re-measure on width changes, because wrapping is what decides the row count).
Every settings editor — MCP connection, Agent Role, Prompt Shortcut — is the same stack:
a dialog `header` (`px-5 py-3 pr-12`), a scrolling `scrollbar-pro` body of
bordered sections, and a bordered footer with Cancel plus the primary action.
Lists share one row grammar too (`rounded-lg bg-foreground/[0.04]`, a row body
button that opens the editor, a trailing ghost action cluster, a dashed empty
state). Copy a local variant of any of these and three surfaces that are meant
to read as one drift apart a padding value at a time.

## Prompt Shortcuts

- `promptShortcutsFeatureEnabledAtom` requires Developer mode plus the default-off
  opt-in in About → Beta features. It gates shared settings navigation, direct
  panel access, mention discovery and runtime initialization; disabling never
  deletes saved Shortcuts.

- `prompt-shortcuts-setting.tsx` owns the list and editor container. Key its local
  dialog state by account/workspace so old drafts and late reads cannot appear
  under a new identity. Storage and publication belong to the workspace provider
  and `shared/src/prompt-shortcuts`, never a panel effect.
- Scope options are resolved once for the whole panel and passed to both the list
  and the editor: a row that printed a raw machine id beside a selector that
  prints its name is two answers to one question.
- `prompt-shortcut-form.tsx` is presentational. Scope starts empty; never infer it
  from the active composer or a selected mention. Sharing starts private, and the
  slug follows the name only for a new Shortcut whose slug the author never typed.
- A Shortcut carries an optional `emoji`, stored normalized (stripped and capped
  in `shared/prompt-shortcuts/model.ts`) and projected into the index, so the
  list can show it without loading a body. Unset renders
  `DEFAULT_PROMPT_SHORTCUT_EMOJI` rather than an empty tile.
- A Shortcut is a Prompt and a scope, nothing more: no variables, no defaults,
  no call-time parameters. Do not reintroduce `!{name}` parsing anywhere.
- `prompt-shortcut-scope.tsx` owns the axis order (Project → Machine → Agent),
  their icons, the `None` sentinel a Radix `Select` needs, and the read-only
  pills. All axes unset prints one muted `Workspace` pill — that is scope, never
  visibility, so it must not read as "shared".
- The container remounts the source-owning `CombinedMentionTextarea` on explicit
  scope changes. Restore the current draft's semantic ranges, not the saved
  revision's ranges; otherwise new mentions are lost or old-project candidates
  can be rebound to the new scope. Template mode disables token-scanning
  hydrators, sessions and ACP commands. Skills load only on menu activation.
  `ShortcutPromptField` is exported so Storybook renders that real field.
- A row's warning line is derived from the index alone (saved dependencies vs
  saved scope). It is not live availability — there is no dependency resolver
  yet — so it says what to repair and never claims a Shortcut is `Available`.
  It is the ONLY status a row carries: publication state is deliberately absent,
  because a local save is already durable and the runtime retries on its own. A
  row must never report a background upload, and never lose an action over one.
- A pending publication is durable but not yet advertised. Do not call it synced.
  Save/Delete remain available: the runtime separates the local working head from
  immutable in-flight publication jobs. Only local I/O (`saving`/`busy`) disables
  duplicate actions, never cloud health or pendingIds. Retry through the runtime.
  Full conflict repair and invocation UI are tracked in the
  private composition's `docs/prompt-shortcuts.md`.
- Another member's shared Shortcut opens read-only in the same dialog shell.
  There is no copy-to-mine action yet; do not add an editing affordance that the
  authorization layer would reject.
- Visual fixtures: `src/stories/PromptShortcutForm.stories.tsx` and
  `src/stories/PromptShortcutsList.stories.tsx`. Scope and range behavior:
  `tests/prompt-shortcut-form.test.tsx`; identity fencing, read-only sharing and
  pending publication: `tests/prompt-shortcuts-setting.test.tsx`.
- `components/prototypes/prompt-shortcuts/` is a synthetic-data design prototype,
  not the product. Its Variables section still shows label/required/multiline
  controls the shipped model deliberately dropped; do not copy them back.
