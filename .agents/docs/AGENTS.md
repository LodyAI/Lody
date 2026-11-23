# Agent-maintained explanations

Follow [document maintenance](../README.md). This tree holds explanations that
agents write and keep current: architecture guides, protocol walkthroughs, and
how subsystems fit together. It is the home for content that outgrew an
`AGENTS.md` but is not a rule, not human-approved intent, and not one
directory's own index.

User-facing product documentation is not here. `site-docs/` owns the public site
behind `lody.ai/docs`, and human-reviewed behavior Specs live in
[`specs/`](../../specs/AGENTS.md). Do not add private implementation details,
operator configuration, deployment presets, sensitive data, or internal task
records; only public evidence belongs anywhere under `.agents/`.

## What belongs here

A page here answers a question that crosses module boundaries. Content owned
elsewhere stays there: a single directory's file-by-file responsibilities go in
that directory's `README.md`, next to the code that changes them; a binding
constraint stays in the nearest `AGENTS.md`; a decision and its rejected
alternatives go in [an Agent Note](../notes/AGENTS.md). See
[where content goes](../README.md#where-content-goes). Link to those homes
instead of copying them.

Explain responsibilities and important interactions before implementation
detail. Use the [structural writing guide](../README.md#structural-explanations)
for diagrams and views, and keep each view at one abstraction level. Diagrams
and file paths are maintained facts: when a change makes one wrong, fix it or
remove it in the same PR.

[Visual explanations](visual-explanations.md) is the worked-example companion to
the writing guide; the pull request template points contributors there.

Name the owning Spec for intent and the scoped `AGENTS.md` for invariants rather
than restating either. A page whose reason to exist is not visible in its
opening lines belongs somewhere else.
