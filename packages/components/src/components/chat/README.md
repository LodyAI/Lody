# components/chat

The new-chat landing and the reusable composer shell it renders. Binding rules
live in [AGENTS.md](AGENTS.md); this file is the directory index and the
reasoning behind those rules.

## Ownership

- `chat-composer.tsx` — the reusable composer shell: prompt textarea, attachment
  chips, status text, top/footer/bottom selector slots, image add, and
  primary/secondary action placement.
- `chat-landing.tsx` — new-chat orchestration: selector state, mobile sheet
  wiring, submit behavior, and the nodes passed into `ChatComposer`.
- `chat-landing-view.tsx` — the render-only landing layout around `ChatComposer`.
- `chat-landing-derived.ts` — derived landing selection state.
- `chat-landing-selectors.tsx`, `unified-project-selector.tsx` — wrappers over the
  shared selector primitives for the project and branch controls.
- `attachment-add-menu.tsx` — the composer's single "+" menu, including the
  per-turn MCP selection.
- `comment-reference-*` and `visual-annotation-reference-*` — attachment chip
  state and rendering for references attached to outgoing messages.
- `context-switch.tsx`, `machine-pairing-dialog.tsx`, `web-chat-landing-screen.tsx`
  — landing chrome and host-specific entry points.
- [`submission/`](submission/AGENTS.md) — the composer submission lifecycle
  (its own scope, with its own rules).
- Landing attachment uploads live in two sibling hooks under `src/hooks/`:
  `use-chat-landing-image-draft.ts` (images) and `use-chat-landing-file-draft.ts`
  (non-image files; cloud upload plus the Electron local-transport fast path,
  mirroring `sessions/session-chat-input-area.tsx`).

## Why the rules read the way they do

- **MCP as a second menu level.** The workspace MCP catalog is multi-select and
  unbounded, so it cannot sit in the footer selector row. Desktop has hover and
  opens a submenu; touch does not, so mobile pushes the panel onto the same
  surface with a back row.
- **The 20-row picker cap.** The complete option set is unbounded; the cap keeps
  the menu mountable while search still ranks over everything.
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
- **Menu focus returning to the prompt.** Leaving focus on the model/agent trigger
  after Esc or an outside dismiss makes Enter re-open that menu.
- **The drop target living in `chat-landing-view.tsx`.** A session dragged from the
  sidebar writes a mention into the composer this layout renders, and nothing above
  it participates, so plumbing the handle up to `chat-landing.tsx` would buy
  nothing.
- Draft ACP preparation has a longer contract that remains in the private
  architecture context.
