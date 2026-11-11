# Repository rules

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

## Where to read

Read the ancestor and scoped `AGENTS.md` files for the paths you change, then
the Specs, `.agents/docs/` pages, module READMEs, and the notes they link.
Search notes before reversing a recorded decision. Triggers below also bind
callers outside the owner's directory. [README.md](README.md#repository) lists
directories and is not the rule source. Archives are history, not current authority.

- Encrypted workspaces, account pairing, recovery, ledger identity, key delivery,
  machine sharing, or execution during a backend outage: read
  [platform E2EE](packages/platform/AGENTS.md#e2ee-workspace-control),
  [e2ee-core](packages/e2ee-core/AGENTS.md), and the
  [bootstrap guide](.agents/docs/e2ee-workspace-bootstrap.md). Personal-device
  hosts also read [e2ee-client](packages/e2ee-client/AGENTS.md). Machine-service
  policy also reads [e2ee-machine-sharing](packages/e2ee-machine-sharing/AGENTS.md).
- Session history, quotes, steer, queued input, delegation, or MCP/Role catalogs
  and their UI: read [shared contracts](packages/shared/AGENTS.md). MCP tool
  acceptance and replies also read [CLI MCP](apps/cli/src/mcp/AGENTS.md).
- Automations, including external checks and cross-session control: read
  [automations](apps/cli/src/automations/AGENTS.md).
- Native iOS or Android: read [mobile](apps/mobile/AGENTS.md), then that platform's file.
- Desktop composition, packaging, quit, or the embedded CLI: read
  [electron](apps/electron/AGENTS.md).
- Provider authentication, Lody Agent connections, or advertised ACP sign-in: read
  [agent](apps/cli/src/agent/AGENTS.md) and
  [Lody Agent setup](packages/components/src/components/settings/README.md#lody-agent-setup).
- Code Collab diffs or content-addressed snapshots: read
  [turn-diff-store](packages/turn-diff-store/AGENTS.md) and
  [code-collab](apps/cli/src/lib/code-collab/AGENTS.md).
- Composition, capability-gated settings, telemetry, or managed-runtime downloads:
  read [platform contracts](packages/platform/AGENTS.md).

## Context and documentation

- A note you rely on that is stale, unlinked, or in the wrong lifecycle is fixed in
  the same PR ([maintenance on read](.agents/notes/AGENTS.md#maintenance-on-read)).
- Specs express intent, docs explain implementation, notes record decisions.
  Distinguish bugs, stale docs, and unimplemented intent using code and evidence;
  never change a Spec to justify a bug.
- Before creating or editing a Spec, read [Spec rules](specs/AGENTS.md). Reserve
  Specs for consequential decisions that need human review, and prefer an existing
  Spec. Ordinary fixes need no new Spec.
- Add or update an [Agent Note](.agents/notes/AGENTS.md#when-to-write) in the same
  PR only for durable rationale. A fix that is merely done belongs in its PR and
  test. Every new note runs the [supersession check](.agents/notes/AGENTS.md#supersession);
  keep implemented notes' cited facts current, and report deferred notes for read-only work.
- Update affected docs and READMEs. Run `pnpm run docs status` at start and
  `pnpm run docs check` at finish, and review SHA-protected changes before confirming.
  Checks and translations establish neither correctness nor approval. See
  [document maintenance](.agents/README.md).
- Keep PR docs compact: consolidate decisions, evidence and limits; avoid fix/run logs.
  Follow [submission consolidation](.agents/AGENTS.md#documentation-at-submission).
- Keep binding rules in the nearest `AGENTS.md` as complete sentences (new scopes
  need a `CLAUDE.md` symlink); over a [word ceiling](.agents/README.md#word-ceilings),
  relocate a topic or raise the ceiling with a reason, never compress into fragments.
  Keep explanations and rationale in their owning docs/notes.

## Effect reference

For Effect work, use the [Effect skill](.agents/skills/effect-ts/SKILL.md) to select
review, debug, feature/fix or migration mode, including its version-matched
`effect/AGENTS.md` read. Explicit v3 migrations also use the
[migration skill](.agents/skills/effect-v3-to-v4/SKILL.md).

Lifecycle code is moving to native Effect v4. When a feature or fix touches an
effectful module, assess a small native migration and prefer it in the same PR
when it directly helps, real dependencies are ready, and the unit stays reviewable.
Do not extend it into unfinished dependency chains. Pure computation stays ordinary.
Scope, the sizing guide, and completion criteria are in the
[selection guide](.agents/docs/cli-effect-ts.md#small-migrations-during-feature-and-fix-work).
Update the [charter ledger](.agents/notes/proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.md#unit-ledger)
when migration facts change.

## Repository boundary

- Public source: `apps/{cli,electron,mobile}` and their packages. Exclude hosted backends,
  operator/billing config, private secrets/records, and private Web app sources.
  Never commit captured user/agent transcripts; fixtures must be synthetic.
- Never depend on `@lody/convex`, private workspace packages, or generated backend
  API declarations. Optional-cloud protocol names/DTOs belong in `packages/cloud-api`;
  shared product code uses `packages/platform` capabilities and ports.
- Native mobile clients keep independent builds and public cloud protocol clients;
  they must not import private backend code.
- The OSS desktop is local-only; authenticated product-cloud requests are forbidden.
  Public managed-runtime downloads are the exception. Shared packages stay
  platform-neutral; local telemetry is hard-disabled.
- `packages/acp-extension-kimi` and `packages/acp-extension-pi` stay outside the root
  pnpm graph as isolated submodules. Consume each only through its separately built,
  checksummed managed runtime and the versioned ACP contract. Shared ACP extension
  contracts belong in the public `LodyAI/acp-extension-core` submodule, consumed
  through the root workspace; never duplicate them locally.
- Before changing Magpie import or builtin Pi migration, read
  [Magpie](specs/magpie-provider-import.md) and [builtin Pi](specs/builtin-pi.md).
  Keep their confirmation, loopback, identity, and catalog constraints.
- Viewer packaging/version changes must follow its [rules](packages/code-review-viewer/AGENTS.md).
  Package-scope or cloud/local composition changes require `pnpm check:public-boundary`.

## Contributions and checks

- Identify once: Lody team if the user says so or GitHub login is `zxch3n`,
  `Leeeon233`, or `wibus-wee`; otherwise community. Before planning a community
  contribution, read [.github/AGENTS.md](.github/AGENTS.md) for size/assignment rules.
  Read it before any PR/Issue work as well.
- Use the Node range in `package.json` `engines` and the pnpm version in `packageManager`, with Node-API 10+. See the
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
- Lody lint, typecheck, formatting and test commands skip all nested ACP adapter submodules (`packages/acp-extension-*` below the public root). Their internal tests are maintained independently; retain Lody-owned integration and packaging checks.

- Keep tests for concrete Lody product, domain, installation, compilation, packaging
  or release behavior. Generic helper correctness is not sufficient. Delete shallow
  tests in the changed scope: source-string or regex assertions, mock-call-only
  checks, and duplicates that cannot catch a behavioral regression. Test the real
  boundary and resulting state, including failures, and keep compile-failure contracts.
  Extend the owning suite. Do not add a file per small fix, and do not drop behavioral
  coverage to reduce counts.
- Before changing teardown, retry, fencing or readiness, read
  [failure containment](.agents/docs/failure-containment.md); preserve verified safe
  reuse and bounded ownership while isolating independent work.
- Keep edits traceable to the request and preserve unrelated work. Prefer explicit
  contracts over hidden fallbacks; remove only unused code. Update the nearest
  public `AGENTS.md` when an invariant or boundary changes.
- Lody provides tools. Text it sends to agents (quick-action and synthetic prompts,
  receipts, MCP descriptions and replies, skills, examples) carries the user's request
  and facts the agent cannot discover. Never add workflow steps or review, verify,
  re-check or commit instructions, or their negations, that the user did not ask for:
  each delivery would steer or repeat agent work.

## Code Review Rules

Report only P0/P1, security first. If the PR solves the linked Issue and no P0/P1
remains, react 👍. Details: [.github/codex-review.md](.github/codex-review.md).

- P0: exploitable security, secret leak, auth/capability bypass, data loss, or a
  broken public/cloud/local boundary.
- P1: likely shipped breakage, including a failure-containment regression, or a
  durable catalog/session contract violation.
- Skip style, nits, P2+, extra tests, and duplication under 100 lines.
