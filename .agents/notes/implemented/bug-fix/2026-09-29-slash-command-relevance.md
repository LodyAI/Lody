# Rank typed slash commands across sources

Status: implemented
Translation: current

[中文版](2026-09-29-slash-command-relevance.zh.md)

## Abstract

Typing `/video` put `/create-intro-video` above `/videoer`: Prompt Shortcuts
accepted substring matches, then sorted non-exact slugs alphabetically. Agent
Commands ranked separately below the whole shortcut group. A typed slash query
now ranks available candidates from both sources in one list, with strict match
tiers and a source label; the bare trigger retains source groups. The evaluation
uses synthetic judgments and does not establish real-user search quality.

## Decision

The [command trigger Spec](../../../../specs/command-mention-triggers.md) owns
the visible contract. The shared ranker compares exact, prefix, word-prefix,
substring, subsequence, then description matches. A tuple keeps those tiers
strict: a long prefix cannot lose to a short substring through an additive
length penalty. Canonical tokens beat display names within a tier; position,
gaps, length, and lexical order settle ties. Availability gates still filter
shortcuts before ranking, and a visible disabled exact shortcut follows
selectable results.

Each source ranks before its 50-result cap so a relevant command cannot be
discarded by its source's alphabetical order. The direct slash view merges the
bounded candidates and applies a final 50-row cap. `@` category search and
bare `/` keep their existing presentation and source activation. The renderer
labels mixed rows with their source while retaining shortcut visibility text
and disabled reasons.

The existing Agent Command scorer was command-only, with additive scores whose
tiers could overlap. The vendored VS Code scorer gave `video` and `videoer`
the same score of 75 for the query `video`; using that score alone could not
guarantee exact-first ordering. `match-sorter` has similar tiers, but would
still need product-specific treatment for hyphenated tokens, descriptions,
availability, and cross-source presentation. A small shared comparator keeps
these decisions explicit without a new dependency.

## Verification and limits

[The synthetic ranking evaluation](../../../../packages/components/benchmarks/slash-search/eval.mjs)
has ten named intent cases. The previous group/alphabetical order put the
judged target first in 2/10; the new order does so in 10/10. Mean NDCG@5 is
0.683 versus 1.000 on those cases. On 1,000 synthetic rows over 100 runs in
Node 22.23.2, pure filtering and ranking measured 0.45 ms median and
0.95 ms p95 across repeated runs. These are local observations, not UI latency
or production traffic.

[Registry tests](../../../../packages/components/tests/mention-registry.test.ts)
cover both slash triggers, cross-source order, bare-trigger grouping, and real
Prompt Shortcut visibility and availability gates.
[Menu tests](../../../../packages/components/tests/mention-two-level-menu.test.tsx)
cover rendered source labels, order, and selection. In a standalone clone with
the required ACP submodules and Node 22, these suites passed 66/66 tests; the
full components suite passed 4,542/4,542, and the package typecheck passed.
The root `pnpm check` reached tests after typecheck and lint, then failed on an
independently reproducible, untouched CLI `workspace-git-service.test.ts`
GitHub-remote metadata assertion.
