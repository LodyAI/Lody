# Repository rules

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
Map: [README.md](README.md#repository).

## Context and documentation

- Read the applicable ancestor/scoped `AGENTS.md` files and task-relevant Specs,
  active notes, `.agents/docs/`, and module READMEs. Follow the required topic
  links below when their trigger applies, including changes outside the owner's
  directory. Archives are history, not current authority.
- Specs express intent, docs explain implementation, notes record decisions.
  Distinguish bugs, stale docs, and unimplemented intent using code and evidence;
  never change a Spec to justify a bug.
- Before creating or editing a Spec, read [Spec rules](specs/AGENTS.md), including
  status and approval requirements. Reserve Specs for consequential decisions
  needing human review; prefer an existing Spec. Ordinary fixes need no new Spec.
- Non-trivial work MUST add/update its [Agent Note](.agents/notes/AGENTS.md#when-to-write)
  in the same PR; substantial research/design needs a note without a PR too.
  Only mechanical/local edits without changed decisions are exempt. Link distinct
  decisions, keep proposals `proposed`, and report deferred notes for read-only work.
- Update affected docs/READMEs. Run `pnpm run docs status` at start and
  `pnpm run docs check` at finish; review SHA-protected changes before confirming.
  Checks and translations establish neither correctness nor approval; translation
  may follow later. See [document maintenance](.agents/README.md).
- Keep PR docs compact: consolidate decisions, evidence and limits; avoid fix/run logs.
  Follow [submission consolidation](.agents/AGENTS.md#documentation-at-submission).
- Keep binding rules in the nearest `AGENTS.md` (<8 KiB; new scopes need a
  `CLAUDE.md` symlink). Keep explanations and rationale in their owning docs/notes.

## Effect reference

For Effect work, use the [Effect skill](.agents/skills/effect-ts/SKILL.md) to select
review, debug, feature/fix or migration mode. Read the consuming package's resolved
`effect/AGENTS.md` completely once per version in the current context; then follow
task-relevant links and source. Preserve locked versions and behavioral acceptance.
Explicit v3 migrations also use the
[migration skill](.agents/skills/effect-v3-to-v4/SKILL.md).

Lody is migrating lifecycle code to native Effect v4. For feature/fix work touching
effectful modules, assess a small native migration; prefer it in the same PR when
it directly helps the task, actual dependencies are ready, and the unit can be
completed and behavior-tested within a small reviewable scope. About 500 additional
changed lines is a sizing guide, not an acceptance or approval gate. Keep pure
computation ordinary and preserve behavior outside the requested change. Do not
extend the migration into unfinished dependency chains.
For migration scope, read relevant [charter](.agents/notes/proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.md#unit-ledger)
rows and the [selection guide](.agents/docs/cli-effect-ts.md#small-migrations-during-feature-and-fix-work).
Apply the charter's completion criteria; update its unit ledger when a migration
changes dependencies, native boundaries, consumers or ownership.

## Repository boundary

- Public source: `apps/{cli,electron}` and their packages. Exclude hosted backends,
  operator/billing config, private secrets/records, and Web/mobile app sources.
  Never commit captured user/agent transcripts; fixtures must be synthetic.
- Never depend on `@lody/convex`, private workspace packages, or generated backend
  API declarations. Optional-cloud protocol names/DTOs belong in `packages/cloud-api`;
  shared product code uses `packages/platform` capabilities and ports.
- The OSS desktop is local-only; authenticated product-cloud requests are forbidden.
  Public managed-runtime downloads are the exception. Shared packages stay
  platform-neutral; local telemetry is hard-disabled.
- Before changing composition, capability-gated settings, telemetry, or runtime
  downloads, read [platform contracts](packages/platform/AGENTS.md).
- Before changing daemon protocol negotiation, MCP/Role catalogs or their UI
  consumers, per-turn MCP selection, or Role creation/dispatch, read [shared contracts](packages/shared/AGENTS.md).
- `packages/acp-extension-kimi` and `packages/acp-extension-pi` stay outside the root pnpm graph in isolated
  submodule workspace; consume only its separately built, checksummed managed-runtime
  artifact and versioned ACP contract. Shared ACP extension contracts belong in the
  public `LodyAI/acp-extension-core` submodule, consumed through the root workspace;
  never duplicate them locally.
- Magpie: desktop confirmation or explicit local CLI import; loopback mappings and public token.
  Keep gateway metadata outside env and catalogs under Lody data, never user profiles.
  [Contract](specs/magpie-provider-import.md).
- Pi provider migration requires owner confirmation and the target's `builtinPi`
  protocol capability. Preserve provider IDs and settings; never convert legacy
  native session IDs. Contract: [builtin Pi](specs/builtin-pi.md).
- Viewer packaging/version changes must follow its [rules](packages/code-review-viewer/AGENTS.md).
  Package-scope or cloud/local composition changes require `pnpm check:public-boundary`.

## Contributions and checks

- Identify once: Lody team if the user says so or GitHub login is `zxch3n`,
  `Leeeon233`, or `wibus-wee`; otherwise community. Before planning a community
  contribution, read [.github/AGENTS.md](.github/AGENTS.md) for size/assignment rules.
  Read it before any PR/Issue work as well.
- Node.js 22.23.4+ (22.x), 24.22.1+ (24.x), or 26.12.1+ (26.x), with Node-API 10+; use the pnpm in `package.json`. See the
  [runtime security decision](.agents/notes/implemented/bug-fix/2026-10-22-node-security-runtime-floor.md).
  `pnpm install` (nested checkouts skip it); standalone work uses a separate clone.
  `pnpm start:local` starts the desktop; root `pnpm build` uses the same local composition.
- Before commit: `pnpm check` and `pnpm format`. Root packages share `.oxfmtrc.json`;
  ACP submodules stay independently formatted. If tests are skipped, report
  type/build/static checks. Manifest changes update `pnpm-lock.yaml`.
- Packages invoking Oxfmt declare it in their own devDependencies: an embedded
  parent workspace does not install this repository's root package.
- Conventional Commits: `feat:`, `fix:`, `docs:`, `chore:`, `test:`. AI commits
  end with `Model: <runtime-model-id>`.
- Tests use explicit signals, injected clocks, fake timers, and deterministic
  fixtures; no real sleeps, wall-clock races, network, machine load, or scheduler
  luck. Assert observable behavior, not mock call counts.
- Delete shallow tests in the changed scope: source-string/regex assertions,
  mock-call-only checks and duplicates that cannot detect a behavioral regression.
  Test the real boundary and resulting state, including failure paths; retain
  meaningful compile-failure contracts. Extend the owning suite instead of adding
  a file per small fix. Do not delete behavioral coverage merely to reduce counts.
- Before changing teardown, retry, fencing or readiness, read
  [failure containment](.agents/docs/failure-containment.md); preserve verified safe
  reuse and bounded ownership while isolating independent work.
- Keep edits traceable to the request and preserve unrelated work. Prefer explicit
  contracts over hidden fallbacks; remove only unused code. Update the nearest
  public `AGENTS.md` when an invariant or boundary changes.

## Code Review Rules

Report only P0/P1, security first. If the PR solves the linked Issue and no P0/P1
remains, react 👍. Details: [.github/codex-review.md](.github/codex-review.md).

- P0: exploitable security, secret leak, auth/capability bypass, data loss, or a
  broken public/cloud/local boundary.
- P1: likely shipped breakage, including a failure-containment regression, or a
  durable catalog/session contract violation.
- Skip style, nits, P2+, extra tests, and duplication under 100 lines.
