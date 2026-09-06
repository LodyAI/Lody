# Composer run config, run-config menus, and Agent Roles

The composer footer knobs (Agent / Model / Interaction / Reasoning / Permission),
Agent Role selection on every surface, attachments, and the two durable run-config
authorities.

Scope: `packages/components/src/components/sessions`. Binding rules and the
pointer to this page live in
[that directory's AGENTS.md](../../packages/components/src/components/sessions/AGENTS.md);
this page is the full text of the rules summarised there.

- `session-chat-input-area.tsx` — composer; `message-queue-display.tsx` — queued turns.
  Child-tab suggestions are shared by draft and persisted child sessions through
  `child-tab-empty-state.tsx`; it uses the same `px-3` + `ConversationColumn` as
  the composer, so its right edge and max width must stay aligned automatically.
  Desktop run knobs are TWO footer buttons from `desktop-run-config-menu.tsx`:
  `DesktopRunConfigMenu` (`[agent icon] model · reasoning ⌄` face; dropdown =
  Agent/Model/Interaction/Reasoning plus provider-defined select side submenus +
  Plan/Fast toggle rows) and
  `DesktopPermissionModeButton` (permission icon + full name; flat permission
  list). Explicit `_permission` config options take precedence over legacy ACP
  modes; provider interaction modes stay inside the run-config dropdown. Both
  are also used by the desktop chat landing; `DesktopRunConfigMenu` receives an
  explicit agent selection/machine scope rather than reading `SessionMeta`.
  Builtin DeepSeek Harness sessions using a non-Pro model show the same linked
  delegation-cost warning here and in `MobileRunConfigSheet`: until upstream DSH
  fixes child-route inheritance, a delegated child may use the session's
  creation-time DeepSeek-V4-Pro seed rather than the parent's visible model.
  Keep the warning tied to that agent/model combination and its upstream
  discussion rather than turning it into a global banner.
  Agent/Model/Reasoning option selection closes the dropdown and must not return
  keyboard focus to its trigger; Plan/Fast toggle rows intentionally stay open.
  Once the model list reaches `OPTION_SEARCH_MIN_OPTIONS`
  (`lib/fuzzy-option-filter.ts` — the same threshold and matcher the mobile
  sheet uses) the Model submenu gains a fuzzy search row over
  `MenuOptionSearchList`: a provider may publish dozens of models, and scrolling
  is not a way to find one. A search field inside a Radix menu must be
  `DropdownMenuSearchInput`, which owns the fight with the menu's typeahead and
  roving focus (its jsdoc has the details); the same tasks-side Model submenu
  (`tasks/task-agent-run-config-menu.tsx`) is still an unsearchable clone and
  should adopt it.
  `DesktopRunConfigMenu` gains a **Role** row when the caller passes
  `agentRoles`. It sits ABOVE Agent, since a Role answers every row under it at
  once. The callers split by whether a Session exists yet, and that difference
  is load-bearing:

  **Chat landing and a blank child-tab draft** authorize the WHOLE Role —
  agent config, run config, instruction, and provenance — because no Session
  exists yet and the Agent can still move. A child tab keeps the parent
  Session's exact machine/workspace, so its Role list is every Role bound to
  that machine, across Agent types; selecting one changes the draft Agent.
  Never route a draft through `selectSessionAgentRoles`: that same-type subset
  is only correct after a Session exists. The Role id persists with a non-empty
  draft, its current revision re-seeds the composer after an edit, and its
  instruction is frozen into the first Turn before draft promotion.

  **An existing session** (`useSessionAgentRole`) can NOT: its agent, machine,
  and runtime are fixed. So it offers only Roles bound to that exact machine +
  Agent Config (the model provider shown by the composer) and applies only their
  RUN CONFIG, which is exactly what transfers: model / reasoning / permission
  are the values a session can still change every turn. Keep the Role's real
  availability so a stale binding stays visible but cannot be selected. The
  Role's INSTRUCTION is not applied, because a prompt prefix belongs to the
  first turn of a session the Role creates. The row is NOT gated on
  `isEmptyConversation`: those values stay changeable for the whole
  conversation. An unsent explicit selection (including None) lives in
  session-keyed app state rather than the composer component: top-level
  navigation unmounts that component, and one shared override slot also makes
  selecting a Role in a second Session erase the first Session's identity. On
  send, freeze `agentRoleId` (null for None) plus `agentRoleRevision` into the
  Turn `inputConfig`; the latest accepted/queued Turn is the synchronized
  authority on remount and supersedes a draft made against an older Turn. A
  session-keyed last-known durable snapshot may bridge the empty document while
  that remount hydrates, but it is never an authority: replace it as soon as the
  document is ready. Keep the known logical Turn lineage as its supersession
  fence: queue promotion, deletion, reordering, and older history backfill are
  not newer Turns; consume a draft only when the authoritative current Turn
  moves to a previously unseen key. Role
  selection and Turn submission stay disabled until the Session document is
  ready because its transient provider defaults are not a valid run config.
  Programmatic Turns inherit the current
  Role only after their final run-config overrides are applied; if an override
  breaks a value the Role pins, freeze explicit None instead of a lying Role id.
  A legacy/non-composer Turn with both fields absent inherits the most recent
  explicit selection; only `agentRoleId: null` means None. Keep unsynced catalog
  rows and not-yet-hydrated Session docs in the unknown state — neither may
  turn a durable Role into explicit None. If the catalog row is still unknown,
  an unsent manual run-config edit drops stale Role provenance to unknown.
  Session provenance remains the legacy fallback when the selected Turn
  predates these fields; never rewrite `SessionMeta.agentRoleId`, which records
  creation provenance only.
  `isAgentRoleRunConfigApplied` is the shared value rule;
  `isComposerAgentRoleApplied` is that rule plus the landing's agent check. With Roles to pick it is a submenu of
  `None` + the Roles bound to the machine the chat will start on (a Role's
  `machineId + agentConfigId` are exact, so a Role from another machine could
  only move the chat or fall back) beside a pane stating what the highlighted
  one runs; with NO Roles the row's VALUE is the create action instead, and the
  editor opens seeded from the composer's current configuration
  (`buildAgentRoleFormValueFromRunConfig`) — "save what I am about to run" is
  why that entry point is here at all, and the new Role is SELECTED as soon as
  the composer can offer it — creating from here means "use this now". That is
  deferred, not immediate (`resolvePendingAgentRoleSelection`): the write
  resolves on durability while the catalog snapshot arrives on its own tick, so
  the Role is not in the list at that moment; and a Role bound to another
  machine is given up on rather than followed there. `None` clears the NAME, not the
  configuration: the values the Role seeded are the user's own now, and rolling
  them back would undo choices they never asked to undo. An unavailable Role
  stays listed and disabled with its reason, `machine_offline` included, since
  no machine heading carries it here. `AgentRoleDetailPane`
  (`sessions/agent-role-detail-pane.tsx`) is the ONE pane that reads a Role, and
  the `@` mention menu renders the same one — a Role is the same object on both
  surfaces, and describing it twice is how the two drift (the mention menu's own
  generic rows had already drifted: they printed the stored ids raw and labelled
  the permission mode "Reasoning"). Each host passes the subject and sizes the
  box; the mention menu also passes `machineLabel`, because that list spans
  machines while the composer's is one machine by construction. It resolves each stored id
  against the BOUND agent's capabilities, so a Role reads in that agent's own
  wording ("Full access", not `agent-full-access`), and it shows ONLY what the
  Role pins — `resolveConfigOptionValue` would fall back to the agent's current
  value and print a reasoning level the Role never chose. Each pinned value is
  ONE line: `glyph label ……… value`, the same row grammar as the Agent / Model /
  Reasoning rows this submenu opened from, so the pane reads as a continuation
  of that menu rather than a second vocabulary. The label sits at the glyph's
  own size — it names the glyph, it does not compete with the value — and the
  value is pushed to the right edge, which aligns the column without a fixed
  label width that no single width could give across locales. A value that
  outruns the line elides rather than wraps, and a model id elides at the START
  (`claude-opus-5` vs `claude-sonnet-5` differ in the tail). The permission's DESCRIPTION is
  deliberately absent: a sentence about what one value allows belongs to the
  Role editor, not to a scan of what is pinned. Its machine is passed
  in rather than looked up, so the pane stays renderable without the workspace's
  machine-visibility context. The Role editor is a Dialog and is therefore
  hosted by the composer, NOT inside menu content, where it would unmount with
  the menu the moment it opened; `AgentRoleEditorDialog` is the one editor,
  shared with Settings.
  Picking a Role flows through the SAME preference channel as that agent's
  remembered defaults (`useAcpSessionConfigSelectionState`), never a second
  apply path — so a pinned value the agent no longer supports falls back visibly
  there instead of being forced in. That channel is a PURE DERIVATION: user
  edits are the only stored selection state, and effective values resolve per
  render (user edit > runtime baseline > turn preference > capability default;
  a full runtime snapshot owns the non-user config table). Never reintroduce a
  reducer that stores the resolved selection or an effect that reconciles it —
  two dispatches disagreeing about a runtime-omitted key plus options rebuilt
  from the selection was a synchronous #185 render loop on session open. The footer names a Role only while
  `isComposerAgentRoleApplied` still holds (`lib/composer-agent-roles.ts`):
  every value the Role pins is what will run. Moving a knob takes the name away
  rather than clearing the preference, which would re-seed the value just
  changed. With a Role selected the TRIGGER carries the Role and nothing else,
  and the model/reasoning/permission/Plan/Fast values render beside it as inert
  dimmed text: a Role IS the whole configuration, so changing one of those by
  hand is exactly what unnames it, and a knob that silently unnames the thing
  next to it is a trap. Permission is one of those values
  (`doesAgentRolePinPermissionMode`), so `DesktopPermissionModeButton` is not
  rendered at all while a Role that pins it is selected — but it STAYS a button
  when the Role pins nothing there, because an agent with no permission control
  leaves a Role nothing to own and hiding the knob then would remove one the
  Role never had. The composer's preference NAMES a Role rather than holding a
  copy: editing one bumps its `revision`, which rides in `preferenceRevision`,
  so the composer re-seeds from what the Role says NOW — a captured copy would
  keep running the old values under the edited Role's name, and a deleted Role
  simply stops resolving. A warning-tone pinned mode (full access / skip permissions)
  keeps its amber shield in the face and in the detail pane: the rest is quiet
  because the Role decided it, but that value no longer has a button carrying
  the warning. `resolvePermissionModeFace` (`lib/permission-mode-face.ts`) is
  the one rule for what permission even IS on a given agent — an explicit
  `_permission` option, a legacy ACP mode, or a plain mode selector standing in
  — shared by the button, the face, and the Role detail pane. The pane takes
  only its `source` from that rule: the face RESOLVES a value, and resolution
  falls back to the agent's current one, which the pane must never present as
  something the Role pinned.
  Mobile (`MobileSessionRunConfig` → `MobileRunConfigSheet`) has the same Role
  row, in the same place — above Agent — as an ordinary `MobileInlinePicker`,
  with no detail pane and no edit: a phone row cannot carry the binding a Role
  authorizes, so the binding is read on desktop or in Settings. It DOES offer
  create, as the last entry in the list. The row renders whenever the caller
  passes `agentRoles`, even with none to list — the row then reads `None` and
  its list is the way to make the first one, which is what the desktop row does
  too; hiding it made the control look absent. `None` still leads the list and
  an unavailable Role is still listed, disabled, with its reason (from the
  shared `AGENT_ROLE_UNAVAILABLE_REASON_KEYS`).
  The Role editor is a Dialog, so every composer hosts it outside its menu /
  drawer — and the in-session one mounts it only while OPEN, because it reads
  machine visibility and the composer must stay renderable in hosts that do not
  provide that context. The collapsed
  `MobileRunConfigButton` face is unchanged: it shows the agent icon + model +
  reasoning, which stays true whether or not a Role set them. Neither the Role pane nor
  the `@` mention pane shows a private/workspace badge: every Role offered is
  one this user may run, so visibility changes nothing about accepting it and is
  a Settings concern. The remembered Role rides in
  `chatLandingDefaults.agentRoleId` on Chat Landing and
  `DraftSessionTab.agentRoleId` in a non-empty child-tab draft. It is restored
  only once the workspace catalog can answer — before that, "not in the list"
  means "not loaded yet", so the stored id must not be overwritten with null.
  `SessionMeta.agentRoleId`/`agentRoleRevision` record provenance only.
  A Role also appears in **Recently used**, because a Role IS one of those whole
  combinations: the record carries `agentRoleId`, that id is part of
  `getRecentRunConfigKey` (the same knobs picked by hand are a DIFFERENT entry —
  a Role also carries its instruction and its provenance), the row leads with
  the Role's mark and name, and picking it re-applies the ROLE rather than
  replaying its values. `buildRecentRunConfigItems` drops a Role entry whose
  Role is not in the passed `agentRoles` — a Role never falls back, so a deleted
  or unavailable one must not quietly re-run as loose values.
  Run config has two durable authorities. A user Turn freezes what executes in
  its `inputConfig`; `resolveSessionConversationConfig` reads the latest accepted
  or queued Turn. ACP `config_option_update`/`current_mode_update` events update
  the separate shared `SessionDoc.acpRuntimeConfig` baseline, causally fenced by
  the driving `userTurnId`. A queued Turn and a newer accepted Turn always beat
  an older runtime event. Apply that shared baseline only to composer fields the
  local user has not edited; local unsent choices remain a private draft until
  send freezes them into a Turn. Never infer runtime config from a permission
  click or its history outcome: consent is not proof that the agent applied the
  change, and click-local state does not synchronize collaborators. Explicit
  execution actions (Implement Plan, Create PR, Commit & Push, conflict/CI/review
  fixes) are different: they create a new user Turn and must freeze a supported
  non-Plan mode into that Turn's `inputConfig`; they still must not mutate local
  composer state as a substitute for agent-confirmed runtime projection.
  `DesktopMachineMenu` is the matching elevated machine picker used by chat landing.
  Both render on the app-wide DropdownMenu surface (color-mix bg + layered
  float shadow). The old bottom bar row is gone: machine name + workdir badge moved to
  `SessionHeaderMenu` (`machineName` prop). Mobile keeps the single
  `MobileSessionRunConfig` button + sheet.
  Pending-attachment state machines: `pendingImages` (images) **and** `pendingFiles`
  (files; cloud upload via `@/lib/session-file-upload.ts` with sha256/textPreview,
  abort + part retry). Oversize images (>5 MiB) auto-degrade to files. Send blocks
  while either is uploading. Desktop same-machine uploads use
  `@/lib/electron-session-file-sender.ts` / `localProjects.sendSessionFileLocal`, return
  a `transport:'local'` block into the same `pendingFiles[].uploaded` slot, and fall
  back to cloud on handoff failure. The composer exposes one unfiltered hidden
  `<input type="file">` on every platform (Windows included — the renderer no
  longer crashes once locale `.pak`s ship; see `apps/electron/AGENTS.md`) and
  routes each selection by MIME into the image or file state machine.

