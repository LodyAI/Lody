---
name: effect-ts
description: Use when writing, reviewing, debugging, or setting up Effect TypeScript code in Lody.
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


# Step 1: Install effect

Use the users preferred package manager:

```
pnpm add effect@latest
```

If in a monorepo, install it as a dev dependency at the root, so you can access
the source code from `node_modules/effect/src`.

```
pnpm add -D effect@latest
```

# Step 2: Update AGENTS.md / CLAUDE.md

Ensure that the agent instructions contain the following:

```md
# Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.
```
