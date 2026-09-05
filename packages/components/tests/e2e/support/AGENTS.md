# Geometry browser measurement

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
[`tests/e2e/AGENTS.md`](../AGENTS.md), the package and the repository root also apply.

`chat-workspace-geometry.ts` is the only place the geometry system touches a live page.
Capture and the Playwright gate share every function here — a finding must never be named,
measured or resolved by a rule the other stage cannot reproduce. Functions serialized into
the page (`installGeometryBrowserHelpers`) stay closure-free, including the pure
`src/lib/geometry-text-cap-band.ts` helpers the `?geometry=1` overlay imports directly, so
the overlay and capture cannot disagree about one row.

## What a primitive is measured from

- Ink is text `Range` bounds, transformed SVG path bounds, a painted image, or a painted
  CSS SHAPE's border box: a rendered leaf with no text, a non-transparent background or
  border and at most 24px in both dimensions — a status dot is ink a reader aligns
  against, and no glyph, path or image describes it. A layout box is
  `getBoundingClientRect`; a padded control, a container or a form control is a layout-box
  observation, never an ink one. A `<textarea>` is a FIELD before it is text: its default
  value is a child text node that never renders, and measuring it as text would make its
  48px box the ink of a label.
- Visual primitives exclude CSS-clipped content (`clip` or `clip-path`), including
  `sr-only`: it stays in the accessibility tree and its text range can still report
  the full label bounds even though no pixels are painted. `aria-hidden` alone does
  not exclude a visible decorative primitive from visual discovery.
- Flow text gives start/end edges, never a centre; centred text only its centre; numeric
  text, diff statistics included, is trailing-edge.
- Vertical anchors come from that same rect, so an SVG's box centre already IS its
  transformed path-bounds centre and an image's, a shape's or a field's is its box centre.
  Text is the exception: its visual centre is the cap-height band of a FIXED reference
  glyph, not of its own string, because a label that happens to carry a descender would
  otherwise demand a different icon offset than an identical row without one. The
  difference between that centre and the line box centre is returned as its own
  `typography` term. The canvas font string omits the computed `font-variant`: a variant
  like `tabular-nums` is not a canvas value, and a refused font string silently measures
  one element with another element's font.
- A row is a LINE, not a stack. A slot is a row member only when its vertical extent
  overlaps the row band — the median slot height centred on the row — by at least half, so
  a composer `label` above its field is not a row and the leading between them is not an
  offset. A rejected slot may still be an atom outside every row.
- `measureGeometryBlockAnchorsInBrowser` and the marker-based
  `auditChatWorkspaceSemanticAlignments` / `…Baselines` use one cap-band measurement, and
  all number `[document.body, ...document.body.querySelectorAll('*')]` the same way, so a
  marker member and a discovered Y candidate are comparable as ONE `dom-N` element. No
  pass may leave the document mutated.
- Accessible names come from one deliberately small accname subset
  (`computeAccessibleNameInBrowser`), sized to what `getByRole(…, { name })` resolves for
  the widgets captured, so a captured name is one Playwright resolves. A content-named role
  owns the locator of the primitives inside it. Names are LABELS, never identity: a repeated
  row prints `role “row title”` (its longest direct text), another named primitive its own
  text minus its nested controls' names (`Files Close Files` → `Files`), an unnamed
  primitive its row family plus same-role index — never a raw family string.

## Proving the markers can go

- `marker-removal-readiness.json` asks EVERY marker rule still declared in
  `CHAT_WORKSPACE_SEMANTIC_ALIGNMENTS` — the alignment rules and the baseline groups —
  whether it can go, per member and per capture. A marker is business-code weight, so a
  rule is `ready` only when discovery observed each member, at the same anchor and offset
  within quantization, on every capture the rule appears in: one capture where a member is
  invisible is one regression the removal would hide.
- `compareMarkerAlignmentsToBlockRails` (`geometry-constraint-system.ts`) is the one-off
  companion for the rule actually being retired: re-ask its marker and Y discovery about
  one capture, matched by ELEMENT — `coordinateDelta` is whether they measure an element
  alike, `offsetDelta` whether they place the row line alike; a member only one side saw is
  listed, never averaged away. `sidebar.row.visual-center` was proven this way (18/18
  members, zero deltas) and its declaration, gate coverage and product
  `data-geometry-align-*` markers are gone. Wire this function into the report again for
  the NEXT candidate; it is not part of the standing run.

## The capture plan

`GEOMETRY_CAPTURE_PLAN` (`geometry-capture-plan.ts`) is the ONE list of captures: the
report shoots it, the gate only measures it, and both open a story through
`showGeometryCaptureStory`, so one cannot settle a page the other could not. The
representative capture alone carries the marker-rule observations, and dropping any capture
to make the gate cheaper moves every merged offset the ledger recorded.

- Opening a capture — the plan walk, `--after` repair images, zoomed Y cards — opens ONE
  context per scale and theme, never one per capture: a viewport can be set on an open
  context, a device scale cannot, and a fresh context's cold cache re-parses the whole
  Storybook bundle — minutes of wall clock. A fresh PAGE per capture inside it, though: a
  page that loaded a dozen stories runs out of memory.
- Every box-model node also records its `class` and the nearest function component above it
  in the fiber tree (`geometry-react-fiber.ts`: walk `fiber.return`, unwrap `memo` and
  `forwardRef`). Both are EVIDENCE — they turn a rendered DOM description into a file an
  agent can open — and neither may reach a key, for the reason an accessible name may not.
  React 19 has no `_debugSource`, so the NAME is the whole pointer; a node React never
  rendered has none and nothing fails. `repairGroup` (component, term, edge, owning node)
  is a label too: it folds report cards and merges no finding.
- A card clip holds the row plus a margin, draws the row median and verdict anchor only,
  and names it. Zoomed Y cards are the largest-|offset| findings anywhere. Discovery cards
  use product-region names, count unique elements not anchor votes, fold one element's
  start/center/end offsets into one annotation, and keep candidate rails under outliers.

## Contract resolution and witnesses

- The gate resolves a member with capture's rules — native role, that accname, row-structure
  family, `selfFamily` for an unnamed layout wrapper, same-role index — and measures what
  capture measures. A member without `all` matching several elements is a contract defect:
  report it and measure nothing, never the first match.
- A contract compares layout boxes; the edge CSS decides. Ink is a non-gating witness:
  each member's optical inset, plus for members containing an SVG the ink-centre offset
  from the group's median ink centre, raising a design question only above 1px.
- Relations are a small deterministic algebra the gate evaluates: `coincident`,
  `box-model-equals-token`, `box-model-multiple-of-token`, and `box-model-sum-equals-token`
  for a rail reached by several declared terms (a row's padding plus its transparent
  border). Report exact numbers when a member misses.
- A named token's computed value is read off `document.documentElement` by capture and by
  the gate; a missing or non-px value fails loudly, and the declaration stays in a
  non-`inline` `@theme` block so Tailwind publishes it at runtime.
- Capture mode disables hover interaction and transitions, preserves explicit
  hover-action/rest swaps, and reveals transparent containers owning interactive controls,
  so every measured control stays visible in both images with no geometry-only marker in
  business code. Coverage is the workspace Sidebar, the production-composed session right
  sidebar and the session states that materially change visible geometry — never an
  isomorphic layout for a transient interaction.
