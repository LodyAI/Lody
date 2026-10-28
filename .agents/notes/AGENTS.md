# Agent Notes

Notes are the repository's decision memory for human and agent contributors: the
why, the rejected alternatives, and the evidence that code and docs cannot carry.
Shared maintenance and publication rules come from the [parent instructions](../AGENTS.md).

## When to write

Add or update a note in the same PR only for durable decision rationale that code,
tests, Specs, and existing docs do not explain. A note qualifies when it records at
least one of: a genuine alternative and why it lost; a constraint that tests and
types cannot enforce; a measurement with its conditions; a storage, wire, protocol
or configuration format change; an ownership or responsibility boundary. Research
or design that produces a substantial proposal or a consequential finding needs a
note even without a PR; record it as `proposed` and never invent approval or
verification. If the task forbids file writes, report the intended note instead.

A bug fix earns a note only when it exposes such a constraint or alternative; a
fix that is merely done belongs in its PR description and regression test.
Mechanical or local edits, including local UI presentation and interaction
changes, are exempt. A short diff is not an exemption and a long one is not a
reason.

Record the problem, the decision, evidence-backed discoveries, genuine alternatives,
trade-offs, consequences, verification limits, and the PR link when it exists.
Do not invent alternatives or PRs.

A note is not overflow space for an oversized `AGENTS.md`. A constraint that still
binds stays in the nearest `AGENTS.md` with its rationale linked here; see
[where content goes](../README.md#where-content-goes).

## Supersession

Every new note triggers a supersession check. Before drafting, search active notes
(`proposed/` and `implemented/`) for the same decision, mechanism or rejected
alternative, then classify each match in the same PR:

- **Owning note exists:** update it instead of creating a duplicate.
- **Fully superseded implemented note:** archive it and list it in the new note's
  `Supersedes:` metadata line; the check rejects a `Supersedes` target that is
  still active. Carry every unique rationale, alternative, measurement and
  reintroduction condition into the new owner first.
- **Partially superseded:** keep both active and cross-link them; update the facts
  that remain current in the older note.
- **Obsolete proposal:** reject it with the reason; never archive a proposal.

Use the [archive-agent-notes skill](../skills/archive-agent-notes/SKILL.md) for
classification and the archive procedure. Judge by future decision value, not by
word count, age or a quota.

## Opening abstract

After the title, metadata, and language link, start the body with `## Abstract`
(`## 摘要` in Chinese): one short, self-contained paragraph, usually three to five
sentences, giving the concrete problem and its impact, the chosen or proposed
approach, and the outcome or conclusion, plus the most important trade-off or
unresolved limit when it changes how the reader should interpret the result. A
proposal states what is proposed and what remains unverified; never present
expected benefits as measured results.

The abstract is what a future agent reads first and often only. Avoid file
inventories, unexplained acronyms, chronology, and generic claims such as
"improves maintainability". Both language versions carry the same abstract meaning.

## Lifecycle and type

Paths are `{lifecycle}/{type}/yyyy-mm-dd-topic.md` with an adjacent `.zh.md`
counterpart. Lifecycle answers "what state is the decision in?"; type answers
"what is the decision about?" Every lifecycle uses the same type set, and a
lifecycle move updates paths, status, translations, and inbound links together.

- `proposed/` + `Status: proposed`: pending decisions or work still under review.
  Its body may speak in the future tense: plans, acceptance criteria, open questions.
- `implemented/` + `Status: implemented`: an adopted decision in practice, written
  in the present tense and **kept current with what shipped**. When a later change
  moves a file, renames a symbol, or changes a default this note cites, update the
  fact in the same change; do not append change history. The decision and its
  rationale are not rewritten: a reversal is a new linked note. Proposal-era
  headings (`## Plan`, `## Migration plan`, `## Acceptance criteria`, `## Proposal`)
  are rejected here; fold them into `## Decision` and `## Consequences`. This
  status does not approve a linked Spec.
- `rejected/` + `Status: rejected`: explain why it was declined. Keep it only while
  that reason prevents a plausible mistake; otherwise delete the language pair.
- `archived/` + `Status: implemented` and `Archived: YYYY-MM-DD`: frozen historical
  snapshots of implemented decisions no longer useful as active guidance. Never
  edit, translate, or reformat them, and never cite them as current authority.
  Archive only implemented notes.

| Folder           | Decision concerns                                         |
| ---------------- | --------------------------------------------------------- |
| `architecture`   | Module responsibilities, ownership, and communication     |
| `feature`        | Important new user or agent capability                    |
| `bug-fix`        | A defect exposing a consequential, non-obvious constraint |
| `simplification` | Removing complexity or capability and its trade-offs      |
| `process`        | Contributor workflows, tooling, and repository policy     |
| `testing`        | Verification strategy or test infrastructure              |

Pick the type of the decision, not every affected surface. `pnpm run docs status`
lists active notes whose cited repository paths no longer exist; update or
archive them when their topic is touched.

## Verification

Evidence is kept; run logs are not. Measurements, reproduction commands, benchmark
tables and their conditions belong in the body or `assets/` because a future
reviewer needs them. A `Verification` section links the test, story or fixture
that pins each behavior and names what remains unverified. Pass counts, lint
warning counts, "this checkout" environment notes and documentation-check
results carry no future value; the status command warns when a changed note
contains them.

## History and language

Translation follows the [shared language policy](../README.md#asynchronous-bilingual-documentation).
When the author is an Agent, land both `.md` and `.zh.md` in the same change:
cross-link the two languages, keep their `Status:` equal, carry the same
Abstract/摘要 meaning, and mark both `Translation: current`. `Translation: pending`
remains available only to a human who cannot write the other language.

Keep current implementation behavior in owning docs; only consequential
human-reviewed intent belongs in [Specs](../../specs/AGENTS.md). A Note does not
require a companion Spec. Identify factual corrections as corrections. Repository-wide
link checks include archives; repair a broken link target without changing the
historical rationale. Do not add a global index or log that every contribution
must modify.
