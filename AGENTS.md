# Repository guidelines

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

## Context maintenance

Read every `AGENTS.md` from root to the changed file; read `.github/AGENTS.md`
before PR/Issue work. Invariants live in the nearest `AGENTS.md` (under 8 KiB;
new scopes need `CLAUDE.md` symlinks). Per
[document maintenance](.agents/README.md), Specs need human review while
`.agents/` and directory READMEs explain. Private records stay private.

## Repository boundary

Standalone public source tree: `apps/{cli,electron}` and the packages they
consume. Excludes hosted backends, operator/billing config, private secrets,
and Web/mobile app sources.

- Never add a dependency on `@lody/convex`, a private workspace package, or a
  generated backend API declaration.
- Public optional-cloud protocol names/DTOs live in `packages/cloud-api`.
- Shared product code uses `packages/platform` capabilities and ports.
- Settings must represent real platform support: local hides cloud usage and
  PR-driven auto-archive, and omits machine selection when `remoteMachines` is
  absent. Gate entries and their background work through capabilities rather
  than build-kind or environment checks.
- Shared packages stay platform-neutral. The public Electron composition
  selects `local` explicitly; private Web/mobile entries and cloud composition
  roots may inject `cloud` without forking those shared packages.
- The code-review-viewer build accepts `LODY_RELEASE_VERSION` for downstream
  immutable packaging; without it, the public package version is authoritative.
- The OSS desktop entry is local-only and must not make authenticated product-cloud requests;
  public managed-runtime artifact downloads are the explicit exception.
- An absent platform selector resolves to `local`; public build scripts must
  not accept or discover staging/production deployment presets.
- Local CLI, renderer, and Electron-main telemetry is hard-disabled even when
  unrelated PostHog variables exist in the caller's shell.
- Client workflows that require daemon support negotiate integer protocol versions through
  `MachineMeta.protocolCapabilities`; never infer support from the CLI release version. Missing
  capabilities mean legacy/unsupported. Advertised set and version checks share one binding in
  `packages/shared/src/machine-protocol-capabilities.ts` so a key never travels without its version.
- Managed runtime downloads default to the public R2-backed channel owned by
  `packages/platform/src/runtime-artifacts.ts`; local and cloud assembly must use that
  same constant. `LODY_RUNTIME_BASE_URL` is only an explicit mirror override.
- `packages/acp-extension-kimi` is an isolated submodule workspace. Do not add it
  to the root pnpm dependency graph; Lody consumes only its separately built,
  checksummed managed-runtime artifact and versioned ACP extension contract.
- `packages/acp-extension-core` is a public submodule workspace sourced from
  `LodyAI/acp-extension-core`. Keep shared ACP extension contracts there and consume
  them through the root pnpm workspace; do not duplicate those contracts locally.
- Never commit captured user/agent transcripts; fixtures must be synthetic.
- Workspace MCP has exactly two durable layers: catalog entries in the workspace Flock
  document and selected ids in each user turn input config. Do not add machine bindings.
  Preserve `mcpServerIds: []` as an explicit empty selection; dispatch must carry the
  driving turn's selection into ACP startup rather than rereading session history.
- Workspace catalog mutations (MCP servers and Agent Roles) are durable on the local
  Flock write and shared by an explicit upload that follows it. Settings surfaces resolve
  on durability and do not wait on or report that upload: the row already exists, the
  joined room carries the document when a one-shot upload cannot, and a banner about it is
  something the user can neither act on nor dismiss. What is forbidden is the opposite —
  reporting a durable write as failed, or rolling one back, because the upload did not go
  through. The CLI still reports its own sync result to the terminal.
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

`pnpm check:public-boundary` is the executable repository boundary and must pass
after changing package scope or cloud/local composition.

## Project map

`apps/cli` (agent, persistence, Machine RPC), `apps/electron` (desktop +
bundled CLI), `packages/components` (shared UI), `packages/platform` (ports),
`packages/cloud-api` (optional-cloud DTOs), `packages/shared` (schemas),
`packages/loro-streams-rpc`, `packages/acp-extension-{core,kimi}`, `site-docs`.

## Checks and commits

Use Node.js 22+ and the pnpm version pinned in `package.json`. Install with
`pnpm install`. A parent pnpm workspace owns nested checkouts; the public
preinstall guard rejects a second install. Use a separate clone for standalone
public development. `pnpm start:local` is the canonical desktop command; root
`pnpm build` is the same local composition. Before committing, normally run
`pnpm check` and `pnpm format`. If asked to skip tests, report the narrower
type/build/static validation instead. Conventional Commits (`feat:`, `fix:`,
`docs:`, `chore:`, `test:`); AI commits end with `Model: <runtime-model-id>`.
CI uses `pnpm install --frozen-lockfile`, so manifest changes update
`pnpm-lock.yaml`.

## Test quality

No real sleeps, wall-clock races, network, machine load, or scheduler luck.
Use explicit signals, injected clocks, fake timers, and deterministic fixtures.
Assert observable behavior, not mock call counts.

## Editing discipline

Keep changes traceable to the request. Preserve unrelated user work. Prefer a
small explicit contract over hidden fallbacks, and remove only code the change
makes unused. Update the nearest public `AGENTS.md` when an invariant or
repository boundary changes. Do not copy internal design records here.

## Code Review Rules

Report only P0/P1. Security first. If the PR solves the linked Issue and no
P0/P1 remains, react 👍. See `.github/codex-review.md`.

- P0: exploitable security, secret leak, auth/capability bypass, data loss, or
  a broken public/cloud/local boundary.
- P1: likely shipped breakage or a durable catalog/session contract violation.
- Skip style, nits, P2+, extreme edge cases, extra tests, and duplication
  under 100 lines of near-identical code in this diff. Leave lint to CI.
