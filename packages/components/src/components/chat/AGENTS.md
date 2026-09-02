# components/chat

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

## Responsibility Split

- `chat-composer.tsx` owns the reusable composer shell: prompt textarea,
  attachment chips, status text, top/footer/bottom selector slots, image add,
  and primary/secondary action placement.
- `attachment-add-menu.tsx` is the composer's single "+" menu and owns the
  per-turn MCP selection (`ChatComposer mcp` → `AttachmentAddMenuMcp`), NOT the
  footer selector row — the footer stays run config → permission → usage. MCP is
  always a second level because the catalog is multi-select and unbounded:
  desktop opens a hover submenu, touch has no hover so mobile pushes the panel
  onto the same surface with a back row. Toggling never closes the menu. The
  entry hides itself when the workspace catalog is empty.
- `chat-landing.tsx` owns new-chat orchestration, selector state, mobile sheet
  wiring, submit behavior, and the nodes passed into `ChatComposer`.
- `chat-landing-selectors.tsx` and `unified-project-selector.tsx` wrap shared
  selector primitives for project/branch controls. The desktop project picker
  mixes local + GitHub projects by recent activity and exposes pinned no-project,
  add-local, and connect-GitHub actions on the standard DropdownMenu surface
  as composer run config. It mounts at most 20 option rows: the 20 most recent
  while the query is empty, or the first 20 matches from the complete option set
  while searching. Desktop landing's top scope row is ordered machine →
  project → worktree/branch. Direct local-project sessions never render or pass
  a branch; the local branch picker appears only in explicit worktree mode.
  GitHub sessions keep their branch picker. The selected machine filters both
  local projects and agent configs; changing away from a selected local project's
  machine clears that project instead of silently choosing another one. GitHub
  projects remain machine-independent. Keep the mobile type-specific pickers
  independent until their sheet is redesigned. A single-member workspace never
  passes project-sharing state. In multi-member workspaces, local project options
  and the selected desktop trigger show only an effective `Private` status; Team
  and unresolved states stay hidden. Effective access still combines
  `machine.sharedWithTeam && project.sharedWithTeam`, rather than using the raw
  project bit. The selected Private segment opens `ProjectShareDialog`; confirming
  uses the project share mutation, which also shares its machine atomically. Route
  project share failures through `useConvexErrorMessage` so expired auth requests
  recovery and raw Convex details never reach the toast. GitHub options do not use
  this local-project access badge. The desktop machine selector marks an option as
  local only when its value exactly matches `visibleLocalMachineId`; ownership and
  Private access are independent and must never stand in for the local probe.
- The sharing-review landing notice has two distinct durable actions: dismissing
  it keeps the current source revision quiet, while “Don't remind me again”
  suppresses that user's notice for the workspace across future revisions.
- The landing composer footer is ordered run config → permission → usage on
  desktop. Provider interaction mode is a row inside run config; the standalone
  button is reserved for explicit permission mode, with legacy ACP modes as its
  fallback. Mobile new-chat uses the same consolidated `MobileSessionRunConfig`
  face + sheet as the in-session composer (agent/model/interaction/reasoning/
  permission/Plan/Fast), with usage beside it; do not reintroduce separate model/thinking
  chips or a below-composer agent/permission row. Usage reads subscription rate
  limits from the selected agent's Machine Flock metadata and remains hidden for
  custom or environment-overridden providers.
- The desktop run config menu's "Recently used" group (`lib/recent-run-configs.ts`)
  is device-local localStorage history keyed per workspace, recorded only when a
  chat is actually STARTED — never when a knob moves. A row offers a whole
  combination (agent + model + every config option) and is filtered to agents on
  the selected machine; the current combination never appears. Applying one sets
  the agent first and must wait until `appliedTargetKey` (see
  `use-acp-session-config-selection.ts`) names that agent before writing
  model/options, or the seeded per-agent defaults overwrite them.
- `chat-landing-view.tsx` is the render-only landing layout around
  `ChatComposer`; keep stateful data loading in `chat-landing.tsx`. Its one
  piece of local state is the session-mention drop target: a session dragged
  from the sidebar onto the landing writes a mention into the composer this
  layout renders, and nothing above it participates, so plumbing the handle up
  to `chat-landing.tsx` would buy nothing. `ConversationDropOverlay` paints the
  page-level mask as soon as the sidebar drag starts, not only after `dragenter`.
  Desktop only — touch has no HTML5 drag, so the mobile branch passes the handle
  but installs no drop target.
- `comment-reference-*` and `visual-annotation-reference-*` own attachment chip
  state and rendering for references attached to outgoing messages.
- Landing attachment uploads use two sibling hooks in `hooks/`:
  `use-chat-landing-image-draft.ts` (images) and `use-chat-landing-file-draft.ts`
  (non-image files; cloud upload + Electron local-transport fast path, mirroring
  `sessions/session-chat-input-area.tsx`). Every landing branch exposes ONE
  unfiltered hidden file input and one `onAttachmentAddClick`; selected files
  are split by MIME into those two state machines, just like paste and drop.

