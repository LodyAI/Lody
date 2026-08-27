# Repository guidelines

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

## Context maintenance

Read every `AGENTS.md` from the repository root to the file being changed.
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
  Flock write; an explicit upload follows. Settings resolve on local durability and neither
  await nor report that upload: the row already exists and a joined room can carry it.
  Never report or roll back a durable write because upload failed, or show an unactionable
  upload banner. The CLI still reports its own sync result.
- Agent Roles are one `agentRole` row family in the same workspace Flock document, not a
  private/shared split; sharing updates `visibility`. A Role stores no API key, MCP
  selection, memory, or other secret, so apply `isSensitiveAgentRoleConfigOptionKey` on
  read and write because every member receives workspace rows. A Role DOES pin permission
  through legacy `runConfig.modeId` or the agent's `_permission`; this published run value
  is not secret, and the composer hides its permission button while a Role is selected.
  Keep pinned warning modes (full access / skip permissions) visibly marked wherever that
  button is hidden; Role-level auto-approval policy remains out of scope. Settings and
  mentions use `canReadAgentRole`/`canManageAgentRole`; MCP creation resolves an explicit
  workspace Role id without a mention-scoped authorization record.
- A Role never falls back. `machineId + agentConfigId` bind the execution site exactly;
  if its machine, config, model, or mode is unavailable, keep it listed with the precise
  reason but not mentionable. Before accepting an Operation, MCP creation resolves the
  current `agentRoleId` row and freezes its canonical Prompt, target, revision, and dispatch
  config so later edits/deletion cannot affect recovery or retry. `SessionMeta.agentRoleId`
  and `agentRoleRevision` are display-only provenance.

`pnpm check:public-boundary` is the executable repository boundary and must pass
after changing package scope or cloud/local composition.

## External contributions

Before implementing an external contribution, an authoring Agent opens the matching Lody
Issue and waits for a maintainer to explicitly agree on scope and approach. Creating or
linking an Issue is not approval. The Agent tells its author-side user about that gate,
public Context handoff, and the shared seven-day correction window for invalid bodies or
oversized PRs without an Issue URL; it never invents notice or agreement.

## Project map

- `apps/cli`: agent execution, local persistence, Machine RPC, Code Collab
- `apps/electron`: desktop shell and bundled CLI lifecycle
- `packages/components`: shared React UI
- `packages/platform`: provider and capability contracts plus local defaults
- `packages/cloud-api`: public optional-cloud client contract
- `packages/shared`: schemas, protocols, and cross-runtime utilities
- `packages/loro-streams-rpc`: public Streams RPC protocol/client
- `packages/acp-extension-core`: shared public ACP extension contracts
- `packages/acp-extension-kimi`: independently built Kimi runtime source and Lody ACP extensions
- `site-docs`: documentation site

## Checks and commits

Use Node.js 22+ and the pnpm version pinned in `package.json`.

- Install dependencies with `pnpm install`.
- In a parent pnpm workspace, the parent owns installation; the preinstall guard
  rejects a nested install that would mix virtual stores. Use a separate clone
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

## Test quality

Tests never depend on real sleeps, wall-clock races, network, machine load, or
scheduler luck. Use signals, injected clocks, fake timers, and deterministic
fixtures; assert observable behavior at the lowest realistic boundary.

## Editing discipline

Keep changes traceable to the request. Preserve unrelated user work. Prefer a
small explicit contract over hidden fallback behavior, and remove only code
made unused by the current change. Update the nearest public `AGENTS.md`
whenever an invariant or repository boundary changes. Do not copy internal
design records into this repository.
