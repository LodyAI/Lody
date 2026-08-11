# components/chat

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

## Responsibility Split

- `chat-composer.tsx` owns the reusable composer shell: prompt textarea,
  attachment chips, status text, top/footer/bottom selector slots, image add,
  and primary/secondary action placement.
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
- The landing composer footer is ordered run config → permission → usage on
  desktop. Mobile new-chat uses the same consolidated `MobileSessionRunConfig`
  face + sheet as the in-session composer (agent/model/reasoning/permission/
  Plan/Fast), with usage beside it; do not reintroduce separate model/thinking
  chips or a below-composer agent/permission row. Usage reads subscription rate
  limits from the selected agent's Machine Flock metadata and remains hidden for
  custom or environment-overridden providers.
- `chat-landing-view.tsx` is the render-only landing layout around
  `ChatComposer`; keep stateful data loading in `chat-landing.tsx`.
- `comment-reference-*` and `visual-annotation-reference-*` own attachment chip
  state and rendering for references attached to outgoing messages.
- Landing attachment uploads use two sibling hooks in `hooks/`:
  `use-chat-landing-image-draft.ts` (images) and `use-chat-landing-file-draft.ts`
  (non-image files; cloud upload + Electron local-transport fast path, mirroring
  `sessions/session-chat-input-area.tsx`). `chat-landing.tsx` wires BOTH
  `onImageAddClick` and `onFileAddClick` into the desktop `ChatLandingView` and
  the mobile new-chat sheet composer, and renders a second hidden file `<input>`
  (no `accept`) next to the image input in every render branch.

## Invariants

- `use-chat-landing-draft-session.ts` owns the landing's reserved session id.
  Images, files, ACP preparation, and `startSession({ sessionId }, firstTurn)` MUST consume
  that same identity. Attachment hooks never reset it independently; reset only
  after full draft clear. Submit blocks while either `hasBlockingImages` or
  `hasBlockingFiles`.
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
