# Agent-authored notes and Specs ship both languages

Status: implemented
Translation: current

[中文](2026-09-12-agent-authored-notes-ship-both-languages.zh.md)

## Abstract

Agent Notes stopped being bilingual because every rule an agent reads permitted it: the language policy
says translation does not block merging, finishing-work told agents only to "surface translation debt",
and `docs check` accepts `Translation: pending` with no counterpart. On `main`'s `implemented/` and
`proposed/` notes that left 48 of 70 stems single-language. The rules now split by author — a human may
still contribute one language, but an agent that can write both must land `.md` and `.zh.md` together —
and every unpaired note was backfilled, so notes are 100% paired. The tooling change is a warning, not a
new gate: `docs check` still fails only on a `current` translation with a missing counterpart, so a
community contribution stays mergeable.

## Why the drift was legal

`.agents/README.md#asynchronous-bilingual-documentation` states that Specs and notes _eventually_ have
adjacent `.md` and `.zh.md`, either language may come first, and translation does not block merging.
`documentStatus` in `scripts/docs/main.mjs` enforces exactly that: it errors when `Translation:` is
missing or invalid, or when a document claims `current` while its counterpart does not exist. A note
marked `pending` with no counterpart is valid by design. Finishing-work step 5 then told the author to
"use status output to surface translation debt", which is a reporting instruction, not an authoring one,
and CONTRIBUTING.md separately tells humans that maintainers arrange the counterpart after merge.

Recent agent-authored notes followed those rules correctly and shipped one language with
`Translation: pending`. The counts on `main` before this change: of 70 note stems under `implemented/`
and `proposed/`, 22 were paired, 39 were English-only and 9 were Chinese-only. Nothing was broken; the
policy simply never asked an agent for the second file, and an agent that can write both languages in one
pass is the case the asynchronous policy was not written for.

## Decision

The rule splits by author rather than by document:

- `.agents/notes/AGENTS.md#history-and-language` now requires an Agent to land both files in the same
  change, cross-linked, with equal `Status:`, the same Abstract/摘要 meaning, and both marked
  `Translation: current`. `pending` is reserved for a human who cannot write the other language.
- `.agents/README.md` finishing-work gains that obligation as its own step, and the bilingual policy
  section names agents as the exception so the section is not read in isolation as permission.
- CONTRIBUTING.md keeps the human exemption verbatim and adds one sentence pointing agents at the note
  rule. Widening the requirement to humans was rejected: community contributors need not know both
  languages, and that is the reason the asynchronous policy exists.
- `AGENTS.md` files stay English-only. They are read on every change, and a second copy would be a
  second place for a binding rule to go stale.

`documentStatus` gains a warning — not an error — when a file under `.agents/notes/` has no counterpart.
Making it an error was rejected because it would fail a legitimate human contribution. The warning is
scoped to notes rather than all documents so that it starts at zero: after this backfill every note is
paired, so any warning is new debt rather than background noise. Specs are still 20 stems unpaired and
would have drowned the signal; they are outside this change's backfill and keep only the per-document
`missingTranslation` field that `docs status` already reports.

## Backfill

All 48 unpaired stems under `implemented/` and `proposed/` were paired: 39 English-only notes received a
`.zh.md` with `## 摘要`, and 9 Chinese-only notes received a `.md` with `## Abstract`. Each pair now
cross-links, carries the same `Status:`, and is marked `Translation: current` on both sides. Four
cross-note links that pointed at a `.zh.md` from an English note were repointed at the counterpart that
now exists; links into Chinese-only Specs were left alone, because those Specs have no English file.

The translations are faithful renderings of the recorded decision, not rewrites: no conclusion, verdict,
evidence, limit or PR reference was added, removed or softened, and no note's lifecycle path or `Status:`
was changed. The largest note, the goal-control review and ablation, carries a 355-row mechanical
ablation matrix; its narrative was translated by hand and the matrix rows were translated through a fixed
phrase table, because the result column has three templates and the conclusion column has about forty, so
a table keeps the rendering consistent across all 427 rows in a way row-by-row prose would not.

## Verification and limits

- `pnpm run docs check` passes with 0 errors, 0 notes missing a counterpart, and no notes warnings. The
  20 broken-link errors seen before submodules were initialized are the pre-existing uninitialized-ACP-
  submodule baseline, doubled by the new counterparts mirroring the same links; they resolve once
  `packages/acp-extension-*` are checked out.
- `node --test scripts/docs/main.test.mjs` passes 21 tests, including the new case asserting that a
  pending counterpart warns, that `check` still exits 0 on that warning alone, and that the warning
  disappears once the counterpart exists.
- Every pair was verified programmatically for a counterpart file, a cross-language link, and
  `Translation: current`; `implemented/` and `proposed/` report 0 unpaired stems.
- Translation accuracy is not machine-checkable and the tooling explicitly does not assess it. These
  translations were written by one agent and have had no second-language human review, which is the main
  residual risk of the new rule: it converts a visible gap ("no counterpart") into an invisible one
  ("counterpart of unreviewed quality").
- `implemented/testing/2026-09-07-ci-affected-tests` keeps `Translation: pending` on both sides even
  though the pair exists. It was already paired, so it is outside this backfill, and flipping it to
  `current` would assert a quality judgement about a translation this change did not make.
