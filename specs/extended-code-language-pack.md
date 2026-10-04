# Optional extended code-language pack

Status: draft
Translation: current

[中文](extended-code-language-pack.zh.md)

## Abstract

Lody keeps a small set of common code grammars in the default rendering path and
offers a local Appearance setting for additional languages. The setting is off
by default and applies to Markdown code blocks and session-file previews. When
enabled, an extended grammar is loaded only when that language is first used;
the first render may therefore take longer, while later renders reuse the loaded
grammar. Worker-based highlighting remains preferred, with a main-thread
fallback for environments without a usable Worker.

## Scenario and scope

A user opens Appearance and enables **Extended code languages** because a
conversation or project contains a language outside the default set. Markdown
fences and file previews then recognize the optional language. Turning the
setting off makes those optional languages plain text again without changing the
source content or the local file data.

The preference is local to the client, persists across launches, and defaults to
false. The pack changes syntax recognition only; it does not add language
servers, formatters, execution support, or file icons.

## Language tiers

The default tier contains the existing JavaScript/TypeScript, JSON, shell,
Markdown, Python, Rust, Go, YAML, HTML, and CSS grammars, plus common C-family,
JVM, systems, web, data, and configuration grammars: C, C++, C#, Java, Kotlin,
Swift, Ruby, PHP, SQL, GraphQL, TOML, XML, and Dockerfile.

The optional tier contains Dart, MDX, Lua, MySQL, Objective-C, Perl, PostgreSQL,
PowerShell, Batch, Fish, SCSS, Less, HCL, Protobuf, Vue, Svelte, Astro, Elixir,
Erlang, Clojure, Scala, Haskell, OCaml, F#, Julia, R, Solidity, Zig, WGSL, GLSL,
LaTeX, CMake, Nginx, Make, Lean, and Coq. MySQL and PostgreSQL labels (`mysql`,
`pgsql`, and `postgresql`) use the core SQL grammar. Markdown accepts `rocq` as
an alias for the Coq grammar and `lean4` as an alias for Lean.

When the pack is enabled, `.v` and `.rocq` files are assigned to Coq and are
rendered with the explicit Shiki `coq` grammar. Lody does not preserve a V or
Verilog interpretation for these extensions. With the pack disabled, these
files remain plain text. Read-only Coq and Lean previews use Shiki because
Monaco has no corresponding basic-language contribution; editable provider
surfaces keep their Monaco editor and therefore show those grammars as plain
text while editing. The `.v` file icon is language-neutral rather than a
Vlang-specific icon.

## Rendering behavior

The Shiki highlighter starts with only the default tier. An enabled optional
grammar is loaded immediately before its first Markdown tokenization and is
shared by subsequent requests in that highlighter. Session-file previews keep
the default Monaco contributions static and dynamically import an optional
contribution only for the selected language. If an optional Monaco contribution
cannot load, that preview falls back to plain text.

The shared worker receives the same preference as the component. A failed or
unavailable worker uses the main-thread highlighter, which applies the same
language gate and lazy grammar loading. Plain-text fallback is used when the
setting is off or a language is not in either tier. Markdown supports the
complete Shiki list; file previews use the optional extensions registered in the
session-file language map and the closest static Monaco grammar where one exists.
Languages without a Monaco contribution use the explicit Shiki read-only viewer.

## Evidence

- Implementation: [language tiers](../packages/components/src/lib/markdown-highlighter.ts), [Markdown language resolution](../packages/components/src/components/ai-gui/markdown-code-highlight.ts), [Monaco language loading](../packages/components/src/lib/session-monaco-languages.ts), and [Appearance setting](../packages/components/src/components/settings/appearance-setting.tsx).
- File-language boundary: [session file language mapping](../packages/components/src/lib/session-file-language.ts).
- Coq file preview: [Shiki file viewer](../packages/components/src/components/sessions/session-shiki-text-viewer.tsx).
- Verification: [session file language tests](../packages/components/tests/session-file-language.test.ts), [Markdown language tests](../packages/components/tests/markdown-code-highlight.test.ts), and [highlight worker client tests](../packages/components/tests/markdown-highlight-client.test.ts).
- Decision record: [extended language pack note](../.agents/notes/implemented/feature/2026-10-01-extended-code-language-pack.md)
  and [Coq file preview follow-up](../.agents/notes/implemented/feature/2026-10-02-coq-file-preview-rendering.md).
