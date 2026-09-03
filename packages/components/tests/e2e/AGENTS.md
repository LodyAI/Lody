# Geometry constraint system

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
Package `AGENTS.md` and the repository root also apply.

Measures rendered geometry, turns it into findings, gates what a human promoted.
`src/lib/chat-workspace-geometry.ts` (spec, grid, discovery) and
`geometry-constraint-system.ts` (pipeline, ledger, contracts, tokens, metrics); grid and
classification: [src/lib](../../src/lib/AGENTS.md); what a primitive, a row and a name ARE,
and the shared capture plan: [support](support/AGENTS.md); `*-geometry-report.spec.ts`
(report), `*-geometry.spec.ts` (gate). Neither `geometry:report` nor `geometry:triage`
moves a baseline.

## X rails

Heuristic, before any finding exists.

- One member per repeated subtree instance per rail: a control and its nested icon do not
  manufacture support. `data-geometry-discovery-scope` is a hint, alignment attributes are
  never read, `session.messages` and its Markdown descendants are excluded.
- Repeated row modes establish rails before singletons attach to the nearest mode,
  independent of DOM order; intermediate coordinates must not chain distinct indentation
  levels. Rendered coordinates decide, every candidate stays eligible scope-wide, and an
  extra candidate beats excusing a shifted module.
- Two repeated visible rows establish a local indentation rail, never absorbed into a
  better-supported one. Peaks merge only within the inlier tolerance, so peaks 1px apart
  are distinct levels; members outside it are outliers, and confidence includes span.
- A rail of one kind takes only that kind unless it has mixed support; members share a row
  family or a kind, and a two-support rail never crosses a partition.

## Y rails

Marker-free, same pipeline, over the anchors [support](support/AGENTS.md) lists.

- A Y rail is ONE row instance, observed once per CAPTURE over the union of every scope's
  Y candidates, so an aggregate scope and its child cannot measure a row differently. Line
  = row median after snapping to the capture DPR grid, which every coordinate on both axes
  passes; past the inlier tolerance a member is an outlier with a direction (↑/↓). Under
  two members, no rail.
- Only `visual-center` compares kinds; `block-center` is content independent but
  line-height dependent, so both stay. A block EDGE rail takes one kind: an icon top and a
  line-box top claim nothing.
- ONE element is ONE finding. The row picks the verdict anchor from what it is MADE OF —
  `visual-center` mixing text with an icon, image or painted shape, `text-baseline` when
  every member is text, else `block-center` — and offset, classification and repair come
  from it alone. Other anchors are supporting measurements; every row member travels with
  the evidence, so a card annotates rather than measures.
- Exactly two members is one `row-spread` naming both, never two outliers at half the gap:
  their median is their midpoint, so a signed offset would invent a direction. Three or more
  have a majority, so their median is a line.
- `marker-removal-readiness.json` asks whether discovery has replaced the markers
  ([support](support/AGENTS.md)). The gate proves outlier reporting with its OWN injected
  `translateY`, diffing before and after, asserting no product row.

## Pipeline and finding identity

`capture.json` → `observation.json` → `findings.json`, each stage reading only the previous;
content hashes reuse byte-identical observations. Child scopes summarise supported rails,
parents cluster those with unclaimed singletons.

Identity is STRUCTURAL and coordinate-free: surface family, landmark, section, row family,
family-instance index in the section, role, same-role index, plus the X anchor — a Y key
carries the axis instead, its anchor being a verdict. **The accessible name is ALWAYS a
label, never key material**: a locale switch, a renamed fixture or another checkout must
not mint a second finding for one element. The family-instance index tells apart three
same-shaped singleton rows (Settings, Help, Archive) and is DROPPED where the (section, row
family) aggregates — more instances than an enumeration renders, or an instance named from
its contents or from DATA (a `/` path segment, a space-padded `·`, a duration or date
token) — so ten chat rows stay one finding. Section is element-derived: a task row and a
chat row of one family are two findings. Findings merge evidence across captures keeping
the first capture's label; repeated instance rules with identical member offsets are
measurement-model divergences, not repeated violations.

A structural improvement RE-KEYS reviews, and a decision nobody carries forward is made
twice. Each entry records the identity it reviewed (label, axis, anchor, surface);
`diffGeometryFindings` pairs a resolved key with a new one as `rekeyed` — same label, or,
where a locale makes labels unmatchable, same axis + anchor + surface with |offset| within
0.25px — and triage MOVES status, reason and baseline there rather than report resolved and
new. Pairing is one-to-one; an entry without a recorded identity stays resolved.

## Ledger, tokens, contracts, gate

`css-defect` / `optical-residual` / `structural` and `dimensionSensitivity` are arithmetic
over the evidence explanations and never alter a verdict; thresholds, terms and axes sit
beside the code ([src/lib](../../src/lib/AGENTS.md)). Review lives in checked-in
`geometry-ledger.json`; `geometry-contracts.json` compiles ONLY `promoted` entries, each
declaring `ink` or `layout-box` — `new`, `debt`, `wont-fix`, `fixed`, `ignored` compile none.

- A baseline is EXECUTED, not printed: the gate reruns the pipeline over the whole capture
  plan with no screenshots, and fails when a finding's |offset| passes |baseline| plus one
  device pixel (1/DPR of its COARSEST capture) or when a finding has no ledger entry
  (`geometry:triage`, like a lockfile). `ignored` opts out; `promoted` belongs to the
  contract check. Offsets are means over the WHOLE plan, so a baseline belongs to the
  platform that recorded it: re-baseline where CI runs, never trim the plan for speed.
- `debt` and `wont-fix` are two decisions, not one word; `triage` records `debt` rather
  than guess. `geometry:verify-fix <dir> <key…>` reruns that gate and only
  then moves a finding back inside one device pixel to `fixed` at its new baseline, the
  strictest entry there is.
- Two contract members never cover one element twice; member resolution, the ink witness
  and named tokens (the ledger records only the `--spacing-*` property): see
  [support](support/AGENTS.md). Relations are a small deterministic algebra there; widen
  the relation before loosening a tolerance.
- Ledger labels give discovery precision, promoted locators coverage, PNG edges only
  confidence.

## Report

Discovery or proposal presence is never a report assertion; coverage:
[support](support/AGENTS.md).

- Each detail persists the capture id owning its Story, viewport and scale; `--after`
  replays that capture and clip and appends only the repair image, never rediscovering
  findings or replacing evidence. Replay: [support](support/AGENTS.md).
- Steady state, not delta: every finding gets a card grouped by ledger status and
  classification, with baseline vs current offset, capture count, dimension sensitivity and
  repair text. Chips filter both, default new + changed + css-defect + promoted minus
  wont-fix and fixed; the meta line totals new/changed/resolved. One JSON payload, one
  renderer, images as files.
- Violation images label each deviating member in place with role, physical direction,
  measured offset, actual anchor and a leader to it. A Y card comes from the FINISHED
  findings, never a second pipeline printing another number: each annotation IS that
  finding's evidence for that member, asserted before the shot. Card clips, zoomed Y cards
  and discovery cards: [support](support/AGENTS.md). Cards are picked by deviation, inside
  the generator's budget.
