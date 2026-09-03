# `components/src/lib` — file-surface invariants

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only. Package
[AGENTS.md](../../AGENTS.md) applies; this file adds the client half of Code Collab / File
Preview file surfaces and the chat workspace geometry grid.

## The Electron IPC type-only edge is intentional

`electron-ipc-client.ts` imports `ElectronIpcServices` from the Electron main-process
registration module with `import type`. It is a source-type edge, not the package cycle it
resembles: TypeScript erases it, browser/mobile bundles never load main-process code, and
there is no `@lody/electron` runtime dependency. The type checker still follows that source, so this
project keeps `experimentalDecorators` and a catalog-pinned `@types/node` dev dependency,
which make the main service declarations parse under the Electron node project's
assumptions without changing emitted renderer code. Those declarations are compiler
plumbing, not permission for shared UI to use Node APIs: the lint boundary rejects `node:*`
imports and Node globals here.

Keep the service classes plus the one constructor list as the invoke signature source. The
alternative — a handwritten mirror of every invoke method, another contract, a spec, a
platform port — drifted from `@IpcMethod()` registration and the preload policy. Never make
the edge a runtime import: if a build cannot erase it, fix that type boundary or move the
Electron-aware caller. Push events and one-way sends stay platform-neutral maps in
`@lody/shared/electron-ipc`.

## Where a path came from decides whether it may be rewritten

`session-file-open-target.ts` owns this and is the only place that should.

- **Canonical** — the caller already holds the workspace-relative path the machine
  indexed: file tree, quick open, mobile file browser, an LSP jump target. Sent VERBATIM.
- **Markdown href** — a link an agent wrote in chat. Parsed: URL-decoded, trailing
  `:<line>` / `#L<line>` split off, absolute host root and `.../worktrees/<uuid>/` stripped.

Running a canonical path through the href parser is what this split prevents: each of those
sequences is a real part of some real filename — `docs/report%20v2.md` decodes to another
file, `logs/2024:30.txt` loses its tail. A line anchor travels as a FIELD, never in the path.

Known gap: `ai-gui/view.tsx`'s tool-call card sends an ACP `locations[].path` — a
filesystem path, not an href — through `onFilePathClick`, so it rides the href parser. It
needs a third kind that strips roots without decoding.

## ACP dispatch

Before creating a top-level or child session, call `filterAcpSessionConfigOptionValues()`
so cached values outside the current selector schema are not dispatched or persisted.

## A resolved open is cached under BOTH spellings

The machine may answer with a different on-disk spelling than the one requested (letter
case, Unicode normalization), so `openFile` caches the result under `response.path` AND the
path it asked for. Each key has a caller that breaks without it.

- `response.path` becomes `entry.fileId`, so it is what `saveText` is called with. Missing
  it, save reports "Open the file before saving it." for a file on screen.
- The requested path is what the viewer tab keeps: `session-detail.tsx` refreshes a tab's
  `fileId` from the file INDEX, which never learns the resolved name. Missing it, the
  external-change pre-check no-ops and every re-open re-downloads the file, no
  `knownDigest` being sendable.

A save must then refresh EVERY key of the entry (`cacheKeys`): it arrives under one
spelling and the next change-check under the other, so refreshing only the save path leaves
the alias holding the pre-save digest and the pre-check reports our own save as external.
Related: preview READS case-tolerantly while `save-text` WRITES case-exactly.

## Known gap: scan-failure skip reasons

`codeCollabFileTreeValueToSessionFileEntry` maps every `kind: 'skipped'` index entry to
`unavailableReason: 'unsupported-special'`, so a file the scanner failed to read once
(EBUSY/EMFILE, deleted mid-scan) reads as "File type is not supported" and stays unclickable
until the next full rescan. A naive allowlist is not enough: the same reasons are emitted
for DIRECTORIES whose read failed, and `openFile` does not clear an index `readonly`, so
the obvious patch trades "unopenable" for "uneditable".

## Error copy

`session-file-error-state.tsx` maps a machine message + reason to a presentation. Two rules
run BEFORE the reason mapping, because the coarse machine code misdescribes them:

- "outside the workspace" — a policy rejection arrives as `permission_denied`; "Access
  denied" would blame the filesystem. The CLI must keep that exact phrase in the message.
- "owner session mismatch" — a startup race (the client derives the owner from synced
  session meta, the machine from the live session) that also arrives as
  `permission_denied`. The only correct advice is "try again".

## Chat workspace geometry

`chat-workspace-geometry.ts` owns the design grid, the overlays and the alignment/baseline
diagnostics; `geometry-constraint-system.ts` explanations and classification;
`geometry-text-cap-band.ts` the one optical text measurement. Pipeline, identity, contracts,
gate, report: [tests/e2e](../../tests/e2e/AGENTS.md).

The grid is a reviewed reference, not evidence the product was inferred automatically.
Production layout stays ordinary Flex/Grid with stable geometry data markers only; grid
columns are never props or wrapper DOM. Fixture and gate share one spec. `?geometry=1` adds
the overlay, alignment lines and spacing diagnostics; dev only.

- Explicit control boxes: repeated slots share an X line across rows.
- A Y rail's row is GEOMETRIC: `assignGeometricRows` puts an extent on the line whose MEDIAN
  band it overlaps by half OF BOTH. To that band, never neighbour to neighbour, or half-overlaps
  chain two lines of different heights into one, as chaining intermediate X coordinates would
  merge indentation levels. Of BOTH, or an extent far taller covers the band whole while
  sitting off its line — a 44px heading joined a 17px row that way. The DOM row is a PRIOR
  setting the EVIDENCE BAR, never eligibility; as a gate it hid every cross-structural line by
  construction. An atom no row accepted is measured on Y under its own row id.
- Cross-font rows compare ink centres — a cap-height band from a fixed reference glyph,
  transformed SVG path bounds, a painted CSS shape's box; baselines compare text only
  ([tests/e2e/support](../../tests/e2e/support/AGENTS.md)). The overlay and the capture take
  that band, and the canvas font string it needs, from `geometry-text-cap-band.ts`: two
  copies disagree about one row. The overlay never throws at a font; capture may.
- Named groups expose stable member labels; guides sit at the median of the whole spread,
  never DOM order. Spread over tolerance but ≤ 1px is `sub-pixel-jitter`: folded, never
  gated. Under the required member count: `insufficient-evidence`, never aligned.
- Padding/margin/gap/line-height multiples are spacing diagnostics, never alignment
  violations; that debt is non-blocking until promoted into the gate.

### Classification

An explanation traces both members to a common ancestor, keeping exact
padding/border/margin/gap terms, a `layout` remainder and a residual; block terms mirror
the inline ones, `align-items` centring landing in `layout`, and a text `visual-center`
also records half of (line box − cap band) as `typography` — font metrics, never declared,
never a defect. `css-defect`: |explained| ≥ 1px, |residual| ≤ one device pixel, declared
terms outweighing `layout`, naming the term and node to repair; a centre or baseline owns
none and proposes none. `optical-residual`: |explained| < 1px, |residual| ≤ 1.5px, folded,
not `requiresReview`. `structural`: the rest, unexplainable offsets included. A finding seen
under one value of an axis that varies inside its own story/viewport/DPR group records
`dimensionSensitivity` (the expanded-sidebar story is recaptured under
`theme:dark`/`locale:zh_CN`); merged across both values, none.
