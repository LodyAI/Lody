# Agent Notes

Notes are important decision records for human and agent contributors. Shared
maintenance and publication rules come from the [parent instructions](../AGENTS.md).

## When to write

Write or update a note when a future maintainer could reasonably choose another
approach and missing its rationale could cause material harm. Routine styling,
local keyboard/focus fixes, and mechanical edits normally need only a PR summary.
Updating an affected Spec is separate, even when no note is needed.

Record the problem, responsibilities, evidence-backed discoveries, genuine
alternatives, trade-offs, outcome, verification limits, and PR link when available.
Do not invent alternatives or PRs.

A note is not overflow space for an oversized `AGENTS.md`. Nothing makes an agent
read a dated note before changing a file, so a constraint that still binds stays
in the nearest `AGENTS.md` even when its rationale moves here; leave the one-line
rule in place and link the note. See
[where content goes](../README.md#where-content-goes).

## Opening abstract

After the title, metadata, and language link, start the body with `## Abstract`
(`## 摘要` in Chinese). Write one short, self-contained paragraph, usually three
to five sentences, like a paper abstract in plain language: the concrete problem
and its impact, the chosen or proposed approach, and the outcome or conclusion.
Include the most important trade-off or unresolved limit when it changes how the
reader should interpret the result. A proposal states what is proposed and what
remains unverified; never present expected benefits as measured results.

Readers should understand the decision without opening links or reading the rest.
Avoid file inventories, unexplained acronyms, chronology, and generic claims such
as "improves maintainability." Keep implementation evidence and detailed alternatives
in the body. Both language versions carry the same abstract meaning.

## Lifecycle and type

Paths are `{lifecycle}/{type}/yyyy-mm-dd-topic.md` with an adjacent `.zh.md`
counterpart; either language may be authored first. Create folders when a note
needs them, not a full matrix of empty directories.

The two axes are independent: lifecycle answers "what state is the decision in?";
type answers "what is the decision about?" Every lifecycle uses the same type set.
For example, a process proposal starts at `proposed/process/`; once adopted and
implemented, move its language pair to `implemented/process/`. Its type stays the same.
A runtime architecture proposal belongs in `proposed/architecture/` instead.

Lifecycle and the `Status:` line agree:

- `proposed/` + `Status: proposed`: pending decisions or work still under review.
- `implemented/` + `Status: implemented`: an adopted decision put into practice;
  name the evidence and remaining limits. This does not approve a linked Spec.
- `rejected/` + `Status: rejected`: explain why it was declined. Retain it while
  that reason can prevent a plausible mistake.
- `archived/` + `Status: implemented` and `Archived: YYYY-MM-DD`: historical
  implemented decisions no longer useful as active guidance. They are not current
  authority. Archive only implemented notes; obsolete proposals need a verdict.

Types:

| Folder | Decision concerns |
| --- | --- |
| `architecture` | Module responsibilities, ownership, and communication |
| `feature` | Important new user or agent capability |
| `bug-fix` | A defect exposing a consequential, non-obvious constraint |
| `simplification` | Removing complexity or capability and its trade-offs |
| `process` | Contributor workflows, tooling, and repository policy |
| `testing` | Verification strategy or test infrastructure |

Pick the type of the decision, not every affected surface. Small fixes remain
exempt even though a bug-fix folder exists. A lifecycle move updates paths,
status, existing translations, and inbound links together.

## History and language

Translation follows the [shared language policy](../README.md#asynchronous-bilingual-documentation).

Implemented notes preserve the decision in its historical context. Current
behavior belongs in Specs; important later changes use a new linked note. Identify
factual corrections as corrections. Adding a note includes a scoped search for
related decisions: link partial replacements and archive obsolete implemented
records only when their rationale is no longer useful. Do not rewrite an old
choice into its opposite or silently remove rationale still constraining work.

Archived bodies are historical snapshots; use active documentation for current
facts and new linked records for corrections. Pending translations may be added
without rewriting the original history. Repository-wide link checks include archives;
repair broken link targets without changing the historical rationale. There is no
automated archive seal yet.
Do not add a global index or log that every contribution must modify. Search
proposed and implemented notes for current work; search archives explicitly for
historical questions, not as current authority.
