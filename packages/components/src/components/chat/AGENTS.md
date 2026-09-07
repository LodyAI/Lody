# components/chat

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
Index and rationale: [README.md](README.md).

## Composer and selectors

- `attachment-add-menu.tsx` is the composer's single "+" menu and owns the
  per-turn MCP selection (`ChatComposer mcp` → `AttachmentAddMenuMcp`), never the
  footer selector row. MCP is always a second level: a desktop hover submenu, and
  on touch a panel pushed onto the same surface with a back row. Toggling never
  closes the menu, and the entry hides itself when the catalog is empty.
- Desktop project pickers use the standard DropdownMenu, mixing local/GitHub projects by
  recency. Pin no-project/add-local/connect-GitHub actions; mount at most 20 rows
  (most recent when empty, first matches across all options when searching).
  Scope order: machine → project → worktree/branch. Direct local sessions never
  render/pass a branch; explicit local worktrees and GitHub sessions keep theirs.
  GitHub projects are machine-independent. Machine selection filters local projects
  and agent configs; changing machines clears an incompatible local project without
  selecting a replacement. Keep mobile pickers independent.
- A single-member workspace never passes project-sharing state. In multi-member
  workspaces, local project options and the selected desktop trigger show only an
  effective `Private` status — Team and unresolved states stay hidden — where
  effective access is `machine.sharedWithTeam && project.sharedWithTeam`, never
  the raw project bit. The selected Private segment opens `ProjectShareDialog`,
  confirmed through the project share mutation, which also shares its machine
  atomically. Route share failures through `useConvexErrorMessage` so expired auth
  requests recovery and raw Convex details never reach the toast. GitHub options
  carry no local-project access badge. The desktop machine selector marks an
  option local only when its value exactly matches `visibleLocalMachineId`;
  ownership and Private access never stand in for that local probe.
- The sharing-review landing notice has two distinct durable actions: dismissal
  keeps the current source revision quiet, while "Don't remind me again"
  suppresses that user's notice for the workspace across future revisions.
- The landing composer footer is ordered run config → permission → usage on
  desktop. Provider interaction mode is a row inside run config; the standalone
  button is reserved for explicit permission mode, with legacy ACP modes as the
  fallback. Mobile new-chat uses the same consolidated `MobileSessionRunConfig`
  face + sheet as the in-session composer, with usage beside it — see
  `../mobile/AGENTS.md`. Do not reintroduce separate
  model/thinking chips or a below-composer agent/permission row. Usage reads
  subscription rate limits from the selected agent's Machine Flock metadata and
  stays hidden for custom or environment-overridden providers.
- The desktop run config menu's "Recently used" group (`lib/recent-run-configs.ts`)
  is device-local localStorage history keyed per workspace, recorded only when a
  chat is actually STARTED — never when a knob moves. A row offers a whole
  combination (agent + model + every config option) and is filtered to agents on
  the selected machine; the current combination never appears. Applying one sets
  the agent first and must wait until `appliedTargetKey`
  (`use-acp-session-config-selection.ts`) names that agent before writing
  model/options.
- Every landing branch exposes ONE unfiltered hidden file input and one
  `onAttachmentAddClick`; selected files are split by MIME into the image and file
  draft hooks, exactly like paste and drop.

## Invariants

- The chat-route URL declares the composer's selection and never carries one-shot
  event nonces. Once the URL names a selection, the landing mirrors composer
  steering back into it via the desktop route's `onSelectionUrlSync` (replace,
  incomplete selections map to an empty search). A plain `/chat` URL stays plain:
  restored defaults and auto-selection never rewrite it. Mobile keeps its
  base-context model and passes no sync callback.
- `use-chat-landing-draft-session.ts` owns the landing's reserved session id, and
  images, files, ACP preparation, and `startSession({ sessionId }, firstTurn)`
  MUST consume that same identity. Attachment hooks never reset it independently;
  reset only after a full draft clear. Submit blocks while `hasBlockingImages` or
  `hasBlockingFiles`.
- Keep reserved session id and attachments in module-level atoms
  (`atoms/chat-landing-draft.ts`, `buildChatLandingDraftKey`), keyed by workspace
  SLUG, not the initially unresolved workspace id. Drafts survive route unmount:
  never revoke preview URLs or abort uploads on unmount; uploads settle into the
  atom. Revoke/abort only on attachment removal or full draft clear. Never persist
  these atoms to localStorage; losing attachments on app restart is expected.
- Submit immediately hides and disables the visible landing draft but preserves
  its controlled text, attachment resources, and reserved session id until
  `startSession` accepts. Failure must reveal the unchanged draft; only acceptance
  may clear resources or reset the reserved id. The accepted history entry is
  direct-authored into the renderer's own session store.
- Draft ACP preparation uses that same reserved id. It carries no prompt, env, or
  secret-shaped ACP option values; it may include the current sanitized
  mode/model/options. It is debounced/best-effort, replaced when routing or run
  config changes, cancelled on idle, and never awaited by submit. Once the initial
  user turn is locally accepted, submit MUST hand the lease to the durable session
  before clearing the draft or navigating; a successful handoff must not send
  `session/prepare-cancel`.
- `chat-landing-view.tsx` is the render-only landing layout around
  `ChatComposer`: keep stateful data loading in `chat-landing.tsx` and the
  session-mention drop target local to the view. `ConversationDropOverlay` paints
  the page-level mask as soon as the sidebar drag starts, not only after
  `dragenter`. Desktop only — touch has no HTML5 drag, so the mobile branch passes
  the handle but installs no drop target.
- Composer dropdown/toggle chrome must disable browser text selection with
  `select-none`: top selector, footer selector, bottom bar, ACP boolean toggles,
  Workdir/agent/model/branch picker triggers, mobile inline picker triggers, and
  picker option rows. Text-entry surfaces stay selectable/editable: the main
  prompt textarea, pasted text editor, and picker search inputs must not inherit
  a broad `select-none`.
- After a desktop composer/landing menu selection (mode, model/agent run-config,
  project, branch, machine, …), focus must return to the prompt
  (`[data-keyboard-nav="composer"]`), never the menu trigger. Shared policy lives
  in `lib/menu-focus.ts` and is wired through `ui/dropdown-menu` +
  `OptionSelector`. Keep-open run-config picks (`event.preventDefault` on select)
  still count as a selection.
- Desktop landing's machine/project/branch menus always open upward with collision
  flipping disabled. Their top-row labels and glyphs, including disabled branch
  state, share the same neutral foreground level.
- The ACP provider cycle command uses the same single-machine scope as the visible
  provider menu. Never cycle all workspace configs while retaining the old machine id.
- Mobile composer pickers rely on `MobileInlinePicker` plus
  `MobileInlinePickerRowSlot` so dropdown panels project to a full-row slot,
  never resizing a narrow footer chip.
- Never render raw local Git, Machine RPC, or Streams failures as landing composer
  status text. Keep them in state for submit blocking, telemetry, logging, and the
  scoped retry control; composer status is for actionable validation and
  selected-machine project guidance.
- Chat Landing must not initiate ACP capability probes: startup refresh lives in
  the workspace runtime and explicit probes in settings/onboarding. Do not render
  their spinner, download progress, or ready state in the landing composer.
