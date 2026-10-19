# Document ACP and extension support per built-in provider

Status: proposed
Translation: current
Language: [中文](2026-10-06-docs-acp-feature-support.zh.md)

## Abstract

Readers coming from Codex or Claude Code could see which capabilities Lody's built-in providers
support only by reading adapter source. This adds `(migrating)/acp-feature-support` in both locales:
a short explanation of ACP and the `acp-extension-core` `_meta.lody` contract, followed by one
provider-by-feature matrix for standard ACP capabilities and the ten user-facing v1 agent
extension capabilities. The matrix is derived from the capability constants, `InitializeResponse`
values, and source of the shipped adapters and external ACP servers; it is a documentation snapshot,
not runtime probing, so it can lag a provider update until a maintainer rechecks it.

## Problem

- The migration page explained what Lody adds but not which optional capabilities each built-in
  provider actually declares.
- Lody's extension capabilities are advertised per feature under `_meta.lody`; no public docs page
  summarized the contract or the per-provider support.
- The Devin and Grok compatibility proxies and the external Bub and Dimcode ACP servers made it
  unclear which rows Lody guarantees and which are defined by the runtime behind the connection.

## Decision

- Add `site-docs/content/docs/{en,zh}/(migrating)/acp-feature-support.mdx` and list it in both
  `(migrating)/meta.json` files. Link it from the migration page body and its Next cards. This
  extends the reader-path groups from the
  [information-architecture note](2026-10-01-docs-information-architecture.md).
- Explain ACP, the `acp-extension-core` negotiation model, and the `_meta.lody` capability keys,
  with links to the protocol site and the public contract repository.
- Publish one matrix whose columns are standard ACP optional capabilities and the ten user-facing
  v1 agent extension capabilities, and whose rows are the nine built-in providers. Fill the Lody rows from
  the adapter capability constants (`CLAUDE_LODY_CAPABILITIES`, `CODEX_LODY_CAPABILITIES`,
  `LODY_CAPABILITIES`, `GROK_LODY_CAPABILITIES`, `LODY_EXTENSION_CAPABILITIES`,
  `initializeResponse()`, and the Devin proxy), and the standard ACP rows from each adapter's
  `InitializeResponse` or the external ACP server's source. Use only `✓`, `◐`, and `—`; link each
  provider name to its runtime or adapter repository.
- Split the combined load/resume column into `ACP: load` and `ACP: resume`, so a provider that
  supports only one of the two is not reported as supporting both.
- Link [ACP Wall](https://github.com/wibus-wee/acp-wall) as an independent, versioned comparison of
  standard ACP implementations.
- Add an extension-column reference for those ten user-facing capabilities. The two
  provider-internal Codex keys (`sessionHistory` read-only import and `worktreeProject` native
  project mapping) are deliberately omitted from the user-facing matrix; other providers reach the
  same outcomes through standard ACP replay and Lody-side worktrees.

## Alternatives considered

1. Put the matrix on the existing migration page. Rejected: a 19-column table would bury the
   migration checklist, and the matrix is reference material for the migration reader.
2. Keep a `Runtime` value where Lody only proxies an external runtime. Rejected after review: it
   does not answer whether the capability is available. The table now uses the provider's own
   `initialize` declaration or source instead.
3. Generate the table at build time by probing each provider. Rejected: the static site build has no
   provider credentials or runtime; the shipped declarations are the available source of truth.

## Verification and limits

- `pnpm run docs status`, `node scripts/docs/main.mjs check`, site-docs `typecheck`, `test`, and the
  production build pass; the static browser suite reports the same two pre-existing mobile no-js
  navigation timeouts and no new failures.
- The matrix is a snapshot of the shipped adapters and external ACP server versions. A provider
  update can change the negotiated result before this page is rechecked.
- Refreshed the `DeepSeek Harness` row against `acp-extension-dsh` 0.2.0 at `8cf61ea`
  (acp-extension-core 0.1.9): standard load, resume, and fork; Core fork-at-turn, steering,
  subagents, goal, and background tasks are now declared. Image input remains model-dependent,
  while scheduled tasks and rate limits stay absent.
