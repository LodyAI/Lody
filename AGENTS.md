# Repository guidelines

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

## Context maintenance

Read every `AGENTS.md` from the repository root to the file being changed.
Before starting work intended for a pull request, or creating or editing a
pull request or issue, read `.github/AGENTS.md`.
Record public contributor invariants in the narrowest relevant `AGENTS.md`.
Internal context, plans, specifications, and task records stay in the private
repository. Keep each `AGENTS.md` under 8 KiB and add a matching `CLAUDE.md`
symlink for new scoped files.

## Repository boundary

This is the standalone public source tree. It includes `apps/{cli,electron}`
and the packages they consume. It intentionally excludes hosted backend
implementations, deployment/operator configuration, billing operations,
private service secrets, and the Web and mobile app sources.

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

- `apps/cli`: agent execution, local persistence, Machine RPC, Code Collab
- `apps/electron`: desktop shell and bundled CLI lifecycle
- `packages/components`: shared React product/workspace UI
- `packages/platform`: provider and capability contracts plus local defaults
- `packages/cloud-api`: public optional-cloud client contract
- `packages/shared`: schemas, protocols, and cross-runtime utilities
- `packages/loro-streams-rpc`: public Streams RPC protocol/client
- `packages/acp-extension-core`: shared public ACP extension contracts
- `packages/acp-extension-kimi`: independently built Kimi runtime source and Lody ACP extensions
- `site-docs`: public documentation site

## Checks and commits

Use a Node.js release with Node-API 10 (22.14+, 23.6+, or later) and the pnpm
version pinned in `package.json`.

- Install dependencies with `pnpm install`.
- When this checkout is embedded in a parent pnpm workspace, that parent owns
  dependency installation. The public preinstall guard rejects a second nested
  install because it would mix virtual-store identities. Use a separate clone
  for standalone public development.
- The canonical desktop command is `pnpm start:local`; it rebuilds both the
  bundled CLI and local OSS renderer before launch. Root `pnpm build` builds
  the same local desktop composition.
- Before committing, normally run `pnpm check` and `pnpm format`.
- If a user explicitly asks to skip tests, do not run test commands; report the
  narrower type/build/static validation that was performed.
- Commit subjects use Conventional Commit prefixes such as `feat:`, `fix:`,
  `docs:`, `chore:`, and `test:`.
- AI commits end with `Model: <runtime-model-id>`.
- CI installs with `pnpm install --frozen-lockfile`, so a manifest change must
  land with its `pnpm-lock.yaml` update.

## Test quality

Tests must not depend on real sleeps, wall-clock races, network access, machine
load, or scheduler luck. Use explicit signals, injected clocks, fake timers,
and deterministic fixtures. Assert observable behavior at the lowest realistic
boundary, not implementation details or mock call counts.

## Editing discipline

Keep changes traceable to the request. Preserve unrelated user work. Prefer a
small explicit contract over hidden fallback behavior, and remove only code
made unused by the current change. Update the nearest public `AGENTS.md`
whenever an invariant or repository boundary changes. Do not copy internal
design records into this repository.
