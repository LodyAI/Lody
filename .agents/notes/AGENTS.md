# Agent Notes

Notes are the repository's decision memory for human and agent contributors: the
why, the rejected alternatives, and the evidence that code and docs cannot carry.
Shared maintenance and publication rules come from the [parent instructions](../AGENTS.md).
The rationale for these rules is recorded in
[note memory hygiene](implemented/process/2026-10-28-agent-note-memory-hygiene.md).

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

## Linking

Notes are found through the documents agents already read before changing code.
Every active note is linked from its current-state owner: the README section,
`.agents/docs/` page, `AGENTS.md` rule or Spec covering the code or process it
explains. The owner states in a sentence what is true now; the note explains why.
Several notes about one module or provider become one owner section with a line
per behavior, so a reader sees the current set without reconstructing it from
dated records. The check rejects a new note that no such document links; a link
from another note does not count. `pnpm run docs status` lists existing active
notes without an owner link (`unlinkedNotes`).

## Maintenance on read

Memory is maintained where it is used. When a task relies on a note and finds it
wrong, fix it in the same PR, limited to notes the task actually relied on:

- A cited path, symbol or default moved: update the fact (implemented notes only).
- No owner link: add the one-line entry and link to the owner, or archive or delete
  the note through the [archive skill](../skills/archive-agent-notes/SKILL.md) if
  it no longer guides work.
- Wrong lifecycle: the PR that implements a proposal moves it to `implemented/` and
  rewrites its plan in the present tense; a proposal shown obsolete is rejected.
- A later note corrects it: apply the supersession rules below.

## Opening abstract

After the title, metadata, and language link, start the body with `## Abstract`
(`## 摘要` in Chinese): one short, self-contained paragraph, usually three to five
sentences, giving the concrete problem and its impact, the chosen or proposed
approach, and the outcome or conclusion, plus the most important trade-off or
unresolved limit when it changes how the reader should interpret the result. A
proposal states what is proposed and what remains unverified; never present
expected benefits as measured results.

The abstract is what a future agent reads first and often only. Avoid file
inventories, chronology, and generic claims such as "improves maintainability".

## Lifecycle and type

Paths are `{lifecycle}/{type}/yyyy-mm-dd-topic.md` with an adjacent `.zh.md`
counterpart. Lifecycle is the decision's state and type is its subject; a
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
- `archived/` + `Status: implemented` and `Archived: YYYY-MM-DD`: frozen snapshots
  of implemented decisions that no longer guide work; never current authority.

| Folder           | Decision concerns                                         |
| ---------------- | --------------------------------------------------------- |
| `architecture`   | Module responsibilities, ownership, and communication     |
| `feature`        | Important new user or agent capability                    |
| `bug-fix`        | A defect exposing a consequential, non-obvious constraint |
| `simplification` | Removing complexity or capability and its trade-offs      |
| `process`        | Contributor workflows, tooling, and repository policy     |
| `testing`        | Verification strategy or test infrastructure              |

Pick the type of the decision, not every affected surface. `pnpm run docs status`
lists active notes whose cited repository paths no longer exist
(`staleReferences`); handle them under [maintenance on read](#maintenance-on-read).

## Verification

Evidence is kept; run logs are not. Measurements, reproduction commands, benchmark
tables and their conditions belong in the body or `assets/` because a future
reviewer needs them. A `Verification` section links the test, story or fixture
that pins each behavior and names what remains unverified. Pass counts, lint or
documentation-check results and environment notes carry no future value; the
status command warns about them in changed notes.

## History and language

Translation follows the [shared language policy](../README.md#asynchronous-bilingual-documentation).
An Agent author lands both `.md` and `.zh.md` in the same change, cross-linked,
with equal `Status:`, the same abstract meaning, and `Translation: current`;
`Translation: pending` is only for a human who cannot write the other language.

A note does not require a companion [Spec](../../specs/AGENTS.md). Identify factual
corrections as corrections. Repair a broken link target in an archived note
without changing its rationale. Do not add a global index or log that every
contribution must modify.
