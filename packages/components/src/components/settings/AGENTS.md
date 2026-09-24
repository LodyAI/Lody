# Settings surfaces

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
Parent `AGENTS.md` files also apply.

Settings owns the workspace catalog surfaces (Providers, MCP servers, Agent
Roles). The catalog's durability rule — a local Flock write is durable, and the
upload that follows it is not something a settings surface waits on, reports, or
rolls back — is in the root [AGENTS.md](../../../../../AGENTS.md).

## Layout and components

- Desktop overlay close is `absolute` on the RIGHT pane only, equal `top`/`right`
  inset, no close row. Right-pane `padding-right` keeps chrome off that column;
  apply it inside the scroll area so the scrollbar stays flush with the pane edge.
- Light settings surfaces are white, not gray-on-gray: `data-settings-surface`
  maps `--card` to `--popover`; list rows use `SETTINGS_ROW_CARD_CLASS`; header
  bands fill only in dark. No new gray card fills.

- `share-management-setting.tsx` lists published static copies via the scoped cloud
  query. Ordinary members see their publications; admins see the workspace inventory.
  Draft uploads are not published shares. Reuse `useSessionShareLinkActions` for
  copy/reset/revoke; settings must never reconstruct a credential from cloud data.
  Key state by user/workspace and gate the whole surface with `teamSharing`.
  A share outlives its source, so both "View conversation" and "Update deployment"
  require the session in the local metadata cache; opening it closes the desktop
  settings overlay. Rationale:
  [share inventory jump](../../../../../.agents/notes/implemented/feature/2026-09-15-share-inventory-session-jump.md).

- Desktop Settings > Projects is a two-pane catalog: left GitHub/machines,
  right the folders on the selected source. Clicking a folder opens a nested
  modal of stacked `CompactSection`s — never inline the editor beside the list.
  Mobile keeps the previous stacked list. Local-project deletion reuses
  `useRemoveLocalProject` / `RemoveLocalProjectDialog` (nested overlay like MCP);
  do not add a second confirm. Pending removal stays listed until the owning
  machine finishes. Do not RPC-probe worktree/skills on offline remotes, and
  never surface `machine_rpc_unavailable` as an editor error. The GitHub source
  row must paint from `lody:githubReposCache` on first frame; do not wait on
  `listWorkspaceReposWithStatus` to decide whether GitHub exists.
- A settings row (`compact-layout.tsx`) is one grid: the label column takes the
  remaining space and the control column hugs its content. Never size either column
  from a viewport breakpoint — settings render in a panel far narrower than the window,
  and the panel clips its overflow, so a `md:`-width label column silently hides the
  control. Copy is `font-normal` (size/muted, not weight).
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
- Usage day details persist bounded snapshots per auth session, workspace, and
  date. Reuse for one hour; refresh expired selections without blanking cached
  data. Preserve auth/capability gates; see [contract](../../../../../specs/usage-detail-cache.md).
- Interface/terminal fonts exclude symbol families in `lib/local-fonts.ts`; option
  names stay on the default interface font. Font size is five named tiers writing
  `--ui-font-size`. Font ligatures is a boolean after the Terminal section, writing
  `--lody-font-ligatures` for conversation, code, and tool output.
- The Codex reset forecast chip in the provider row must not fetch on mount and must
  pass `nestedInDialog` for its dialog: [../codex-reset/AGENTS.md](../codex-reset/AGENTS.md).
- The usage share card is a fixed-format report, not a second `ChatShareCard`:
  exact pixel aspects, period = the page range, headline = that range's total.
  Derive every number through `usage-share-stats.ts` (stamp the metric on the
  stats; never pass it beside them). Money: `formatUsdCompact` headline,
  `formatUsdTight` cells — never `truncate`. Tokens/member anonymity are
  defaults; cost substitutes for tokens; member slices never include email.
  Both share cards use `lib/share-image-export.ts` and
  `components/share-theme-scope.ts`; do not fork either.
  `StatsSettingsView` keeps the entry behind the opt-in `shareCard` prop with a lazy
  dialog, because the public landing reuses that view. Typography and spacing come
  from the card's own `TEXT`, `PAD_X`, and `RHYTHM` constants — never a fresh
  `text-[…]` or an off-grid padding. `PAD_X` binds the footer too, so every band
  shares one left edge. `ASPECT_SIZE` includes the backdrop; size against the
  48px-shorter framed case. Keep every band but the headline `shrink-0`.
  The graphic follows the range —
  hour skyline, day-by-hour grid, or the 53-week calendar, matching the Usage
  screen — and every kind must fit the one `GRAPHIC_H` box so card height never
  depends on range. Leave the space beside the headline empty.

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

- Nightly downloads live below Download apps in desktop/Web About.
