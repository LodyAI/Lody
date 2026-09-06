# CLI build, runtime, and adapter provenance

Background for `apps/cli`. Binding rules stay in [apps/cli/AGENTS.md](../../apps/cli/AGENTS.md)
and the scoped files under it; this page explains why those rules exist and how the pieces fit
together.

## Development build

`pnpm dev` bundles with esbuild (`scripts/dev-build.mjs`, ~3s) into `dist-dev/`, then runs
`node --enable-source-maps dist-dev/index.js`. `pnpm dev:build` builds only. There is no
on-demand TypeScript-loader fallback, so development startup must run built JavaScript.

The dev output layout must match production's — `index.js` plus flat sibling `claude-acp.js` /
`codex-acp.js` / `*-worker.js` — because `agent/setting.ts`, the Tinypool pools
(`file-index-scan-pool.ts`, `diff-line-count-pool.ts`), the direct `turn-diff-store-worker.ts`
client, and `workspace-watch-coordinator.ts` all locate their child by FILENAME next to
`import.meta.url`. Running directly from `src/` would leave only `.ts` siblings, so pools would
fall back to the main thread (`reason=worker_missing`) and mandatory workers would be unavailable.
`dev-build.mjs` asserts after each build that no worker-resolving module was hoisted into
`chunks/`, because that reintroduces the same invisible fallback.

Two dev-build choices are load-bearing:

- npm packages stay external — that is what makes it fast and avoids inlining wasm — but they are
  externalized by ABSOLUTE path. Bundling a workspace package's `.ts` source moves its imports
  into this bundle, and pnpm's strict layout has no entry for that package's transitive deps under
  `apps/cli/node_modules`.
- `splitting: true` keeps `await import(...)` a real lazy boundary. `review-viewer.ts` statically
  imports the generated `lody-code-review-viewer/manifest`, which does not exist until that
  package is built; inlining it would make `lody --version` fail.

The CLI's own `version` comes from `@/pkg` because each build composition aliases it to the
manifest that actually gets published (cloud builds point it at the private composing package). A
relative `../package.json` import bakes the stale OSS version into the published bundle — that is
what made `lody@0.82.1 --version` print `0.76.0`. The package `name` stays `lody` in every
composition.

## PR status reconciler

`src/lib/pr-poller/` reconciles PR discovery/association, lifecycle, CI rollup, and merge/conflict
state for this machine's sessions. It is the compensation path for a broken hosted GitHub webhook
→ Streams fan-out, and its normative spec is `specs/pr-status-reconciler.md`.

`PrStatusPoller` is constructed in `LodyFleet.start()`; per-workspace handles
(`pr-poller-workspace.ts`) are fact sources and write-back destinations only. All policy lives in
pure modules (targets, priority, quota, selection, provider projection, write-back planning) and
the scheduler is a thin orchestrator. Priority comes from `session-viewing` presence and
`lastMessageAt` activity (high lane 20s, low status 5min, no-PR discovery 20min); there is no
turn-end hook. Requests batch GraphQL per `(workspace, repo)` under a per-credential-scope point
bucket, with a provider safety-floor freeze and 15min→2h repo cooldowns.

Write-back plans against freshly read owner meta: `pullRequests` upserts by URL with the current
PR as the LAST item (legacy fields stripped once), while CI and merge state live in
`SessionMeta.pullRequestState` (`{s,m,t}`, ≤50B per entry; legacy `r` readiness is no longer
written and is deleted on touch). Scheduling state — never PR status — is in
`~/.lody/pr-poller-state.json`. `LODY_PR_POLL_DISABLED=1` is the kill switch and `LODY_PR_POLL_*`
overrides live in `pr-poller-config.ts`. Module invariants: `src/lib/pr-poller/AGENTS.md`.

## Builtin agents and adapter provenance

Builtin Claude, Codex, and Grok use bundled adapters plus managed native runtimes; builtin Kimi
launches its managed Node package directly. `src/agent/setting.ts` resolves those four through
`src/agent/managed-agent-runtime.ts`.

Builtin DeepSeek Harness is deliberately not a managed runtime: `src/agent/deepseek-harness-runtime.ts`
consumes the pinned profile from the `packages/acp-extension-dsh` submodule, launches it through
Lody's isolated npx cache, and loads the bundled `deepseek-acp.js` adapter. The extension owns the
ACP model, reasoning-effort, and permission selectors while Harness continues to own model
execution, sandbox enforcement, and one-shot approvals.

Built-in provider auto-registration runs from `src/lib/lody.ts`. Provider configs live in the
current machine Flock doc, so registration starts only after the Fleet's workspace subscription
confirms remote identity/access and the remote bridge attaches.

The adapter packages in `apps/cli/package.json` are public submodule dependencies, and adapter
bugs or behaviors should be fixed in their package sources first:

- `claude` → `packages/acp-extension-claude`, https://github.com/LodyAI/acp-extension-claude
- `codex` → `packages/acp-extension-codex`, https://github.com/LodyAI/acp-extension-codex
- shared contracts → `packages/acp-extension-core`, https://github.com/LodyAI/acp-extension-core
- `deepseek` → `packages/acp-extension-dsh`, https://github.com/LodyAI/acp-extension-dsh

When debugging Codex-side ACP behavior (tool_call update shapes, collaboration events, goal
metadata, image generation, history recovery), check the workspace adapter source first. Managed
runtime artifact pins and checksums live in `src/agent/managed-agent-runtime.ts`; artifact
production and publication are external distribution responsibilities. Observed per-agent
edit-evidence behavior and the ACP protocol reference are documented in context/acp-protocol.md
and context/acp-agent-edit-evidence.md.

Clean checkouts have no adapter `dist/` outputs, and existing checkouts may have stale outputs
after a submodule update, which is why `prepare:acp-adapters` runs before both
`scripts/dev-build.mjs` in the CLI `dev` script and Vite in the CLI `build` chain. The
`src/claude-acp-entry.ts` and `src/codex-acp-entry.ts` entries import the adapters' package roots,
whose runtime exports point at adapter `dist/`.
