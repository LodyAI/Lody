---
name: effect-v3-to-v4
description: Use this skill when migrating a codebase from Effect v3 to Effect v4, upgrading `effect` or any `@effect/*` package across the v3/v4 boundary.
disable-model-invocation: true
---

## Lody overrides (read first)

These repository rules override the upstream steps below.

- Keep the workspace catalog and lockfile version. Do not run `effect@latest`,
  add a root dependency, or upgrade packages as a side effect of this skill.
  Version changes require an explicit task.
- Resolve Effect from the package being changed, not an arbitrary root or
  transitive installation. Read its `effect/AGENTS.md` completely and follow the
  required links; search its `ai-docs` and `src` on demand. If dependencies are
  absent, follow repository installation rules. A temporary copy of the exact
  locked npm release is a read-only reference, not local validation. Upstream
  main is not the installed API.
- Read [Lody's Effect guide](../../docs/cli-effect-ts.md) and applicable scoped
  `AGENTS.md`. Give tasks and resources an explicit Scope owner, propagate
  cancellation across Promise boundaries, await cleanup, and bound finalizer
  waits. Temporary Promise facades need `Legacy` names and `@deprecated`.
- Type-checking alone is not acceptance. For shutdown, cancellation, resource
  release, retry or synchronization changes, run owning behavioral tests,
  including failure paths, with explicit signals and injected/fake clocks.
  Report baseline failures and environment limits separately; do not weaken tests.
- Preserve the public/local boundary and disabled telemetry when using upstream
  examples. Edit `AGENTS.md` only; `CLAUDE.md` is its symlink.
- Lody is already on v4. Apply this skill only to an explicitly scoped migration;
  do not force third-party transitive v3 consumers onto v4.
- Fetch supplementary upstream guides/tests only as needed, outside tracked
  project files. Pin v4 sources to the target release tag/commit and verify API
  signatures against the actual dependency. Check ownership and local changes
  before replacing a pre-existing checkout. The upstream "tests are not a gate"
  completion rule below does not apply to Lody.


# Effect v3 to v4 Migration

Drive an Effect v3 → v4 migration from the generated migration reference that ships in the Effect repo. Every rename, removal, and signature change is answered by upstream data — do not guess replacements.

## Workflow

Work through these steps in order; each one is detailed in the section named.

1. **Set up and validate the local checkouts** — two shallow clones; verify any pre-existing `.repos/effect` before trusting it. See **Setup: Local Checkouts**.
2. **Read `MIGRATION.md`** and `ls .repos/effect/migration/` for the background and guide index. See **Reading Order**.
3. **Migrate `package.json`** — remove consolidated packages, align every remaining Effect package on one v4 version. Do this before type-checking, or the first run drowns in unresolved-import noise from packages that no longer exist. See **Repo-Level Changes**.
4. **Run the project's type-check** (e.g. `tsc --noEmit`) to get the initial error inventory.
5. **Iterate until the type-check is clean.** For each error, resolve the API through the lookup discipline — search `migration/v3-to-v4.md` for the symbol, escalate per **Reading Order** — then fix the call site, delegating per-file fixes to sub-agents per **Delegating to Sub-Agents**. Never silence an error instead of resolving it; see **Hard Prohibitions**.
6. **Finish** — type-check clean; run tests and report their outcome honestly (not a gate); write the final summary. See **Done Condition**.

## Setup: Local Checkouts

The migration is driven from two shallow, single-branch clones of the canonical Effect repo:

```sh
git clone --depth 1 --single-branch https://github.com/Effect-TS/effect .repos/effect
git clone --depth 1 --single-branch --branch v3 https://github.com/Effect-TS/effect .repos/effect-v3
```

- `.repos/effect` — v4 (`main`). Contains `MIGRATION.md`, the `migration/` guides, and the v4 source.
- `.repos/effect-v3` — v3 (`v3` branch). Escalation-only reference for old semantics.

Each clone is independently re-runnable and separately deletable. Do not use `git worktree` to share one clone between branches.

### Validate an existing checkout before trusting it

`./.repos/effect` may already exist, cloned from the superseded `Effect-TS/effect-smol` repo by older setup instructions. That checkout is stale and does not contain `migration/v3-to-v4.md`. Verify before using:

```sh
git -C .repos/effect remote get-url origin   # must be the canonical Effect-TS/effect repo
node -p "require('./.repos/effect/packages/effect/package.json').version"   # must be 4.x
```

If the origin points at `effect-smol`, or the version is not `4.x`, delete the directory and re-clone as above.

## Reading Order

1. **Front-load `MIGRATION.md` once** (`.repos/effect/MIGRATION.md`).
2. **`migration/v3-to-v4.md` — the first stop for every API.** The generated reference covers every removed or changed API. Search it (see below); never read it whole.
3. **A per-topic guide** (`.repos/effect/migration/*.md`) when the mapping implies a rewrite rather than a rename — e.g. `Context.Tag` → `Context.Service` is a structural change, not a symbol swap. Reach these on demand from the `MIGRATION.md` index, not front-loaded.
4. **v4 source** (`.repos/effect/packages/*/src/`) to confirm a replacement's real signature before writing code against it.
5. **v3 source** (`.repos/effect-v3`) as escalation only — for when unsure about the old v3 semantics.

## Never Read the Reference Doc Whole

**This is the single most important rule in this skill.** `migration/v3-to-v4.md` is ~17,000 lines / ~350k tokens. Reading it in one pass blows the context window and takes the migration with it.

Always search it and read only matched lines plus surrounding context. The file has four sections — **Import Map**, **No Counterpart Imports**, **Removed Modules**, and **API Reference** (one `` ### `<v3 module path>` `` heading per module). Entries are grep-able one-liners of the form `` - `Old.symbol` -> `New.symbol`: <rationale> ``, and removals are explicit `` -> `none` `` entries with a stated alternative.

Concrete recipes:

```sh
# Look up a specific v3 symbol
rg -n 'AnthropicTokenizer\.layer' .repos/effect/migration/v3-to-v4.md

# Read a whole module's section via its heading
rg -n -A 40 '^### `@effect/platform/FileSystem`' .repos/effect/migration/v3-to-v4.md

# Resolve a v3 import path in the Import Map
rg -n '^@effect/platform/FileSystem ' .repos/effect/migration/v3-to-v4.md

# List every module section for a package
rg -n '^### `@effect/cluster/' .repos/effect/migration/v3-to-v4.md
```

Look up APIs as you encounter them, one search at a time. A miss in the Import Map is not a dead end — check the **Removed Modules** and **No Counterpart Imports** sections before concluding anything.

## Repo-Level Changes

Faithful per-API lookup alone still yields a broken `package.json`. Handle these once, up front:

- **Package consolidation.** `@effect/platform`, `@effect/rpc`, `@effect/cluster`, and others merged into the core `effect` package. Remove them from `package.json` and rewrite their imports per the Import Map. Packages that remain separate (`@effect/platform-*`, `@effect/sql-*`, `@effect/ai-*`, `@effect/opentelemetry`, `@effect/atom-*`, `@effect/vitest`, …) stay as dependencies. The consolidated v3 packages (including `@effect/sql` and `@effect/cli`) still have npm `latest` tags pointing to `0.x`; remove them rather than bumping everything to `latest`.
- **Version alignment.** Target the current stable `latest` 4.x release. All Effect ecosystem packages share one version number in v4, so every remaining `effect` / `@effect/*` dependency must use that same matching version.
- **Module paths and stability.** GA imports use paths such as `effect/http`, `effect/rpc`, and `effect/ai/LanguageModel`. Stability is declared by JSDoc tags, not an import-path segment: `@stability unstable` APIs may receive breaking changes in minor releases, and `@stability experimental` APIs may receive them in patch releases.
  If migrating code that targeted a beta or RC with `effect/unstable/<module>` imports, drop the `unstable` segment (for example, `effect/unstable/http` → `effect/http`). There are no compatibility exports for the old paths; moving a module does not stabilize its API.

## Delegating to Sub-Agents

Per-file migration work is context-hungry; do it in sub-agents so the main session's context survives the whole migration.

- Spawn one sub-agent per file (or per module), giving it the specific v3 symbols to resolve in that file.
- The sub-agent returns the edit and the mappings it used; the main session keeps the error inventory and the running summary.
- Sub-agents inherit the same lookup discipline (**Reading Order**, the `rg` recipes) and **Hard Prohibitions**.
- The reference doc is never read whole in a sub-agent either — a blown sub-agent context still costs the migration that file.

## Hard Prohibitions

- **Never reintroduce a v3-shaped compatibility layer.** Writing a `v3-compat.ts` that re-exports old names makes type errors vanish and permanently freezes the codebase between versions. Migrate call sites to the v4 API.
- **No `any`, no `as` casts** to silence a post-migration type error. Such an error is usually evidence the replacement has a different shape; casting deletes that information. Go back to the reference or the v4 source.
- **No invented APIs.** Every replacement must trace to the reference doc, a topic guide, or the v4 source.

## Done Condition

**The project type-checks against v4.** A v4 migration is fundamentally a type-level exercise; unresolved imports and changed signatures surface there and nowhere else. Run the project's type-check (e.g. `tsc --noEmit`) until clean.

Running the test suite is recommended, and its outcome must be reported honestly — but it is **not** a gate. A repo mid-migration often has tests that cannot run for unrelated reasons; do not weaken tests to make them pass.

The final summary must state: the type-check result, the test result (or why tests were not run), every constructed replacement, and any gaps that were reported rather than bridged.
