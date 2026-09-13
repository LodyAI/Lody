# components/chat

The new-chat landing and the reusable composer shell it renders. Binding rules
live in [AGENTS.md](AGENTS.md); this file is the directory index and the
reasoning behind those rules.

## Ownership

| Area                   | Owner                                                                                                                                                                                    | Responsibility                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Composer shell         | [`chat-composer.tsx`](chat-composer.tsx)                                                                                                                                                 | Prompt, attachment chips, status, selector slots, and actions.                  |
| New-chat orchestration | [`chat-landing.tsx`](chat-landing.tsx)                                                                                                                                                   | Selector and draft state, mobile sheets, submission, and `ChatComposer` inputs. |
| Landing layout         | [`chat-landing-view.tsx`](chat-landing-view.tsx)                                                                                                                                         | Render-only layout around `ChatComposer`.                                       |
| Derived selection      | [`chat-landing-derived.ts`](chat-landing-derived.ts)                                                                                                                                     | Pure landing selection state.                                                   |
| Selector controls      | [`chat-landing-selectors.tsx`](chat-landing-selectors.tsx), [`unified-project-selector.tsx`](unified-project-selector.tsx)                                                               | Project and branch wrappers over shared selectors.                              |
| Attachment menu        | [`attachment-add-menu.tsx`](attachment-add-menu.tsx)                                                                                                                                     | The single "+" menu and per-turn MCP selection.                                 |
| Reference chips        | `comment-reference-*`, `visual-annotation-reference-*`                                                                                                                                   | State and rendering for outgoing references.                                    |
| Host chrome            | [`context-switch.tsx`](context-switch.tsx), [`machine-pairing-dialog.tsx`](machine-pairing-dialog.tsx), [`web-chat-landing-screen.tsx`](web-chat-landing-screen.tsx)                     | Context controls and host-specific entry points.                                |
| Submission             | [`submission/`](submission/AGENTS.md)                                                                                                                                                    | Composer submission lifecycle and local rules.                                  |
| Draft persistence      | [`../../atoms/local-storage-cache.ts`](../../atoms/local-storage-cache.ts), [`../../atoms/chat-landing-draft.ts`](../../atoms/chat-landing-draft.ts)                                     | Durable text and in-memory attachment state, scoped by workspace.               |
| Attachment uploads     | [`../../hooks/use-chat-landing-image-draft.ts`](../../hooks/use-chat-landing-image-draft.ts), [`../../hooks/use-chat-landing-file-draft.ts`](../../hooks/use-chat-landing-file-draft.ts) | Image and file upload state, including Electron's local transport.              |

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
- **Workspace-scoped drafts.** The workspace slug scopes every part of a new-chat
  draft before the workspace id resolves. Every peer workspace window uses the
  same durable localStorage contract; its launch relationship does not change
  draft ownership or lifetime.
- **Menu focus returning to the prompt.** Leaving focus on the model/agent trigger
  after Esc or an outside dismiss makes Enter re-open that menu.
- **The drop target living in `chat-landing-view.tsx`.** A session dragged from the
  sidebar writes a mention into the composer this layout renders, and nothing above
  it participates, so plumbing the handle up to `chat-landing.tsx` would buy
  nothing.
- Draft ACP preparation has a longer contract that remains in the private
  architecture context.
