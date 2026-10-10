# Human-reviewed Specs

Follow [document maintenance](../.agents/README.md). This directory
contains only publicly shareable client behavior, architecture, and protocol
Specs. No private implementation, operator configuration, or internal records.
Use public evidence and identify what this repository cannot establish.

Create or expand a Spec only when the user explicitly requests one or there is a
consequential decision that needs human review: for example, data ownership,
security boundaries, durability, compatibility, or a major product/architecture
trade-off. Routine PR review and behavior changes alone are insufficient. Ordinary
fixes, features, refactors, retry timings and testing details belong in owning docs
and Notes.

Before creating a file, name the decision and review need in the PR or owning Note
and check whether an existing Spec covers it. Prefer updating that owner. Keep one
Spec per enduring decision, rather than per PR or fix; do not duplicate code or Notes.
Default to a few short paragraphs covering the scenario, decision and essential
guarantees. Link implementation and validation details instead of copying them;
add length or sections only when needed to review the decision.

Translation follows the [shared language policy](../.agents/README.md#asynchronous-bilingual-documentation).
Use the [structural writing guide](../.agents/README.md#structural-explanations)
for diagrams, [`.agents/docs/`](../.agents/docs/AGENTS.md) for explanation that
is not intent,
and the [scoped SHA workflow](../.agents/content-review.md) for protected content.

Specs express human intent and help people understand the system. Start with a
scenario, then the responsibilities and important interactions. Be concise; omit
incidental implementation detail. Deliberate abstraction is allowed, but do not
make permissions, data ownership, durability, or other important guarantees mean
opposite things to different readers. Name unresolved questions rather than guess.

Use `Status: draft | approved | outdated` and `Translation: pending | current | stale`
as separate metadata. `approved` requires a link to explicit human approval of the
relevant revision. Changed intent or guarantees return to draft; editorial changes
retain approval only when the approved meaning is unchanged. Translation status
does not assert behavioral correctness. A translated draft remains a draft.

Keep evidence paths in a short final section, separate from the explanation.
Distinguish intended behavior, inspected implementation, and executed validation.
When they disagree, record the gap; do not silently turn a bug into a requirement.

Existing documents enter review as outdated, not automatically approved. Migrate
one topic when useful; do not bulk-import or bulk-mark unrelated documentation.
Refer to existing scoped `AGENTS.md` invariants instead of creating a parallel list.
