# Shrink the component test module graph

Status: implemented
Translation: pending

## Abstract

The `@lody/components` suite takes roughly ten minutes because Vitest isolates
every one of its 446 files and re-evaluates each file's whole import graph;
assertions themselves account for well under a fifth of the wall clock. Tracing
`vite-node` showed a single menu test pulling 991 modules, almost none of them
from `node_modules`, so four sources of accidental graph weight were removed: an
unused `Calendar` re-export dragging `react-day-picker`, `date-fns/locale`
barrel imports, an eagerly globbed directory of 324 icon SVGs, and two Vite
plugins plus a catch-all `tsconfig` path mapping that are only needed by the
production build. That test now loads 667 modules. The wall-clock effect is
**not** established: run-to-run variance on the measuring host exceeded the
effect being measured, and the target of a 20-second suite is unreachable
without disabling isolation, which currently crashes on pending async work.

## Decision

Vitest's `collect` phase — importing a test file and evaluating its transitive
graph — dominates this suite. Isolation means that work repeats per file, so the
only lever available without touching isolation is the size of the graph itself.
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

Disabling isolation is the only change that would reach a 20-second suite, since
it turns 446 graph evaluations into one per worker. It was measured and rejected
for now: with `isolate: false` a run succeeds up to six files and fails at seven
regardless of which file is seventh, with tinypool reporting
`Unhandled Rejection: Terminating worker thread`. Raising the worker heap to 8 GB
does not help, so this is leaked pending async work that isolation currently
contains, not memory pressure. 89 of the 446 files also use `vi.mock`, whose
registry is shared once isolation is off. Both are per-file cleanup projects.

## Evidence and limits

Module counts are deterministic and were taken from `DEBUG=vite-node:*` on
`tests/session-header-menu.test.tsx`: 991 requests before, 667 after, with
`date-fns` modules down to 3 and `react-day-picker` to 0. Of the original 991,
only 11 came from `node_modules`, confirming externalisation was already working
and that the weight was first-party. jsdom was ruled out as a cause: a single
file spends about 1.2 s in `environment`.

**Wall-clock improvement is unverified.** Timings on the measuring host are not
reproducible at the needed resolution — the same baseline configuration measured
97 s cold and 128 s warm on an identical 112-file shard, a spread wider than any
effect claimed here. Earlier single-file figures in this work were taken across
config changes that invalidate the Vite cache and should not be treated as
evidence. A trustworthy number needs repeated runs on a quiet host.

The full suite never completed during this work; three attempts were terminated
by the environment's background-task limit. Correctness was checked on a
`--shard=1/4` run (112 files, 912 tests, all passing) plus the tests touching the
changed modules, and `typecheck` and `lint` pass repository-wide. The suite also
requires `NODE_ENV=test`: under `NODE_ENV=production` React resolves to a build
that does not export `act`, and 154 files fail for that reason alone.

Vitest 3.2.4 is pinned here; `fsModuleCache` and `vitest doctor`, both relevant
to this problem, arrive in Vitest 4, which parts of the workspace already use.
