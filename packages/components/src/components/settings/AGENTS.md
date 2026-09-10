# Settings surfaces

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
Parent `AGENTS.md` files also apply.

Settings owns the workspace catalog surfaces (Providers, MCP servers, Agent
Roles). The catalog's durability rule — a local Flock write is durable, and the
upload that follows it is not something a settings surface waits on, reports, or
rolls back — is in the root [AGENTS.md](../../../../../AGENTS.md).

## Layout and components

- A settings row (`compact-layout.tsx`) is one grid: the label column takes the
  remaining space and the control column hugs its content. Never size either column
  from a viewport breakpoint — settings render in a panel far narrower than the window,
  and the panel clips its overflow, so a `md:`-width label column silently hides the
  control.
- Agent configuration lives in `agent-config-dialog.tsx` plus `env-vars-textarea.tsx`.
  DeepSeek Harness official vs custom endpoint is dialog form state only: persist
  `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` (official always writes
  `https://api.deepseek.com`) and never a new AgentConfigMeta field. Model ids come from
  the endpoint's OpenAI-compatible discovery response during live verification; do not
  add a parallel manual catalog field. Additional env cannot override either connection
  key, and changing endpoint or credential invalidates the dialog's prior live
  verification.
- Keep optional three.js/R3F usage behind the lazy usage-calendar module so lightweight
  and SSR consumers do not evaluate its renderer graph.
- Interface and terminal font choices exclude the known symbol families in
  `lib/local-fonts.ts`; persisted selections use the same filter. Font option names
  use the default interface font so they remain readable.
- The Codex reset forecast chip in the provider row must not fetch on mount and must
  pass `nestedInDialog` for its dialog: [../codex-reset/AGENTS.md](../codex-reset/AGENTS.md).

## Agent Roles

Roles are read and written from Settings, mentioned from the composer, and
resolved by CLI MCP creation, so these are cross-surface rules rather than
component details.

- Agent Roles are one `agentRole` row family in the same workspace Flock document, not a
  private and a shared catalog: sharing is an ordinary update of `visibility` on the row.
  A Role stores no secret — no API key, MCP selection, or memory — and
  `isSensitiveAgentRoleConfigOptionKey` is applied on read as well as on write,
  because a workspace row reaches every member's client. It DOES pin the permission
  mode, as `runConfig.modeId` for legacy ACP modes or the agent's own `_permission`
  option: permission is a run-config value the agent publishes, not a secret, and a
  Role that left it out would not be the whole configuration it claims to be. So the
  composer drops its separate permission button while such a Role is selected. A Role
  may therefore pin a warning-tone mode (full access / skip permissions), which every
  surface that hides the permission control must keep visibly marked; what stays out
  of scope is a Role-level auto-approval POLICY. Settings and mention discovery use
  `canReadAgentRole`/`canManageAgentRole`; MCP creation resolves an explicit Role id from
  the workspace catalog without requiring a mention-scoped authorization record.
- A Role never falls back. `machineId + agentConfigId` bind the execution site exactly;
  when the machine, config, or a stored model/mode is unavailable the Role stays listed
  with the precise reason and stops being mentionable. MCP creation resolves the current
  workspace catalog row by `agentRoleId` before Operation acceptance; the canonical Prompt,
  target, Role revision, and dispatch config are frozen into the accepted Operation so a
  later edit or delete cannot change its recovery or retry. `SessionMeta.agentRoleId` /
  `agentRoleRevision` record where a Session came from and are display-only.

## Workspace ownership

- Ownership transfer is an owner-only danger-zone slot shared by desktop and mobile.
  `workspace-ownership-transfer.tsx` collects an existing member and exact workspace
  name, then calls the cloud mutation through `account-setting.tsx`. Refresh session
  and active organization after success; cache refresh failure must not claim transfer
  failed. Card changes use the billing Portal separately; transfer keeps the current card.

## Shared editors and Prompt Shortcuts

- Reuse `emoji-field.tsx` and `form-primitives.tsx` across Role, MCP and Shortcut
  editors. `AutoGrowTextarea` starts at one row and remeasures on width changes.
- `promptShortcutsFeatureEnabledAtom` requires Developer mode and a default-off
  Beta opt-in. Gate navigation, direct panels, discovery and runtime together;
  disabling never deletes saved data.
- `prompt-shortcuts-setting.tsx` owns list/editor state, keyed by account/workspace
  to fence stale drafts and reads. Storage/publication belongs to the provider and
  shared domain. Resolve scope labels once for the whole panel.
- `prompt-shortcut-form.tsx` is presentational: scope starts empty, sharing private;
  name follows through to slug only until a new Shortcut's slug is manually edited.
  Templates contain no variables or invocation parameters; `!{name}` is literal.
- `prompt-shortcut-scope.tsx` orders Project → Machine → Agent. Unset axes show
  Workspace scope, never shared visibility. Emoji lives in the bounded shared
  schema/index and falls back to `DEFAULT_PROMPT_SHORTCUT_EMOJI`.
- Explicit scope changes remount the source-owning textarea with CURRENT semantic
  ranges, never the saved revision's ranges. Template mode disables token-scanning
  hydration, Sessions, recursive Shortcuts and ACP commands. Skills load on menu
  activation.
- Warnings compare indexed dependencies to saved scope; they do not claim live
  availability. Publication is background work: local save/delete remain enabled
  while pending or offline. Only local I/O disables duplicate actions; pending is
  durable but not advertised or synced. Retry belongs to the runtime.
- Other members' shared Shortcuts open read-only in the same shell; no copy-to-mine
  action exists. This temporary feature has no dedicated Storybook or test suite;
  retain general composer/mention coverage.
