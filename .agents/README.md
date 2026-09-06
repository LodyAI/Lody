# Document maintenance

Adopt this process incrementally. Humans confirm intent; agents check implementation,
explain changes, and identify risks. Keep routine fixes lightweight and migrate old
records only when their topic needs attention. Maintenance instructions use English;
Specs and Agent Notes follow the bilingual policy below.

| Need | Owner |
| --- | --- |
| Spec intent, status, and human approval | [Spec rules](../specs/AGENTS.md) |
| Cross-module explanations, guides, and diagrams | [Writing rules](docs/AGENTS.md) |
| Which document owns a piece of content | [Where content goes](#where-content-goes) |
| Important decisions, classification, and history | [Note rules](notes/AGENTS.md) |
| SHA protection for selected content | [Content review](content-review.md) |
| Invariants | Nearest existing `AGENTS.md`; notes explain rationale without duplicating constraints |

## Where content goes

An `AGENTS.md` that outgrows 8 KiB is not a formatting problem; it is content in
the wrong place. Route it rather than delete it:

| Content | Home | Why there |
| --- | --- | --- |
| A constraint that still binds | Nearest `AGENTS.md` | Only this chain is read for every change |
| One directory's file-by-file responsibilities | That directory's `README.md` | It changes whenever the directory does |
| An explanation crossing modules | [`.agents/docs/`](docs/AGENTS.md) | It answers a reader, not a directory |
| Product intent, guarantees, protocol | [`specs/`](../specs/AGENTS.md) | It needs explicit human approval |
| Why a choice was made, what was rejected | [Notes](notes/AGENTS.md) | It is dated history, not current authority |

Explanations live under `.agents/` rather than a root `docs/`: `site-docs/` already
owns the user-facing documentation at `lody.ai/docs`, and a second root `docs/`
would read as product documentation to anyone browsing the repository.

Splitting a constraint from its reason is normal and preferred: keep the one-line
rule in `AGENTS.md` and link the note that explains it. Never move a binding
constraint into a note or a `README.md` to buy bytes, because neither is
guaranteed to be read before a change. A directory whose index cannot fit is
usually under-structured; prefer child scopes over a longer parent.

The gate rejects an `AGENTS.md` at 8192 bytes, and warns above 7000 without
failing. Aim for the warning threshold, not the gate: a file that lands 30 bytes
under the limit breaks for whoever adds the next sentence, and that is rarely the
person who left it there. Route a topic out instead of trimming words.

## Current work

```sh
pnpm run docs status
pnpm run docs check
```

Status is derived from existing files: draft/outdated Specs, proposed notes,
pending/stale translations, and topics needing SHA review. Do not maintain a
separate global INDEX or TODO. Both commands are read-only. Check reports invalid
metadata, repository Markdown links (including archives), oversized `AGENTS.md`
files, and stale or broken registered topics. Warnings, including an `AGENTS.md`
nearing the size gate, are reported separately and never fail the check. Errors in one topic do not hide others. Pending
translation or Spec approval alone does not fail the check.

The [communication architecture draft](../specs/communication-architecture.zh.md)
is the pilot. SHA tooling exists, but protection scopes and baselines still need
review and registration. Unregistered topics have no SHA protection.

## Human review

Provide a short account of changed intent or responsibilities, the reason and cost,
and unresolved questions, with links to the detailed evidence. A generated summary
cannot replace a human decision. When code conflicts with a Spec, distinguish an
implementation bug, stale documentation, and an unimplemented requirement before
changing either. Do not automatically turn current code into the specification.

## Asynchronous bilingual documentation

Specs and notes eventually have adjacent English `.md` and Chinese `.zh.md` files.
Either language may come first. Translation does not block merging, and community
contributors need not know both languages. Use `Translation: pending | current | stale`;
link counterparts once available, keep their `Status:` values equal, and mark an older translation stale when meaning
changes. Keep actual code identical; explanatory labels in diagrams may be translated.
Translation cannot approve a Spec, and the tool does not assess translation accuracy.

## Starting work

1. Find the relevant Spec, scoped `AGENTS.md`, and active notes. Search archives for
   historical questions; do not treat past decisions as current behavior.
2. Run `pnpm run docs status`. Inspect changes to relevant protected topics with
   `diff --topic`; do not reread unrelated documents.
3. State conflicts between intent, implementation, and evidence. Do not guess product
   trade-offs or expand a small fix into a repository-wide audit.

## Finishing work

1. Use the actual diff to identify affected explanations and diagrams. Prepare a Spec
   draft for changes to human intent, update `.agents/docs/` for cross-module explanation
   and the owning README for directory navigation, and record important trade-offs
   under the [note rules](notes/AGENTS.md).
2. Search earlier decisions before writing a note. Identify additions, partial
   replacements, and full replacements. Update current conclusions in Specs, `.agents/docs/`,
   or owning READMEs so the next agent need not reconstruct history. Link adequate
   existing explanations.
3. Check existing invariants when identifying risk. Explain violations; propose
   evidence-backed changes to the nearest `AGENTS.md` when a rule is missing.
   Humans confirm important intent. Do not add a parallel risk inventory.
4. Run `pnpm run docs check` and follow [content review](content-review.md) for protected
   topics. Never refresh hashes merely to pass a check.
5. Give humans a concise review summary with evidence, completed checks, and gaps.
   Add the PR link after creation. Use status output to surface translation debt;
   never invent approval or a PR that does not exist.

## Scoped audits

Audit a domain when useful; this is not a prerequisite for every small fix.

1. Select one domain. Compare fix PRs, notes, Specs, and source for conflicting claims,
   obsolete decisions, broken links, translation debt, and repeatedly missed constraints.
2. Attach concrete evidence and user impact to each risk. Distinguish single defects
   from recurring patterns. A single severe defect can justify action; complexity alone
   is not evidence of risk.
3. Report actionable findings, their proposed owner, and decisions requiring human input.
   Write important discoveries back to the owning document or note. Explain corrections
   when new evidence overturns earlier conclusions.
4. Do not expand rules without new evidence. Retain history for its value to future
   decisions, not to meet a document-count quota.

## Structural explanations

Choose the smallest view that answers the reader's question:

- Pseudocode for decisions and algorithms; call trees for runtime order.
- Component trees for UI containment, state owners, hooks, and module boundaries.
- Shallow file trees for responsibilities; Mermaid for interactions and data flow.
- Structural diffs for local changes to components, files, calls, or state logic.
- Whole blocks for mostly new structures or when omission hides ownership/order.

One view uses one abstraction level and one meaning of indentation. Expand a
module separately instead of mixing product features with internal functions.
Place visuals beside short explanations, mark conceptual sketches, and keep real
paths accurate. Diagrams are maintained facts too. Use HTML only when a static
view cannot explain the point; prose must remain independently understandable.
Worked examples live in [visual explanations](docs/visual-explanations.md); the
PR template points there so outside authors need nothing installed.
