# Highlights comparison

Run from the repository root after installing the workspace and Electron:

```sh
node packages/components/benchmarks/highlights/run.mjs > /tmp/highlights-benchmark.log 2>&1
```

The frozen baseline is the Markdown adapter from commit
`090f51b2613ec51ea655c4d4229e53ef31077d7d`, using Shiki 4.1.0's JavaScript
regex engine and its existing core-language set. The other arm imports the current
Markdown adapter (Highlights 0.2.0). Both request the existing light/dark CSS
variable palette. Synthetic TypeScript, Python, Rust and newline-separated JSON
objects contain Unicode, comments, strings and numeric expressions. Fixture sizes
are approximate UTF-16 character counts, not UTF-8 byte counts.

The runner starts a configless local Vite server and an invisible Electron window
with an isolated temporary profile.
It measures synchronous token generation, excluding React/DOM rendering, worker
messaging and application caches. Each fixture verifies exact source recovery
from tokens. Three warmups precede ten samples, alternating backend order; inputs below
4,096 characters use batches of ten calls to reduce clock quantization;
reported times are medians per call. The current Lody DiffViewer TSX source is
also measured without repetition. Token counts are included because lexer boundaries
and syntax categories differ; equal source recovery does not establish equal
highlighting quality. Timing is observational, never a CI assertion.

Initialization samples construct a new highlighter seven times in one realm.
The median excludes the first sample; modules and language data are cached.
These numbers are **not cold module loading or application startup**.

The streaming fixture appends 256-character chunks. Two arms retokenize every
prefix, as the current Markdown implementation does. The third uses
`StreamTokenizer` and verifies final source recovery. This third arm is an
unintegrated optimization: it emits complete lines, so supporting the current
partial-line display requires additional work. It must not be counted as an
already shipped benefit.

The runner also builds each adapter as an isolated minified ES library with Vite
and totals all emitted chunks (including lazy grammars/themes) and their individual
gzip sizes. This measures the full reachable adapter graph, **not initial network
transfer, the standalone review HTML, or the installed Electron application**.
The Highlights adapter still includes Shiki fallback dependencies.

[Recorded samples](results-2026-10-22.json) and
[compatibility decision](../../../../.agents/notes/proposed/architecture/2026-10-22-highlights-backend.md).
