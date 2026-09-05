# Settings components

## Prompt Shortcuts

- `prompt-shortcuts-setting.tsx` owns the list and editor container. Key its local
  dialog state by account/workspace so old drafts and late reads cannot appear
  under a new identity. Storage and publication belong to the workspace provider
  and `shared/src/prompt-shortcuts`, never a panel effect.
- `prompt-shortcut-form.tsx` is presentational. Scope starts empty; never infer it
  from the active composer or a selected mention. Sharing starts private.
- The container remounts the source-owning `CombinedMentionTextarea` on explicit
  scope changes. Restore the current draft's semantic ranges, not the saved
  revision's ranges; otherwise new mentions are lost or old-project candidates
  can be rebound to the new scope. Template mode disables token-scanning
  hydrators, sessions and ACP commands. Skills load only on menu activation.
- A pending publication is durable but not yet advertised. Do not call it synced
  or replace the ambiguous revision. Retry through the runtime; keep Cancel
  usable. Full pending/conflict repair and invocation UI are tracked in the
  private composition's `docs/prompt-shortcuts.md`.
- Form visual fixtures: `src/stories/PromptShortcutForm.stories.tsx`. Scope and
  range behavior: `tests/prompt-shortcut-form.test.tsx`; identity fencing:
  `tests/prompt-shortcuts-setting.test.tsx`.
