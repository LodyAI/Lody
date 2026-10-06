# Optional code-language grammars are opt-in

Status: implemented
Translation: current

[中文](2026-10-01-extended-code-language-pack.zh.md)

## Abstract

The existing renderer loaded only a short Shiki and Monaco language set, so
less-common but useful languages either rendered as plain text or would have
increased the default bundle. The client now keeps common grammars in a core tier
and adds a persisted Appearance switch for an extended tier. Extended grammars
load on first use in Markdown or a file preview, with Worker and main-thread
paths sharing the same gate. The `.v` ambiguity remains intentionally out of
scope.

## Decision

- Keep the setting local and off by default under
  `lody-extended-code-languages-enabled`.
- Keep the existing JavaScript/TypeScript, JSON, shell, Markdown, Python, Rust,
  Go, YAML, HTML, CSS, and common C-family/JVM/web/data/configuration languages
  in the core tier.
- Put the broader language list, including Lean and Coq, in the opt-in tier.
  `rocq` is a Markdown alias for the existing Coq grammar; it is not a `.v`
  filename rule.
- Recognize MySQL and PostgreSQL labels (`mysql`, `pgsql`, `postgres`, and
  `postgresql`) only when the pack is enabled, using the core SQL grammar
  because Shiki does not ship separate dialect grammars in the pinned version.
- Load optional Shiki grammars through the highlighter's `loadLanguage` path and
  optional Monaco basic-language contributions through per-language dynamic
  imports. De-duplicate concurrent loads and remove rejected loads so a later
  attempt can retry.
- Pass the preference through the Markdown worker protocol. When the worker is
  absent or fails, the main-thread fallback uses the same preference and lazy
  loading behavior.
- Return `plaintext` for gated session-file extensions while the setting is off.
  The file-language map does not add `.v` or attempt V/Verilog/Rocq inference.

## Alternatives and trade-offs

Eagerly registering every grammar would make every user pay the startup and
bundle cost, including users who never encounter those languages. Loading every
optional grammar as soon as the switch is enabled would avoid the first-use
delay but would create a large synchronous interaction. The chosen lazy policy
keeps opt-in cost proportional to the languages actually rendered; the setting's
helper text calls out that the first render can be slower.

Some Shiki grammars do not have a Monaco basic-language contribution. They remain
available for Markdown fences, while file previews use the closest supported
Monaco mapping or plaintext. Adding language servers, execution support, icons,
or ambiguous `.v` inference is a separate decision.

The later `.v` mapping and read-only Coq file viewer are recorded in the
[follow-up note](2026-10-02-coq-file-preview-rendering.md); this note preserves
the scope and rationale of the original language-pack implementation.

## Verification

- `git diff --check` passed after the implementation edits.
- Focused Vitest tests pass for the core/extended worker request boundary, gated
  file language detection, and Markdown language resolution (8 tests).
- Oxfmt checks pass for all changed source, test, Spec, and Note files. The
  components typecheck reaches the changed code without new errors; the command
  remains red because this checkout lacks the isolated `acp-extension-core` and
  `acp-extension-dsh` modules and reports unrelated pre-existing implicit-any
  errors.
- The draft contract is [Optional extended code-language pack](../../../../specs/extended-code-language-pack.md).
