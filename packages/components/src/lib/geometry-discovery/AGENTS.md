# `components/src/lib/geometry-discovery` — heuristic layout discovery

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only. Package
[AGENTS.md](../../../AGENTS.md) and [src/lib/AGENTS.md](../AGENTS.md) apply.

The authored path — `geometry-contracts.json`, its compiled contracts and the ratchet in
[tests/e2e](../../../tests/e2e/AGENTS.md) — only finds what a reviewer already wrote down,
and names its members by DOM shape. This directory is the other half: expectations are
MINED from what the product repeatedly renders, and nobody writes the number down.

`visual-capture.ts` projects each persisted capture's complete block-candidate rectangles
into one atom per primitive, deduplicating anchors and overlapping scopes. Mine each capture
independently; DOM ordinals are capture-local references, not durable finding identities.
Labels, scopes and Fiber pointers are report evidence only and never grouping inputs.
The report writes `visual-repetition.json` beside the existing rail artifacts and displays
all ranked deviations as untriaged candidates, outside findings, ledger and gate.
Screenshot overlays reuse the owning capture's clean overview and clip; a capture without
an overview says so explicitly. Dominant/peer primitive references travel with the deviation
as witnesses, never as finding keys.
A recall-first pass that blocks CI has exactly one natural remedy, raising its thresholds,
which destroys the recall it exists for.

## Grouping is visual. Never structural.

Atoms are grouped by what RENDERS alike — the geometry-derived primitive kind, folded where
the difference is not painted (`link`/`button`, `numeric-text`/`text`), and height clustered
by distance to a fixed anchor (never hard rounding buckets),
never content-sized width. Never key a group on row family, role, accessible name, or DOM
ancestry.

The reason is not purity. A layout defect almost always comes from two code paths rendering
one visual thing differently — the sidebar's 26px tree indent slot and the mobile screen's
32px one are separate constants in separate files. So the defect CORRELATES with the
structural difference, and a structural key files the two paths into different groups and
never compares them: the more real the bug, the more reliably it is hidden. The reader
perceives a column because pixels line up, not because elements share a tag.

`VisualAtom.id` names a primitive within one capture and must stay out of grouping. The
moment identity decides who is compared with whom, that blindness is back.

## Levels grow to an ANCHOR, not to a neighbour

A coordinate joins a level by distance to the level's anchor. Single linkage would let a
run of intermediate values walk one level into the next and merge two indentation depths
into one expectation — the merged level then reads as internally perfect and the deviation
disappears. Same failure the geometric row band avoids on Y.

## Locality comes before orientation, and never becomes a partition

A series is isolated first and its axis settled afterwards. Both orientations are
hypothesised; a group is banded along each (centres within half a box share a band), a series
takes at most ONE member per band, and lanes track across bands by nearest cross-axis
distance bounded by the group's own band step. The wrong hypothesis then costs nothing — a
toolbar collapses into one vertical band and dies as runs of one — and a run both produced is
settled by its own spread. Asking a whole signature group for its axis is the failure this
replaces: two side-by-side lists spread wider than either runs deep, so the page-wide answer
was "horizontal", every grid row was mined as one series, and a regular grid manufactured a
high-scoring Y deviation per row and a pitch deviation per column break.

Locality bounds grouping; it must never delete membership. A lane of one is not a lane, it is
one box that left, so a lone residual rejoins the nearest real series and is mined there at
whatever delta it has. Without that, the rule would punish the clearest defects hardest: the
further a box flies, the more certainly it would become its own lane and vanish. Two boxes
agreeing on a position are left alone — that is a sparse column, not a defect.

Do not keep only a series' best-agreeing alignment measure. `start`, `end` and `center` are
three views, and a box that is only WIDER agrees on `start`; dropping the others buys silence
on variable-width text by deleting real width drift. That text ambiguity is deliberate and
stays unresolved here — no classifier, no typography model, no intent inference.

## Recall is the bias, and ranking is not filtering

Nothing is dropped for looking weak. Candidates carry a `score` and are sorted; no
threshold removes one. A legitimate indent ladder therefore comes back as deviations too,
because without being told which level was intended it has to — it ranks low since `score`
falls as a level's own support rises, so a value two boxes share outranks one forty share.

A missed misalignment is invisible forever; a false one costs a triage glance. Any tie
breaks towards reporting more. Only the axis perpendicular to a run carries expectations
worth mining, plus pitch along it.

## The report's default queue is attention, not truth

`peerSupport` counts the DEVIATING level, so a singleton is what the scorer ranks highest —
one box alone off its series edge. A `peer >= 2` default queue therefore hid the candidates
the ranking believed in most, and showing every singleton is the same as having no queue. The
template ranks, folds one atom's repeated edge measurements into one card (exposing every
folded measurement and its witnesses), keeps every card with any peer support, and admits the
best-scoring `VISUAL_SINGLETON_REVIEW_BUDGET` isolated cards PER CAPTURE — per capture, so a
noisy screen cannot drain a quiet screen's only candidate. Never replace that budget with a
confidence threshold. `visual-repetition.json` and "All raw deviations" keep everything; a
candidate the budget withheld is unshown, never unfound, and neither an admitted nor a
withheld one is a finding, ledger entry or gate verdict.
