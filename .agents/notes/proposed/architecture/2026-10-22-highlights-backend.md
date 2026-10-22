# Highlights backend compatibility

Status: proposed
Translation: current

[中文](2026-10-22-highlights-backend.zh.md)

## Abstract

The syntax-rendering surfaces are being migrated from Shiki to Highlights 0.2.0,
using Diffs 1.6.1 for file and diff rendering. The standalone tokens API fits the
existing Markdown worker and React renderer; a Zed theme adapter keeps the active
VS Code palette available to Diffs. Migration remains incomplete because Highlights
has no Coq, Lean, Fish or Nginx lexer, and Diffs permits only one backend per
JavaScript realm. Preserving these languages requires an isolated Shiki path;
silently dropping their highlighting is not an equivalent migration.

## Implementation and compatibility

- Markdown retains its core/extended language gate, bounded cache, shared worker,
  main-thread fallback, CSS-variable palette and React text rendering. Highlights
  lexers ship locally. `canUseWASM()` selects Shiki's JavaScript engine on runtimes
  without WASM/SIMD support. Token boundaries differ between the engines.
- Diffs components and render-pool initialization select the same backend. Custom
  themes register both TextMate and Zed forms. Zed syntax categories map to the
  existing VS Code token colors; context-sensitive TextMate scopes cannot be
  represented exactly by a lexer category palette.
- Diffs 1.6 stores hunk line indexes instead of inline line arrays. Worker results
  compact those arrays to hunk ranges and rebase indexes. Callers that already own
  full source restore indexes and expansion context. Complexity limits continue
  counting actual hunk text. The old lookbehind-free newline splitter patch is
  carried forward to the new package version.
- The old unused `highlight.js` and `react-syntax-highlighter` dependencies are
  removed. Shiki remains necessary for the explicit no-WASM fallback. Monaco's
  editing, language services and tokenizer have not been migrated.

## Open compatibility decision

Prefer a separately owned Shiki fallback for unsupported languages, rather than
quietly rendering existing Coq/Lean/Fish/Nginx code as plain text. The standalone
Markdown adapter can load this fallback lazily. Diffs cannot switch its shared
backend per file within one realm; its unsupported-language route needs separate
ownership and behavior tests. The current patch has not completed that route.
The existing Coq/Lean read-only file viewer must keep explicit language identity.

This partially replaces the [Markdown worker implementation](../../implemented/architecture/2026-09-23-markdown-highlight-worker.md)
and the grammar-loading mechanism of the [extended language pack](../../implemented/feature/2026-10-01-extended-code-language-pack.md),
while retaining their worker and preference boundaries.

## Verification limits

Components and code-review-helper typechecks pass. The focused component suites
pass 57 tests; the helper suites pass 33 tests. The standalone HTML build and public
boundary check pass. Electron 44.7.0 renders real Highlights tokens. Chromium verifies matching
worker/main-thread tokens, custom theme colors, escaped source, and the no-WASM
Shiki fallback. The full check passes typechecking and lint, but reports a failure in the CLI
Git transport test for recursive native SSH submodule cloning; the root check exited unsuccessfully and did not establish a full-suite pass. Docs check reports six existing links into the
uninitialized Kimi/Pi submodules. Attribution
regeneration touches a large unrelated baseline and is deferred until the migration
scope is settled. This note does not establish migration completion.

## Measured benefit and cost

[Reproducible benchmark](../../../../packages/components/benchmarks/highlights/README.md)
and [raw samples](../../../../packages/components/benchmarks/highlights/results-2026-10-22.json)
compare the original Markdown Shiki JavaScript adapter at `090f51b2` with this
patch on Apple M2 Max, Electron 44.7.0 (Chromium 152), Node 22.20.0. Ten measured
samples follow three warmups; backend order alternates. Both use the existing dual
CSS-variable palette and must reconstruct the input exactly from tokens.

| Input                                         | Shiki JS median | Highlights median |
| --------------------------------------------- | --------------: | ----------------: |
| TypeScript, 204,864 characters                |      1,661.4 ms |            2.6 ms |
| Python, 204,930 characters                    |        476.9 ms |            2.6 ms |
| Rust, 204,867 characters                      |        443.6 ms |            2.6 ms |
| Newline-separated JSON, 204,816 characters    |        149.9 ms |            2.3 ms |
| Lody DiffViewer TSX source, 45,251 characters |        435.1 ms |            0.6 ms |

An append-only TypeScript fixture of 21,120 characters in 83 chunks takes
7,221.4 ms of cumulative CPU time with Shiki full-prefix retokenization and
11.3 ms with Highlights full-prefix retokenization. The unintegrated
`StreamTokenizer` arm takes 0.7 ms, but emits complete lines; preserving immediate
partial-line display still needs integration. This is a forced-update CPU workload,
not actual response latency: application scheduling may skip intermediate prefixes.
New highlighter construction with modules already cached is 65.9 ms versus 0.3 ms;
this does not measure cold imports or desktop startup.

The isolated minified adapter graph grows from 9,670,067 to 9,943,127 bytes;
summing individually gzipped chunks grows from 1,846,646 to 1,963,185 bytes
(+116,539 bytes, 6.3%). It includes all lazy grammars/themes and the retained Shiki
fallback, not just initial transfer. No application-size reduction is established.

These are synchronous tokenization measurements in an Electron renderer loaded
through Vite, not React/DOM, worker transport, cache-hit, Diffs rendering or app
startup measurements. Token boundaries and colors differ. The strongest supported
benefit is lower uncached Markdown/streaming computation; language preservation
and theme fidelity remain separate acceptance conditions.
