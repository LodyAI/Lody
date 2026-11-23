# Shrink the component test module graph

Status: implemented
Translation: current

[中文](2026-09-10-components-test-module-graph.zh.md)

## Abstract

The component suite's repeated module transforms and graph evaluation cost more
than its assertions. Tests use the workspace Vitest 5.0.2 catalog, persistent
`fsModuleCache`, and projects that reuse safe Node/jsdom graphs while isolating
module-mocked suites and known process/browser owners. Removing accidental graph
weight still matters, particularly for isolated files. Shared workers require
explicit cleanup; neither a warm transform cache nor passing tests establishes
production performance.

## Decision

Vitest's `collect` phase — importing a test file and evaluating its transitive
graph — dominates this suite. Isolated files repeat graph evaluation; reusable projects share it per worker.
The graph's size remains a separate cost for both paths.
Four independent sources were found by ranking `DEBUG=vite-node:*` requests:

- `src/ui/index.ts` re-exported `src/ui/calendar.tsx`, whose `react-day-picker`
  dependency pulls `date-fns`, `date-fns-jalali` and `@date-fns/tz`. The
  `Calendar` component had no callers anywhere in the repository. Deleted, along
  with the `react-day-picker` dependency; this also removes 3.6 MB from the
  product bundle.
- Eight modules imported `{ enUS, zhCN }` from the `date-fns/locale` barrel,
  which natively loads all 96 locales. They now deep-import
  `date-fns/locale/en-US` and `date-fns/locale/zh-CN`, both declared exports.
- `new URL(\`./files/${name}.svg\`, import.meta.url)` makes Vite eagerly glob the
  whole icon directory — 324 SVG modules — into every consumer of `FileIcon`.
  That is correct for a bundle, which has to emit the assets anyway, so the two
  calls moved to `file-icons/asset-url.ts` and the test config aliases only that
  module to a stub. Stubbing the whole `file-icons` entry was rejected because
  `file-tree-virtual-rows.test.tsx` exercises its component cache for real.
- The test config dropped `vite-plugin-top-level-await` (Node and Vitest support
  top-level await natively; the loro WASM suites pass without it) and replaced
  `vite-tsconfig-paths` with explicit aliases, because `tsconfig`'s catch-all
  `"*": ["./*"]` mapping makes the plugin probe the filesystem for every bare
  specifier in every module. `vite.config.ts` keeps both: the production bundle
  does need TLA downlevelling, and its targets are not this file's concern.

The root catalog pins Vitest 5.0.2 across the public workspace. The component
config partitions tests by their declared environment. Files using module-mock
APIs (`vi.mock`, `doMock`, `unmock`, `doUnmock`, `resetModules`, or `hoisted`) and
an explicit set of long-lived browser/process owners remain isolated; other
files use `isolate: false`. Shared setup restores spies, timers, environment,
global descriptors, storage and DOM state. Tests still own their React roots,
listeners and asynchronous work. Package-specific worker and native-share mocks
remain scoped to the files using them.

`test.fsModuleCache: true` persists transformed modules between processes. This
is distinct from reusing an evaluated graph inside a worker, and cannot replace
state cleanup. CLI and the local rest aggregate use the same disk-cache option;
their aliases, WASM plugins and package working directories remain intact.

A previous Vitest 3.2.4 experiment stopped with a terminating-worker rejection
when isolation was disabled. Raising its heap to 8 GiB did not resolve it. That
observation did not establish a universal leak diagnosis or prohibit reuse under
the current runner. Disabling isolation for every file remains inappropriate:
module mock registries and long-lived owners still need separate contexts.

## Evidence and limits

Module counts are deterministic and were taken from `DEBUG=vite-node:*` on
`tests/session-header-menu.test.tsx`: 991 requests before, 667 after, with
`date-fns` modules down to 3 and `react-day-picker` to 0. Of the original 991,
only 11 came from `node_modules`, confirming externalisation was already working
and that the weight was first-party. jsdom was ruled out as a cause: a single
file spends about 1.2 s in `environment`.

Historical timings for the earlier graph-only changes were inconclusive: an
identical 112-file shard measured 97 s cold and 128 s warm on the same host.
Those figures do not quantify the current runner, isolation or cache changes.
Current wall-clock measurements must distinguish a cold module cache from a
prewarmed run and state the worker budget; the two-minute local check target is
not a product performance guarantee.

Keep `NODE_ENV=test`: the production React build does not export `act`. A passing
shared run does not justify moving a module-mocked or long-lived browser owner
out of its isolated project. New source changes invalidate disk transforms;
new ownership hazards require reviewing the partition and local cleanup.
