# Repository guidelines

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

## Context maintenance

- Before work, read scoped `AGENTS.md`, relevant Specs, active notes, `.agents/docs/`,
  and module READMEs; archives are historical, not current authority.
  Read `.github/AGENTS.md` before PR/Issue work.
- Specs express intent, docs explain implementation, notes explain decisions.
  Check code and evidence: distinguish bugs, stale docs, and unimplemented intent.
  Never change a Spec to justify a bug; separate intent, inspection, and test results.
- Changed intent/guarantees MUST update the [Spec](specs/AGENTS.md) as `draft`.
  `approved` requires linked human approval of that revision; `outdated` needs review.
  Only meaning-preserving editorial changes may retain approval.
- Non-trivial work MUST add/update an [Agent Note](.agents/notes/AGENTS.md#when-to-write)
  in the same PR; substantial research/design conclusions also require a note
  without a PR. Reuse the owning note; link different decisions. Only mechanical/local
  edits without changed decisions are exempt. Proposals stay `proposed`.
- Update affected docs/READMEs. Run `pnpm run docs status` at start, `pnpm run docs check`
  at finish; review SHA-protected changes before confirming. Checks prove neither
  product correctness nor approval. [Details](.agents/README.md).
- Translation may follow later; it never grants approval. Keep private records private.
  For read-only tasks, report deferred documentation updates instead of writing.
- Invariants stay in the nearest `AGENTS.md` (<8 KiB; new scopes need `CLAUDE.md`
  symlinks), not in explanatory docs or notes.

## Community contributions

One-shot: Lody team if the user says so or GitHub login is `zxch3n`,
`Leeeon233`, or `wibus-wee`; otherwise community. Community PRs stay under
1000 changed lines unless a maintainer assigned the linked Issue. Larger
work: file an Issue with analysis; wait to be assigned. `.github/AGENTS.md`.

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
- Daemon-backed workflows negotiate versions through
  `MachineMeta.protocolCapabilities`; never infer from the CLI release. Missing
  capabilities mean unsupported. Set and version checks share one binding in
  `packages/shared/src/machine-protocol-capabilities.ts` so a key never travels
  without its version.
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
- MCP/Role catalog writes resolve on local Flock durability, followed by explicit
  upload. Settings neither await nor report upload; upload failure must not fail or
  roll back a durable write. CLI reports its sync result. See
  [catalog explanation](.agents/docs/workspace-catalog-durability.md).
- Roles use one workspace Flock `agentRole` family; sharing updates `visibility`.
  Store no secrets, API keys, MCP selections, or memory; apply
  `isSensitiveAgentRoleConfigOptionKey` on read and write. Roles pin permission via
  `runConfig.modeId` or `_permission`; hide the separate composer permission button
  when pinned, but keep warning-tone modes visibly marked on every such surface.
  Role-level auto-approval policy is out of scope. Settings/mentions use
  `canReadAgentRole`/`canManageAgentRole`; MCP resolves explicit Role ids from the
  catalog without requiring mention-scoped authorization.
- Roles bind exact `machineId + agentConfigId`, never fall back, and remain listed
  with precise reasons but unmentionable when machine/config/model/mode is unavailable.
  Before Operation acceptance, MCP resolves the current `agentRoleId` row and freezes
  canonical Prompt, target, Role revision, and dispatch config into the Operation;
  edits/deletion cannot change recovery or retry. `SessionMeta.agentRoleId` and
  `agentRoleRevision` are display-only creation provenance.

`pnpm check:public-boundary` is the executable repository boundary and must pass
after changing package scope or cloud/local composition.

## Project map

See the [repository map](README.md#repository).

## Checks and commits

Node.js 22+ and the pnpm in `package.json`. `pnpm install`; nested checkouts
skip it. Standalone work uses a separate clone. `pnpm start:local` is desktop;
root `pnpm build` is the same local composition. Before commit: `pnpm check`
and `pnpm format` (if skipping tests, report type/build/static checks).
Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `test:`); AI
commits end with `Model: <runtime-model-id>`. Manifest changes update
`pnpm-lock.yaml`.

## Test quality

No real sleeps, wall-clock races, network, machine load, or scheduler luck.
Use explicit signals, injected clocks, fake timers, and deterministic fixtures.
Assert observable behavior, not mock call counts.

## Editing discipline

Keep changes traceable to the request. Preserve unrelated user work. Prefer a
small explicit contract over hidden fallbacks; remove only unused code. Update
the nearest public `AGENTS.md` when an invariant or boundary changes.

## Code Review Rules

Report only P0/P1. Security first. If the PR solves the linked Issue and no
P0/P1 remains, react 👍. See `.github/codex-review.md`.

- P0: exploitable security, secret leak, auth/capability bypass, data loss, or
  a broken public/cloud/local boundary.
- P1: likely shipped breakage or a durable catalog/session contract violation.
- Skip style, nits, P2+, extra tests, and duplication under 100 lines.
