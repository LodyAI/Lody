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
- The usage share card is a fixed-format report, not a second `ChatShareCard`: its two
  aspects are exact pixel sizes, its period is the page's selected range, and its
  headline is that range's timeline total, so page and image cannot disagree. Derive
  every number through `usage-share-stats.ts`. Cost and member identification are each
  off by default, and member slices carry display name and avatar only — never an
  email. Both share cards use the one capture pipeline in `lib/share-image-export.ts`
  and the one theme pinning in `components/share-theme-scope.ts`; do not fork either.
  `StatsSettingsView` keeps the entry behind the opt-in `shareCard` prop with a lazy
  dialog, because the public landing reuses that view. Typography and spacing come
  from the card's own `TEXT`, `PAD_X`, and `RHYTHM` constants — never a fresh
  `text-[…]` or an off-grid padding. `PAD_X` binds the footer too, so every band
  shares one left edge. `ASPECT_SIZE` is the whole exported image including the
  backdrop, so a framed card is 48px shorter — size the layout against the framed
  case, and keep every band but the headline `shrink-0` so a card that does not fit
  overflows visibly instead of eating its own padding. The space beside the headline
  carries the range's own profile from `stats.shape`, not a brand watermark — four
  decoration attempts failed there before content replaced them.

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
