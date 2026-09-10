# Repository guidelines

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
Repository map and entry points: [README.md](README.md#repository).

## Context and documentation

- Read the applicable ancestor/scoped `AGENTS.md` files and task-relevant Specs,
  active notes, `.agents/docs/`, and module READMEs. Follow the required topic
  links below when their trigger applies, including changes outside the owner's
  directory. Archives are history, not current authority.
- Specs express intent, docs explain implementation, notes record decisions.
  Distinguish bugs, stale docs, and unimplemented intent using code and evidence;
  never change a Spec to justify a bug.
- Changed intent/guarantees require a [Spec](specs/AGENTS.md) updated as `draft`.
  `approved` requires linked human approval of that revision; `outdated` needs
  review. Only meaning-preserving editorial edits may retain approval.
- Non-trivial work MUST add/update the owning [Agent Note](.agents/notes/AGENTS.md#when-to-write)
  in the same PR; substantial research/design also requires a note without a PR.
  Only mechanical/local edits without changed decisions are exempt. Link different
  decisions; proposals stay `proposed`. Read-only tasks report deferred updates.
- Update affected docs/READMEs. Run `pnpm run docs status` at start and
  `pnpm run docs check` at finish; review SHA-protected changes before confirming.
  Checks and translations prove neither correctness nor approval. Translation may
  follow later. Details: [document maintenance](.agents/README.md).
- Keep binding rules in the nearest `AGENTS.md` (<8 KiB; new scopes need a
  `CLAUDE.md` symlink). Keep explanations and rationale in their owning docs/notes.

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
- `packages/acp-extension-kimi` stays outside the root pnpm graph in its isolated
  submodule workspace; consume only its separately built, checksummed managed-runtime
  artifact and versioned ACP contract. Shared ACP extension contracts belong in the
  public `LodyAI/acp-extension-core` submodule, consumed through the root workspace;
  never duplicate them locally.
- Viewer packaging/version changes must follow its [rules](packages/code-review-viewer/AGENTS.md).
  Package-scope or cloud/local composition changes require `pnpm check:public-boundary`.

## Contributions and checks

- Identify once: Lody team if the user says so or GitHub login is `zxch3n`,
  `Leeeon233`, or `wibus-wee`; otherwise community. Before planning a community
  contribution, read [.github/AGENTS.md](.github/AGENTS.md) for size/assignment rules.
  Read it before any PR/Issue work as well.
- Node.js 22+; use the pnpm in `package.json`. `pnpm install` (nested checkouts
  skip it); standalone work uses a separate clone. `pnpm start:local` starts the
  desktop; root `pnpm build` uses the same local composition.
- Before commit: `pnpm check` and `pnpm format`. If tests are skipped, report
  type/build/static checks. Manifest changes update `pnpm-lock.yaml`.
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
- Keep PR documentation compact: update the owning Spec and Note instead of adding
  incremental fix/run-log documents. Consolidate redundant PR-local notes, retaining
  decisions, reproducible evidence and unresolved limits; repair inbound links.
- Keep edits traceable to the request and preserve unrelated work. Prefer explicit
  contracts over hidden fallbacks; remove only unused code. Update the nearest
  public `AGENTS.md` when an invariant or boundary changes.

## Code Review Rules

Report only P0/P1, security first. If the PR solves the linked Issue and no P0/P1
remains, react 👍. Details: [.github/codex-review.md](.github/codex-review.md).

- P0: exploitable security, secret leak, auth/capability bypass, data loss, or a
  broken public/cloud/local boundary.
- P1: likely shipped breakage or a durable catalog/session contract violation.
- Skip style, nits, P2+, extra tests, and duplication under 100 lines.
