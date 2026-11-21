# Daemon memory footprint

Status: implemented
Type: architecture
Translation: current

[中文](2026-11-21-daemon-memory-footprint.zh.md)

## Abstract

A memory-billed host reported about 1.4 GB resident across the three long-lived
daemon processes (watchdog, Worker, HTTP MCP host). Heap snapshots attributed a
third of each JS heap to Zod 4.3 classic schemas, which attach about 58 method
closures to every instance, and every process evaluated nearly every shared schema
because the bundle could not tree-shake them or keep them out of shared chunks.
Zod is upgraded to 4.6, whose classic methods live on prototypes; workspace
`sideEffects` declarations now reach Rollup; the watchdog no longer composes
Workspace presence; Loro and Flock wasm load from asset files; and daemon children
cap glibc arenas. On an idle local daemon the three processes drop from about
797 MiB to 407 MiB RSS. Busy-workload and other-platform figures remain unmeasured.

## Findings

- Zod 4.3 `ZodType` assigns `parse`, `optional`, `pipe` and the other chain methods
  per instance. The idle Worker held about 12,400 schemas, 725,000 such closures
  (40.6 MB) and dictionary-mode property tables of similar size. Zod 4.6 defines the
  same methods on prototypes; the instance count is unchanged but closures fall to
  about 12,000 per process.
- Vite attaches a package's `sideEffects` only to bare-specifier resolutions. Modules
  that `@lody/shared` reaches through relative imports therefore counted as
  side-effectful, and the CLI entry imported 267 modules purely for their side
  effects. `apps/cli/scripts/workspace-module-side-effects.mjs` applies each workspace
  package's own declaration.
- A binding the shared barrel declared itself (stream ids, room ids) kept a barrel
  import, and the barrel's re-export edges then reached every module it re-exports.
  Those helpers moved to `packages/shared/src/loro-streams-routing.ts`.
- `apps/cli/src/index.ts` composed Workspace presence for every command, so even the watchdog
  instantiated Loro and Flock wasm. The watchdog never reaches `apps/cli/src/lib/loro/doc.ts`,
  statically or dynamically; it now composes only the login-shell cache. The MCP host
  keeps presence because its tools reach `command-runtime` and open documents.
- vite-plugin-wasm inlines wasm as base64 in SSR builds, and V8 retains a module's
  source, so each Loro-loading process kept about 9 MB of base64 beside the compiled
  instance. The two vendor chunks shrink from 5.1 and 3.5 MB to 0.31 and 0.11 MB.

## Decision

- The `zod` catalog and override move from 4.3.6 to 4.6.7. The repository has no
  detached method references such as `.map(schema.parse)`, which prototype methods
  would break.
- `apps/cli/vite.config.ts` passes `workspaceModuleSideEffects` as Rollup's
  `treeshake.moduleSideEffects`. Packages without a declaration stay side-effectful;
  dependency packages keep Rollup's default.
- `apps/cli/scripts/external-wasm.mjs` emits each inline wasm module as `dist/assets/*.wasm` and
  patches the plugin's loader to read `file:` URLs from disk, failing the build when
  the plugin output no longer matches. Every distribution copies `dist/` except
  sourcemaps, the same contract `zstd.wasm` uses. The loader still instantiates once,
  so `wasm-runtime-health` reads the same memory export.
- The Worker and MCP host start with `MALLOC_ARENA_MAX=2` on Linux unless the caller
  set it. `apps/cli/src/utils/malloc-arena.ts` removes the injected value at process start, after
  glibc has read it, so Agents, terminals and user commands keep the caller's
  allocator settings.
- `LODY_WORKER_MAX_OLD_SPACE_MB` in the watchdog's environment overrides the
  machine-relative Worker heap limit; an unusable value is logged and ignored. The
  default stays 20% of memory between 768 and 4096 MiB.

## Alternatives

- `zod/mini` or lazily constructed schemas would remove the same closures but touch
  every schema module; the upgrade achieved it without source changes.
- Patching Zod 4.3 with lazy prototype getters was considered before 4.6 was found to
  ship prototype methods.
- `treeshake.manualPureFunctions: ['z']` changed nothing: the schemas were retained
  because modules were imported for side effects, not because calls looked impure.
- Per-module `manualChunks` for workspace packages made the watchdog load 261 files,
  since Rollup keeps side-effect imports into manual chunks.
- A Vite plugin that rewrote `@lody/shared` imports to declaring modules produced the
  same measurements as the barrel split plus `sideEffects`, so it was not kept.
- Moving the MCP host into the Worker would remove a Node instance but put synchronous
  SQLite and tool work on the daemon event loop
  ([internal MCP loading](2026-10-30-internal-mcp-command-loading.md) keeps the boundary).
- A fixed lower Worker heap default could fail heavy existing workloads, so only the
  override was added. Idle-time Worker restarts would need a failure-containment
  review and are not part of this change.

## Measurements

Linux x86_64, Node 26.13.1, production `cli-runtime` bundle of base `bbed0d88b`,
isolated `HOME`/`LODY_DATA_DIR`, local platform, no login, Agent or session. Each
process was sampled about 40 s after daemon readiness, after a forced GC through the
inspector. RSS is `process.memoryUsage().rss`; heap is `heapUsed`; Zod counts objects
named `Zod*` in a heap snapshot. RSS counts shared pages in every process.

| Step | Watchdog RSS / heap | Worker RSS / heap | MCP host RSS / heap |
| --- | ---: | ---: | ---: |
| Base | 211 / 105 MB | 326 / 181 MB | 260 / 146 MB |
| `sideEffects`, barrel split, no watchdog presence | 151 / 79 MB | 317 / 178 MB | 241 / 141 MB |
| External wasm | 151 / 79 MB | 292 / 171 MB | 219 / 133 MB |
| Zod 4.6.7 | 96 / 29 MB | 182 / 69 MB | 129 / 48 MB |

Zod instances stay at about 6,000 / 12,000 / 10,000 per process; closures attached to
them fall from 348,000 / 699,000 / 592,000 to about 6,500 / 12,200 / 10,600. External
memory falls from 18.9 to 9.2 MB in the Worker and from 14.7 to 4.9 MB in the MCP host.
The arena cap does not change an idle sample; it bounds fragmentation after peaks,
which the reporting host observed as RSS staying at 1.13 GB after a 1.4 GB spike.

## Verification and limits

- `packages/cli-supervisor/src/process-resources.test.ts` pins the heap override and
  its rejected values; `apps/cli/src/commands/daemon-shared.test.ts` pins that daemon
  children receive the arena cap and that it is not passed on.
- The published-bundle smoke (`apps/cli/scripts/check-published-bundle-imports.js`)
  loads the built entries and workers.
- Busy workloads, macOS/Windows, the Electron-embedded CLI and the reporting arm64
  host were not measured. The watchdog still evaluates `message-schemas.ts` through
  `cli-supervisor` health checks of local IPC; splitting that module is future work.
