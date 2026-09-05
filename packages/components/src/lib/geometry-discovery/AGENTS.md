# `components/src/lib/geometry-discovery` — heuristic layout discovery

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only. Package
[AGENTS.md](../../../AGENTS.md) and [src/lib/AGENTS.md](../AGENTS.md) apply.

The authored path — `geometry-contracts.json`, its compiled contracts and the ratchet in
[tests/e2e](../../../tests/e2e/AGENTS.md) — only finds what a reviewer already wrote down,
and names its members by DOM shape. This directory is the other half: expectations are
MINED from what the product repeatedly renders, and nobody writes the number down.

Not yet wired to the capture run or the gate. It is a report, and it stays one until its
findings have been triaged once: a recall-first pass that blocks CI has exactly one natural
remedy, raising its thresholds, which destroys the recall it exists for.

## Grouping is visual. Never structural.

Atoms are grouped by what RENDERS alike — the geometry-derived primitive kind, folded where
the difference is not painted (`link`/`button`, `numeric-text`/`text`), and quantised height,
never content-sized width. Never key a group on row family, role, accessible name, or DOM
ancestry.

The reason is not purity. A layout defect almost always comes from two code paths rendering
one visual thing differently — the sidebar's 26px tree indent slot and the mobile screen's
32px one are separate constants in separate files. So the defect CORRELATES with the
structural difference, and a structural key files the two paths into different groups and
never compares them: the more real the bug, the more reliably it is hidden. The reader
perceives a column because pixels line up, not because elements share a tag.

`VisualAtom.id` exists to name a finding across runs and must stay out of grouping. The
moment identity decides who is compared with whom, that blindness is back.

## Levels grow to an ANCHOR, not to a neighbour

A coordinate joins a level by distance to the level's anchor. Single linkage would let a
run of intermediate values walk one level into the next and merge two indentation depths
into one expectation — the merged level then reads as internally perfect and the deviation
disappears. Same failure the geometric row band avoids on Y.

## Recall is the bias, and ranking is not filtering

Nothing is dropped for looking weak. Candidates carry a `score` and are sorted; no
threshold removes one. A legitimate indent ladder therefore comes back as deviations too,
because without being told which level was intended it has to — it ranks low since `score`
falls as a level's own support rises, so a value two boxes share outranks one forty share.

A missed misalignment is invisible forever; a false one costs a triage glance. Any tie
breaks towards reporting more. Series orientation is measured rather than declared, and
only the axis perpendicular to the run carries expectations worth mining.
