---
name: delete-comment
description: Audit code comments in a scope, classify each as Tautology, Excuse, Stale, or Decision Record, delete the removable ones, relocate durable rationale, and tighten the comment ratchet. Use for comment audits, comment cleanup passes, or any request to reduce or review comments.
---

# Delete comments

`scripts/check-comment-ratchet.mjs` bans comment growth per scope: counted
comment lines may only shrink against `scripts/comment-ratchet-baseline.json`.
This skill is the repeatable audit procedure for that ratchet.

## Census

1. `node scripts/check-comment-ratchet.mjs --report` for per-scope counts.
2. `node scripts/check-comment-ratchet.mjs --dump <dir>` to list comments with
   file and line ranges. The scanner is string/template/regex-aware; trust its
   ranges, never `grep //`.
3. Weighted sample: the heaviest files per scope plus a spread across file
   kinds (source, tests, UI, libs).

## Classify, then act

- **Tautology** (restates the next line: "Increment counter", section labels,
  decorative banners): delete.
- **Stale** (describes removed behavior or expired compat windows): delete;
  if the dead *code* also remains, report it, don't silently remove it.
- **Excuse** (excuses a hack, or a TODO/FIXME with no owner): delete; record
  the underlying follow-up in the PR body or a note. Only file an issue when
  the user explicitly asks.
- **Decision Record** (non-obvious why: lifecycle, compat, containment): check
  for an existing durable home first — scoped `AGENTS.md`, `.agents/docs/`,
  linked notes. If covered, delete as redundant. If not, move a condensed
  version into the nearest `AGENTS.md` that has word-ceiling headroom
  (`scripts/docs/agents-budgets.json`); watch `pnpm run docs status`.

## Exempt, never delete by policy

JSDoc `/** */`, tool directives (`@ts-*`, oxlint/eslint/biome/prettier,
istanbul/c8, cspell, `#region`, `@generated`, `sourceMappingURL`, PURE
annotations, triple-slash, `@dec:`). The scanner marks these exempt.

## Deletion safety

- Delete comments with the scanner's ranges (see `scanComments` export) or by
  hand from the dump; never a line-level `//` regex — comments inside template
  literals (GLSL shaders, embedded docs) are false positives.
- After each file, syntax-check: `git diff` review plus a parse of the file.
- Then `node scripts/check-comment-ratchet.mjs --update` to tighten the
  baseline; re-run with no args to verify the ratchet passes.