## Invariants

- The chat-route URL declares the composer's selection; it never carries one-shot
  event nonces. Once the URL names a selection, the landing mirrors composer
  steering back into it via the desktop route's `onSelectionUrlSync` (replace,
  incomplete selections map to an empty search), so a sidebar project-row click
  is either an identical-URL no-op or an ordinary search change. A plain `/chat`
  URL stays plain: restored defaults and auto-selection never rewrite it. Mobile
  keeps its base-context model and passes no sync callback.
- `use-chat-landing-draft-session.ts` owns the landing's reserved session id.
  Images, files, ACP preparation, and `startSession({ sessionId }, firstTurn)` MUST consume
  that same identity. Attachment hooks never reset it independently; reset only
  after full draft clear. Submit blocks while either `hasBlockingImages` or
  `hasBlockingFiles`.
- The reserved session id and both attachment lists live in module-level atoms
  (`atoms/chat-landing-draft.ts`), keyed by `buildChatLandingDraftKey`, so the
  draft survives the landing route unmounting when the user visits another tab
  — the prompt text always did, and an attachment that silently vanished was
  sent-without-context waiting to happen (#242). Consequences the hooks must
  keep: NO unmount cleanup (revoking a preview URL or aborting an upload on the
  way out is what broke the returning draft), so `URL.revokeObjectURL` and
  `AbortController.abort()` belong only to removing one attachment or clearing
  the whole draft; an upload in flight at unmount keeps running and settles into
  the atom. That key is workspace-scoped while the prompt-text key is not,
  because an `imageId`/`fileId` is addressable only inside the workspace it was
  uploaded to. It scopes on the workspace SLUG: `useResolvedWorkspaceScope()`
  reports `null` until the workspace resolves, and a key that flipped mid-mount
  would strand whatever was added first. Never persist these to localStorage —
  a `blob:` URL and an `AbortController` do not serialize, and losing a draft
  attachment on app restart is expected.
- Submit immediately hides and disables the visible landing draft, but preserves
  its controlled text, attachment resources, and reserved session id until
  `startSession` accepts. Failure must reveal the unchanged draft; only acceptance
  may clear resources or reset the reserved id. The accepted history entry is
  direct-authored into the renderer's own session store, so the new conversation
  renders it immediately without waiting for room sync.
- Draft ACP preparation also uses that exact reserved session id. It carries no prompt,
  env, or secret-shaped ACP option values; it may include the current sanitized
  mode/model/options. It is debounced/best-effort, replaced when routing or run config
  changes, cancelled on idle, and never awaited by submit. After the initial user turn
  is locally accepted, submit MUST hand the lease to the durable session before clearing
  the draft or navigating; successful handoff must not send
  `session/prepare-cancel`. See
  The detailed contract remains in the private architecture context.

- Composer dropdown/toggle chrome must disable browser text selection with
  `select-none`: top selector, footer selector, bottom bar, ACP boolean toggles,
  Workdir/agent/model/branch picker triggers, mobile inline picker triggers, and
  picker option rows.
- After a desktop composer/landing menu selection (mode, model/agent run-config,
  project, branch, machine, …), focus must return to the prompt
  (`[data-keyboard-nav="composer"]`), never the menu trigger. Shared policy lives
  in `lib/menu-focus.ts` and is wired through `ui/dropdown-menu` +
  `OptionSelector`. Keep-open run-config picks (`event.preventDefault` on select)
  still count as a selection so Esc/outside-dismiss does not leave focus on the
  model/agent trigger (which would make Enter re-open that menu).
- Desktop landing's machine/project/branch menus always open upward with collision
  flipping disabled. Their top-row labels and glyphs, including disabled branch
  state, share the same neutral foreground level.
- The ACP provider cycle command uses the same single-machine scope as the visible
  provider menu. Never cycle all workspace configs while retaining the old machine id.
- Keep text-entry surfaces selectable/editable: the main prompt textarea, pasted
  text editor, and picker search inputs must not inherit broad `select-none`.
- Mobile composer pickers rely on `MobileInlinePicker` plus
  `MobileInlinePickerRowSlot` so dropdown panels project to a full-row slot
  instead of resizing a narrow footer chip.
- Do not render raw local Git, Machine RPC, or Streams failures as landing composer
  status text. Keep those failures in state for submit blocking, telemetry, logging,
  and the scoped retry control; composer status is for actionable validation and
  selected-machine project guidance.
- Chat Landing must not initiate ACP capability probes. Startup refresh lives in
  the workspace runtime, and explicit probes live in settings/onboarding; do not
  render their spinner, download progress, or ready state inside the landing composer.
