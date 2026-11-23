# Document maintenance

Adopt this process incrementally. Humans confirm intent; agents check implementation,
explain changes, and identify risks. Keep routine fixes lightweight and migrate old
records only when their topic needs attention. Maintenance instructions use English;
Specs and Agent Notes follow the bilingual policy below.

| Need                                             | Owner                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Spec intent, status, and human approval          | [Spec rules](../specs/AGENTS.md)                                                      |
| Cross-module explanations, guides, and diagrams  | [Writing rules](docs/AGENTS.md)                                                       |
| Which document owns a piece of content           | [Where content goes](#where-content-goes)                                             |
| Important decisions, classification, and history | [Note rules](notes/AGENTS.md)                                                         |
| SHA protection for selected content              | [Content review](content-review.md)                                                   |
| Invariants                                       | Nearest existing `AGENTS.md`; notes explain rationale without duplicating constraints |

## Where content goes

An `AGENTS.md` that outgrows its word ceiling is not a formatting problem; it is
content in the wrong place. Route it rather than delete it:

| Content                                              | Home                              | Why there                                                                 |
| ---------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------- |
| A constraint that still binds                        | Nearest `AGENTS.md`               | Only this chain is read for every change                                  |
| One directory's file-by-file responsibilities        | That directory's `README.md`      | It changes whenever the directory does                                    |
| An explanation crossing modules                      | [`.agents/docs/`](docs/AGENTS.md) | It answers a reader, not a directory                                      |
| Consequential intent/guarantees needing human review | [`specs/`](../specs/AGENTS.md)    | Keep only the decision and essential guarantees; prefer an existing owner |
| What a past decision means for the code today        | Owning README or `.agents/docs/`  | One sentence of current state, linking the note that explains it          |
| Why a choice was made, what was rejected             | [Notes](notes/AGENTS.md)          | It is dated history, not current authority                                |

Explanations live under `.agents/` rather than a root `docs/`: `site-docs/` already
owns the user-facing documentation at `lody.ai/docs`, and a second root `docs/`
would read as product documentation to anyone browsing the repository.

Splitting a constraint from its reason is normal and preferred: keep the one-line
rule in `AGENTS.md` and link the note that explains it. Never move a binding
constraint into a note or a `README.md` to buy bytes, because neither is
guaranteed to be read before a change. A directory whose index cannot fit is
usually under-structured; prefer child scopes over a longer parent.

For a cross-directory contract, keep its definition in the owning module's
`AGENTS.md` and an explicit "before changing X, read Y" instruction at the common
ancestor. Name caller behavior as well as owner files: a rule about a catalog also
binds its UI and dispatch consumers. A bare background link is not a required-read
trigger. Check every affected caller before removing the ancestor's full definition.

When simplifying instructions, compare the words of the ancestor chain for typical
source paths, as well as individual file sizes. Count each `AGENTS.md` once, without
its `CLAUDE.md` alias. Report conditional topic reads separately: relocating a rule
reduces unrelated tasks' input, but does not remove relevant tasks' reading duties.
These measurements are diagnostic, not an additional approval or size gate.

### Word ceilings

[`scripts/docs/agents-budgets.json`](../scripts/docs/agents-budgets.json) holds a
default word ceiling for every `AGENTS.md` and per-file overrides. The check fails
a file above its ceiling and warns from 90% of it. When the gate goes red, in order:

1. **Relocate** a topic that belongs in a child scope, a README, `.agents/docs/`
   or a note, leaving the one-line rule and a link.
2. **Condense** only where a rule survives intact. Compressing full sentences
   into fragments to buy words is the failure mode the ceiling exists to prevent:
   a rule nobody can read without the PR that wrote it is not a rule.
3. **Raise** the ceiling in the manifest when the content genuinely needs the
   space, and justify the manifest diff in the PR. A ceiling that is too low is a
   budget bug, not a reason to delete a rule.

Ceilings are guardrails, not reduction targets. Keep headroom for the next
sentence; a file that lands a few words under the ceiling breaks for whoever
edits it next.

## What not to write

Hunt these in any document before submitting; the status command warns about
some of them in changed notes:

- A rule duplicated across documents: keep one home and link the rest.
- Implementation-status annotations in prose or diagrams ("implemented!",
  "future: …"): status rots; the repository layout carries it.
- Hand-restated catalogs, inventories of tests or files, or JSDoc restated in prose
  when source or a generator is authoritative.
- Reasoning transcripts: step-by-step implementation narration, test walkthroughs,
  resolved temporary errors, run results, environment notes. Keep the resulting
  contract, measurement or rationale; delete the path used to derive it.
- Proposal language in an implemented note: "should", plans, acceptance checklists.
- Emphasis inflation: bold, capitals or "critically" everywhere means nothing
  stands out.

## Current work

```sh
pnpm run docs status
pnpm run docs check
```

Status is derived from existing files: draft/outdated Specs, proposed notes,
pending/stale translations, active notes citing repository paths that no longer
exist (`staleReferences`), active notes no README, `.agents/docs/` page,
`AGENTS.md` or Spec links (`unlinkedNotes`), and topics needing SHA review. Do not maintain a
separate global INDEX or TODO. Both commands are read-only. Check reports invalid
metadata, repository Markdown links (including archives), `AGENTS.md` files over
their word ceiling, `Supersedes` targets that are not archived, new notes without
a current-state owner link, and stale or
broken registered topics. Note hygiene gates (proposal-era headings in an
implemented note, run-log phrases) apply only to notes the task changed, against
`--base` in CI and `HEAD` locally; earlier records are not reopened. Warnings,
including an `AGENTS.md` nearing its ceiling and run-log phrases, are reported
separately and never fail the check. Errors in one topic do not hide others.
Pending translation or Spec approval alone does not fail the check.

The Node implementation awaits asynchronous Git subprocesses, preserving binary
blob and NUL-separated path output. Imported command/report functions return
Promises. Git failures retain exit/signal and stderr diagnostics; only the content
comparison accepts `git diff --no-index` exit code 1 as a successful difference.
Truncated output remains an error.

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
contributors need not know both languages. Agents are the exception: an
agent-authored Spec or note ships both languages in the same change, per the
[note language rule](notes/AGENTS.md#history-and-language).
Use `Translation: pending | current | stale`;
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

1. Use the actual diff and research/design conclusions to identify affected explanations and diagrams.
   Apply the [Spec selection rules](../specs/AGENTS.md); a routine behavior change does
   not require a new Spec. Update `.agents/docs/` for cross-module explanation and
   the owning README for implementation behavior and directory navigation. Non-trivial work adds or updates
   an Agent Note in the same PR under the [note rules](notes/AGENTS.md#when-to-write);
   design-only work records its conclusions without inventing a PR.
2. Run the [supersession check](notes/AGENTS.md#supersession) before writing a
   note: update the owning note, archive fully superseded ones, cross-link partial
   replacements. Update current conclusions in Specs, `.agents/docs/`, or owning
   READMEs so the next agent need not reconstruct history. Link every new note from
   that current-state owner; the check rejects a new note only other notes link.
   When the diff moves or renames something an implemented note cites, update that
   fact in the note, and apply [maintenance on read](notes/AGENTS.md#maintenance-on-read)
   to any note the task relied on.
3. Check existing invariants when identifying risk. Explain violations; propose
   evidence-backed changes to the nearest `AGENTS.md` when a rule is missing.
   Humans confirm important intent. Do not add a parallel risk inventory.
4. Run `pnpm run docs check` and follow [content review](content-review.md) for protected
   topics. Never refresh hashes merely to pass a check.
5. An Agent that writes or updates a Spec or Agent Note adds or refreshes its
   counterpart language in the same change. Do not merge an agent-authored note
   as `Translation: pending` when the agent can write both languages; see the
   [note language rule](notes/AGENTS.md#history-and-language).
6. Give humans a concise review summary with evidence, completed checks, and gaps.
   Add the PR link after creation; never invent approval or a PR that does not exist.

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
PR template points there so outside authors need nothing installed. Every PR fills
its visual-explanation section; changes over 200 lines must include a structural
view, while semantic complexity remains a reviewer judgment.
