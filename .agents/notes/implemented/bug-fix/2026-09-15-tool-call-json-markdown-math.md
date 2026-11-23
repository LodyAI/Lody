# Keep serialized tool-input JSON out of the Markdown math pipeline

Status: implemented
Translation: current

[中文](2026-09-15-tool-call-json-markdown-math.zh.md)

PR: [#711](https://github.com/LodyAI/Lody/pull/711)

## Abstract

Expanding a tool call showed its raw input JSON mangled: single-`$` inline math
parsing treated shell fragments such as `$(git ...)` as TeX and dropped
characters like the `&` in `2>&1`, so the displayed command was not the command
that ran. The stored history and the executed command were intact — the damage
was render-time only. The renderer now detects text content blocks that hold a
serialized JSON payload and shows them as untouched verbatim code, keeping only
prose on the Markdown path. Legitimate `$...$` math in prose is unaffected;
tool `resource` text blocks still render as Markdown and remain exposed to the
same artifact.

## Decision and boundaries

`detectToolCallJsonText` (`packages/components/src/lib/tool-call-json-text.ts`)
returns the original text, trimmed but otherwise untouched, when a text block
parses as a JSON object or array, and `null` otherwise (primitives, prose,
broken JSON). `StandardToolContentBlock`'s `text` case
(`packages/components/src/components/ai-gui/view.tsx`) renders the detected
payload in the same monospace `<pre>` treatment already used for raw tool
output; everything else continues to `MarkdownBlock` unchanged.

`JSON.parse` only validates; the payload is never re-serialized. Routing
numeric lexemes through JavaScript numbers corrupts integers beyond 2^53
(64-bit IDs) and rewrites forms like `1e10`, which would recreate the same
displayed-differs-from-actual defect on the digits.

The classifier lives in a leaf lib module, not in `view.tsx`: the package's
test module-graph rule forbids pulling the whole `view.tsx` import graph into a
unit test, and a pure function is the contract the regression test asserts.

## Alternatives and trade-offs

Stopping the producer from emitting the input-JSON text block was rejected:
previously recorded sessions already carry these blocks in history, so a
producer-side change would leave existing transcripts mangled. Disabling math
for every tool-call text block was rejected because tool results can contain
legitimate prose with `$...$` math; the JSON parse check separates data from
prose instead. Pretty-printing via `JSON.stringify` was dropped after review
pointed out the numeric-lexeme corruption above; a lexeme-preserving
pretty-printer would keep readability but adds a hand-rolled JSON tokenizer to
a display path, which the verbatim approach avoids at the cost of single-line
payloads staying single-line.

## Evidence and limits

The regression test feeds the real-world payload shape (a `git commit --amend`
command containing `$(...)`, `2>&1`, and nested quotes) and asserts the output
is the input verbatim; integer lexemes beyond 2^53 and exponent forms are
asserted to keep their exact digits; prose, primitives, and malformed JSON stay
on the Markdown path. Unit tests pass 8/8; package typecheck, oxlint on the
touched files, and Prettier are clean. `markdown-idle-rerender` and
`markdown-streaming-reparse` fail in a fresh worktree on the unmodified base
(jotai storage environment), so they are unrelated to this change. Tool
`resource` text blocks were deliberately left on the Markdown path and can
still hit the artifact; verified rendering is by code inspection, not a clicked
UI, because the mangling was observed on recorded history that predates this
branch.
