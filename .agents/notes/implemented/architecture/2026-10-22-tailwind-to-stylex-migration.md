# Tailwind to StyleX, one surface at a time

Status: implemented
Translation: current

PR: [#1875](https://github.com/LodyAI/Lody/pull/1875) (draft)

[中文](2026-10-22-tailwind-to-stylex-migration.zh.md)

## Abstract

Lody's product surfaces combine Tailwind v4 with a StyleX design system. The
migration keeps both while moving owned component styles onto the app's existing
theme variables and scales, preserving control APIs and rendered behavior. This
continuation migrates owned styles across sidebar rows, chat composition, mobile
connection controls, preview annotations, sessions, terminals, schedules and shared UI adapters. It
repairs earlier class composition and token mistakes and establishes browser evidence for portals, interactions and exact
responsive boundaries. The migration remains incomplete: retained primitive
overrides, third-party selectors and unvisited application states are explicit
follow-up work, rather than inferred completion from a successful build or a
utility count.

## Styling ownership

The [product style layer](../../../../packages/components/src/style/README.md)
owns app colors and scales. A component owns its `stylex.create` block; repeated
area styles live in an adjacent `surface.ts`. `@lody/ui` continues to own control
appearance. Existing primitive overrides remain compatibility items until their
replacement preserves the actual result; replacing a higher-layer Tailwind
`minHeight` with a caller's StyleX class does not guarantee it beats the
primitive's own StyleX `minHeight`.

Product colors read the same root CSS variables as Tailwind. This preserves
VS Code theme integration and portal rendering outside the subtree carrying
`@lody/ui`'s palette. Arbitrary alpha expressions stay expressions rather than
acquiring a token per numeric step; their inventory is maintained in
[ALPHAS.md](../../../../packages/components/src/style/ALPHAS.md).

A wholesale rewrite would mix visual redesign with style ownership changes.
The selected unit is an owned component or small module with a real rendering
fixture. The [migration guide](../../../../packages/components/src/style/MIGRATION.md)
owns the cascade, focus/ring, typography, CSS-hook and verification contracts.

## Continued batches and corrections

The status/project-entry/rename continuation removes 75 more compiler-confirmed
utilities across six components: WorkingGrid 8→0, WorkingGridCollapse 13→0,
WorkingStatusMark 4→0, Spinner 7→2, MobileProjectEditSection 30→0 and
RenameSessionDialog 29→14. Spinner retains the animation hook and SVG size marker
that remaining ancestor selectors consume; rename retains primitive layout,
typography and Textarea overrides. Public props, DOM structure, inline styles,
measurement, animations and input/save handling remain unchanged. Project entry
keeps runtime radius, weight and line-height variables, including nondefault
palette/scale browser controls, rather than substituting equal-default literals.

This batch's 434 primary pairs have equal recorded styles/geometry and zero
threshold pixels; 425 PNGs are byte-identical. Nine project keyboard frames retain
small raw pixel differences. Native project input has 48 byte-identical pairs;
rename has 44 native and eight pointer-retry pairs with zero threshold pixels,
42 and seven respectively byte-identical. Rename shadow variants reproduce on
unchanged sources. Status animation capture remains incomplete as acceptance:
107/120 pairs are byte-identical, while 13 formal frames retain 9,518 threshold
pixels despite equal computed geometry, styles and animation observations.
Seventy-eight alternating-source control screenshots reproduce a shared complete
PNG for every changed state, but some formal variants remain unreproduced. These
13 frames are not accepted as antialiasing or hidden by a wider threshold; they
remain separate from the earlier 20-frame/115-pixel limit. The self-contained
`leaf-acceptance.html` includes actual before/after images, controls and precise
limits. Synthetic composition events establish the DOM IME guard, not native OS
IME behavior; device descriptors establish Chromium touch emulation only.

The actual OSS desktop is built and run on both sides with its real main,
preload, IPC, bundled CLI and isolated local chat. The smoke harness waits for
the TourStill camera and foreground ancestor geometry before capturing, since
Playwright's animation switch cannot settle the JavaScript spring. Three final
application states have zero threshold pixels; Explore retains 16,155 formal
threshold pixels. Two independent launches of the same final build show different
stable foreground PNGs, and the second launch plus three repeated screenshots
reproduces the entire before PNG. Forty-one foreground elements have equal
computed styles and text geometry after excluding a nonvisual elapsed-time
variable. This demonstrates run-to-run raster variation without identifying its
compositor trigger; the formal differing pair remains in the report.

The Emoji Picker / Drawer continuation moves another 116 compiler-confirmed
utilities: Emoji Picker 87→3 and Drawer 67→35. Emoji active theme fills and the
primitive Spinner size remain compatible utilities. Drawer direction variants,
header breakpoints and animation hooks retain their utilities-layer priority
for public caller classes; the migration does not make previously ineffective
width, inset, margin, radius or border overrides start winning. Static layout
and typography use the existing local StyleX tokens.

The Diff Viewer continuation reduces its five-file utility inventory from 135
to 27, moving 108 occurrences across the viewer and three comment/action leaves.
The Markdown descendant rule remains unchanged. Native/Chinese annotation font
families stay literal because the original `font-sans` differs from the app font
variable. The non-emitting touch class acquires no new touch behavior, and header
hover keeps the original unresolved `--accent` expression. Card/primitive
composition, shadow variables and public Add button hover/active precedence stay
compatible utilities; worker, cache, lifecycle and event ownership are unchanged.

The alpha follow-up repairs 16 compiler-proven declaration sites in five files,
restores two mobile hover-media predicates and preserves the original dynamic
amber palette contract. It migrates five additional owned utilities: the private
mobile Viewers-label margin and four file-notice root properties. Remaining
primitive/caller compatibility stays in place. The two mobile sheets are fully
audited for their selected opacity values; the conversation view still has 25
and sidebar rows five unvisited direct-alpha conversions, with exact locations
and required fixture states in `alpha-five-file-audit.json`. These are known
remaining audit items, not claims of whole-file style equivalence.

| Batch                     | Scope                                                                                                                                           | Remaining compatibility                                                                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pages and mentions        | Six auth/workspace pages and five mention/editor leaves; shared page layout in `pages/surface.ts`.                                              | Primitive type/size/error styles, arbitrary creation-options sibling spacing and a menu's caller layout.                                                               |
| Files and visual comments | Desktop/mobile production file browsers, annotation overlay and draft composer. New stories expose the real desktop browser and draft composer. | Primitive overrides; the overlay's remaining native styles are completed by the later batch below. Mobile drill animation hooks remain ordinary owned CSS.             |
| Session leaves            | Usage popover, relation tree and notification permission prompt.                                                                                | Existing primitive/dark overrides; compiler-confirmed usage falls from 165 to 18 occurrences across these three files.                                                 |
| Sidebar rows and shell    | Leading slot, shared row parts, Updated list, sidebar shell and local-project rows.                                                             | Group/menu/dark/focus hooks, primitive overrides, scrollbar/sash integration and archive overlay positioning; static utilities fall from 674 to 116 across five files. |
| Chat and mobile controls  | Composer pasted-text Dialog/Drawer, disabled context tabs, project clear/reveal hooks, connection status and mobile header leaves.              | Primitive size/type/descendant overrides and hard-coded dark hooks remain; five files fall from 234 to 144 compiler-confirmed utilities.                               |

The four-file controls batch reduces compiler-confirmed utilities from 348 to 161:
`session-list.tsx` 31→8, `terminal/terminal-dock.tsx` 107→3,
`schedules/schedule-property-row.tsx` 82→28 and `ai-gui/view.tsx` 128→122.
The view change owns only activity warning color, the logical margins of direct
metadata rows and configuration-list padding; the original compiler's sibling
spacing is preserved rather than replaced with a gap. Public sidebar class-string
helpers, primitive overrides and terminal integration hooks remain. Together with
the preceding five chat/mobile files, these nine files fall from 582 to 305
occurrences, removing 277; 187 of those removals belong to this four-file batch.

The subsequent seven-file batch reduces utilities from 297 to 104, removing 193:
`preview/visual-annotation-comments-overlay.tsx` 69→0,
`sessions/session-chat-interface.tsx` 89→75,
`sessions/session-search-context.tsx` 16→13,
`shared/swipe-action-row.tsx` 41→3,
`sessions/message-queue/queued-image-preview.tsx` 22→4,
`schedules/schedule-recurrence-editor.tsx` 38→2 and `sessions/session-pin.tsx` 22→7.
These are changes to owned styles; retained primitive and public class-string
contracts remain part of the component boundary.

The shared-adapter batch migrates six `src/ui` files from 293 to 43 utilities:
`command.tsx` 100→34, `slider.tsx` 33→0, `copy-button.tsx` 27→0,
`resizable.tsx` 37→0, `collapsible-card.tsx` 62→8 and `scroll-area.tsx` 34→1.
Native range semantics, clipboard callbacks/timers, Radix lifecycle patches,
resizing and collapse events remain with their original owners. Retained rules
cover primitive overrides, third-party descendants, forced-color outlines,
animations, ancestor states and the scroll viewport's important child-display rule.

A candidate CollapsibleCard custom-property declaration was emitted outside the
StyleX layer and erased a caller's arbitrary shadow. Keeping the paired original
`shadow-none ring-0` classes preserves `cn` composition; the remaining owned
styles migrate normally. Static class-only composition also preserves public
inline styles instead of overwriting them with an undefined helper style.
Copy's blur expression retains the compiler-verified 4px fallback: a Storybook
utility can keep `--blur-xs` alive even when no product utility consumes it.
These are compatibility boundaries, not new theme values or visual redesigns.

Browser comparisons corrected a 12px CompleteEmail spacing regression and a
Join textarea reduced from 112px to 72px. The latter retains its original
`min-h-28` compatibility class. Monospace paths retain the global ligature
preference as well as their font family.

Review also found 23 places where an unmerged `className` replaced StyleX props,
or vice versa, in PR merge controls, underwater decorations and blueprint
animation hooks. These now merge through the existing helper. Onboarding's
compact form styles compose in one `stylex.props` call instead of being
replaced by a second spread. The underwater component currently has no product
consumer; its source repair is not evidence of a previously visible app fault.

**Correction to the earlier token implementation:** eight default shadow values
had been copied incorrectly. This changed the draft card and selected billing
option despite preserved geometry. The corrected values come from the locked
Tailwind compiler and a real browser's resolved shadows, not a remembered scale.
All eleven shadow levels were checked in Chromium; 61 of 62 other scale checks
are exact, with `rounded-full` differing only in an already-saturating radius.

The sidebar continuation exposed another same-property conflict: the archive
control owns `position: relative` in its confirming state. Replacing its caller
overlay with an independent StyleX class let it enter flex layout, widening the
end slot from 20px to about 120px and narrowing the title. Short-title PNGs were
identical despite this geometry regression. The caller retains `absolute z-20`
compatibility; long-title confirmation and explicit slot measurements verify the
repair. No control API or archive behavior changed.

The chat continuation uses owned data attributes to qualify StyleX ancestor
markers. An unqualified default marker also observed unrelated outer hover and
focus: real nested-wrapper controls reproduced that candidate regression, while
the qualified final implementation matches the original named Tailwind groups.
Tabs, menus, drawer materials and spinner sizing retain primitive compatibility.
The disabled tooltip's original touch-tap limitation and the textarea's original
clear-height behavior remain explicit; neither was redesigned during migration.

Terminal review caught a real candidate regression: a later conditional StyleX
color slot removed the New button's normal hover color. Keeping the structure
separate and declaring hover and disabled-hover in the same color slot restores
the original result. Schedule native-input hover also retains Tailwind's
`(hover: hover)` media condition; touch controls verify that it does not apply on
devices without hover. These fixes leave business events and lifecycles intact.

The later overlay migration moves each ring and arbitrary shadow together,
including the original focused state where the app's global reset removes the
ring but leaves its shadow. Owned marker predicates preserve hover/focus scope,
and the exact dark selector preserves nested light-scope exclusions. Original
palette variables retain compiler-verified fallbacks because their declarations
may be removed when Tailwind no longer sees a consuming utility. Swipe keyboard
checks preserve the original transparent focus ring; they establish focus and
Enter behavior without claiming a visible focus indicator.

The owned-leaf continuation removes 13 utilities: `usage-calendar-skeleton.tsx`
11→7, `session-info-bar.tsx` 7→0 and `conversation-outline-rail.tsx` 7→5.
Skeleton moves only four caller-layout declarations, including the exact local
`calc(var(--spacing) * 1.5)`; primitive display, corners and the documented ring
material remain. InfoBar preserves the complete app dark/light-scope selector,
local input/border alpha mixes and palette overrides. Its amber/emerald variable
references have exact locked-palette fallbacks: compiler pruning can remove the
last declaration when no utility consumes it. The imported composer elevation
class and unresolved class composition remain dependencies even with zero owned
static utilities.

Outline Rail retains three ancestor-state color groups, its `@[928px]:flex`
boundary and the preview card's `p-3`. A real public caller makes resting ticks
purple, but the original hover/focus selectors override it. Moving those
selectors to the earlier StyleX layer would let that caller win instead. The two
migrated scrollbar utilities preserve that existing contract; no extra specificity,
control API, DOM, event, geometry engine or lifecycle change is introduced.

## Reproducible evidence

The [visual harness](../../../../packages/components/tests/visual/visual-regression.mjs)
captures production Storybook components in Chromium and writes self-contained
HTML with embedded before/after/difference PNGs and raw computed-style changes.
The [runner guide](../../../../packages/components/tests/visual/README.md) owns
commands and target profiles. Captures wait for actual visible content, fonts,
finite animations and stable geometry; delayed prompts cannot pass as empty
screens. Explicitly blank usage states are allowlisted. Portal contents are
included. Resume checks build/target/harness identity; failed and missing cases remain
visible in reports. Independent keyboard peeks move the pointer away first.

Of the 726 pairs, 711 PNG files are byte-identical and 723 have no pixels above
the recorded RGB threshold. All recorded geometry and font properties match.
The remaining three frames differ by four, three and three threshold pixels at
control corners. Repeated original/candidate CreateWorkspace captures do not
reproduce its two differences; the draft corner difference remains unresolved.
Raw color, shadow and saturated-radius representations remain in the report,
including cases with identical PNGs; they are not counted as exact style matches.

The earlier acceptance set covers 89 stories and 726 paired frames, including
390/768/1280px viewports, both themes, and 767/768px file-browser boundaries.
It includes file drilling, text/binary/error previews, annotation hover/keyboard
peeks, draft typing/disabled states, and opened usage portals. A separate real
OSS Electron run exercises onboarding, Agent configuration, Explore and editable
local chat through the actual preload, IPC and bundled CLI. It uses isolated
data directories and a random endpoint, verifies cleanup, and records build
hashes. Those application images are after-only smoke evidence, not paired
application regression evidence.

The sidebar report contains 550 pairs across 40 stories: 548 PNGs are byte-identical,
all 550 have no pixels above the recorded threshold, and 137,184 recorded nodes
have no geometry, font, opacity or tag differences. The two remaining PNG-level
variations belong to the light-locked project-overview story and remain explicit.
The sidebar report adds full-layout, row-part, long-title archive, empty/loading,
show-all/less, selection, nesting and footer-menu comparisons. Narrow desktop-UA
frames exercise compact desktop layout. Separate iPhone/Android Chromium device
descriptors exercise actual mobile detection and touch menu/archive actions. A
known logo must be visible before capture because Base UI preloads its image
before mounting `<img>`. Explicit blocked-host profiles exercise real offline
avatar fallbacks; original network-dependent frames are retained. Real loaded
avatar controls also compare asset hashes and rendered styles. Normal-motion
send rings are compared at SVG SMIL times 0 and 0.6 seconds; fixed Date and
Playwright animation disabling alone do not synchronize SMIL. A story that
explicitly locks light mode is not counted as dark-mode rendering.

The capture harness gives every story a fresh page. Reusing worker pages made
native Back/Forward state depend on worker allocation: an apparent ten-pixel
arrow-color regression was actually a disabled control compared with an enabled
one. Fresh and deliberately matched-history controls are byte-identical across
builds; original screenshot hashes exactly match those two different states.
The corrected captures preserve both the raw evidence and the independent
history state, rather than changing the product's navigation colors.

Two isolated real desktop runs around the sidebar rebuild retain Before/After
application images. Startup animation phases are not normalized, so these images
are supplemental visual evidence rather than an application-wide pixel gate.

The chat/mobile report adds 494 pairs across 44 stories: 487 PNGs are
byte-identical, 492 have no pixels above the recorded threshold, and all 37,506
recorded nodes match geometry, fonts, opacity, tag and path. Two frames retain
one and two threshold pixels at attachment/onboarding edges; their raw images,
independent controls and unresolved limits remain explicit. Computed differences
are limited to background-color expressions, saturated radii and transparent
shadow representations. Separate real composer interactions compare 210 nodes,
including Dialog/Drawer editing, image peeks, keyboard focus and textarea height.
Stable Drawer repeats are byte-identical; its first-paint variation also occurs
between screenshots of the same unchanged build. Real Electron runs bracket the
production rebuild and remain supplemental application evidence.

The harness now includes portal positioners in geometry stability checks.
Search-story completion alone did not establish that its query had been entered
during menu autofocus: a finished original story could still have an empty
query. Explicit input and filtered-result readiness establish matching search
states before capture. Multi-story connection crossfades also produced empty
content timeouts on both builds; independent captures of all 30 connection-state
pairs are byte-identical. Successful recaptures supersede those frames while
source phases retain their failures; no product styling patch hides them.

The session/terminal/schedule/view report adds 646 pairs across 35 stories,
with no missing or unresolved capture failures: 640 PNGs are byte-identical and
642 pairs have no pixels above the recorded threshold. Its 83,616 recorded nodes
retain 17 background-color expression differences and 65 hidden xterm scroll-area
height differences; all other geometry, fonts, opacity, tags and paths match.
Four frames each retain nine threshold pixels at an unchanged fixture Button's
corner. Independent captures of the same unchanged build reproduce those pixels;
the exact paint trigger remains unproven and is not labelled antialiasing. Two
other PNG differences remain below the threshold. Original images and raw styles
remain available.

The hidden xterm geometry was checked against actual scrolling. Both immutable
builds independently produce initial scroll-area heights of 0 or 280px that remain
after 120 animation frames, while the visible viewport's client and scroll heights
are both 280px. In three runs per build, 600 real text-input probes fill the actual
xterm buffer: scroll height becomes 1300px, wheel scrolling reaches bottom 1020px
and displays probe 599, then top 0px and the original header/probe 000. All six
initial PNGs share one hash and all six scrolled-top PNGs share another. This
localizes the difference to xterm initialization without claiming a unique
upstream callback or dismissing the node merely because it is hidden.

Supplemental controls add six SessionList ancestor-marker pairs, four pairs with
real loaded avatars, 20 terminal drag/keyboard pairs, two populated-buffer scroll
pairs and four real Electron pairs. The final Electron smoke at
`2026-10-22T14:02:35.536Z` uses the rebuilt production renderer. As with earlier
application images, startup animation phases are not a global pixel gate.
`continuation-acceptance.html` combines the latest chat and controls batches:
1,140 pairs, 1,127 byte-identical PNGs and 1,134 pairs within the threshold, plus
64 supplemental pairs. Each batch retains its own before/final build and frame
origins; this is not a claim that every after frame comes from one build.

The next seven-file report contains 972 independent pairs across 32 stories;
four duplicate search rest frames are excluded from the 224 captured search
frames. Of the 972 pairs, 966 PNGs are byte-identical and 970 have no pixels above
the threshold. All 64,196 recorded nodes match geometry, fonts, opacity, tags,
paths, radii and shadows. The 1,603 background-color serialization changes from
`color-mix` to equivalent HSL alpha retain identical PNGs. Original browser screenshots
and raw computed differences remain in the evidence.

Two main search frames retain seven and five threshold pixels at an unchanged
UserRound glyph/avatar edge. Of 24 independent search pairs, two retain 28 pixels at an
unchanged Search glyph. Full-precision styles for 135 paired ancestor nodes and
DPR 1 match, and the same unchanged final build/state produces both zero and
28 pixels. This establishes variable paint results without proving the exact
trigger or labelling the difference antialiasing. The raw images are retained.

The main matrix includes 96 trusted CDP touch-input pairs in normal-motion mode,
covering swipe commit thresholds, vertical pans, independent closure, and keyboard
Tab focus/Enter behavior. The overlay's 232 pairs and 14 separate normal-motion
marker/peek controls are byte-identical. Those 14 controls, 24 manual search pairs
and seven real Electron pairs form 45 supplemental pairs. Electron runs at
`2026-10-22T15:13:35.785Z` and `2026-10-22T15:22:50.085Z` bracket the renderer
rebuild and exercise actual daily/weekly/monthly schedule editors, keyboard weekday
toggles, time editing and month-day clicks without saving. The fixed baseline
and final builds remain separately identified; supplemental application images
retain the startup-animation limitation described above.

The shared-adapter report adds 760 primary Chromium pairs: 754 PNGs are
byte-identical and 759 have no pixels above the threshold. All 31,134 paired
nodes match geometry, fonts, opacity, tags and paths. Raw changes retain 286
shadow, 102 background-color and seven inherited-color entries. The one
512-pixel frame compares different native Button hover states: real hover and
outside-touch controls reproduce both complete original PNG hashes in the same
unchanged final build. Six outside-touch and ten hover-proof pairs are exact;
the original event timing remains untraced, and the raw frame stays visible.

Its 149 supplemental pairs include 32 native scroll states, 50 native layout
states, 22 Firefox range states, 22 manual Command states, three caret controls,
16 Copy touch/hover controls and four actual Electron pairs. Layout retains
five below-threshold raw differences and native scroll retains one; full-precision
controls reproduce two layout paint variants without proving their exact trigger.
The scroll variation is 22 one-channel steps (maximum summed RGB difference 1)
on the unchanged fixture Button, outside the thumb.
The remaining manual Command difference is a native caret; matching-state
`caret:hide` controls are byte-identical. No source patch hides those variations.

Native held-thumb screenshots caught a real ScrollArea candidate regression:
its media-scoped hover rule outranked active color. Restricting hover to
`:hover:not(:active)` restores all eight pressed colors and leaves scroll values
unchanged. The corrected scroll set has 32 pairs with no above-threshold pixels
or computed differences. ScrollArea and its Command consumer use the later
6041 build; the other four unchanged surfaces use 6037 and render no ScrollArea.
Each frame retains its build origin rather than pretending all final images
come from one build. Electron delivery smoke uses the rebuilt renderer at
`2026-10-23T06:07:26.571Z`.

Static Storybook also needed the real `@pierre/diffs` registration module kept
with `moduleSideEffects: 'no-treeshake'`: its package metadata names an unpublished
source path. The 18 diff-consumer baseline frames use saved, hash-verified original
component sources with that infrastructure repair; zero-height unregistered
original frames do not establish body coverage. Both accepted builds render the
real three-line shadow-DOM diff. Initial virtual-list readiness likewise requires
the real filter/clear recovery before checking mounted rows and scrolling to item 79.

The Emoji Picker / Drawer report adds 600 primary pairs, all PNG byte-identical,
with 30,012 paired nodes matching geometry, typography, color, opacity and
structure. The raw report retains 108 transparent input-shadow serializations.
Its 68 supplemental acceptance/control pairs include 60 native states, two
Drawer consumer/width controls, two caret hash controls and four real Electron
application pairs; four rejected candidate pairs separately show the repaired
forced-colors outline regression. Conditional longhands fix the atomic outline
shorthand/reset conflict. One native Emoji frame retains a 20-pixel caret
variation: the same final build reproduces both complete original image hashes.
Filtering, active-row and visible-footer readiness exclude deferred rendering
races; earlier captures and their differences remain preserved. Actual Electron
runs at `2026-10-24T12:24:32.547Z` and `2026-10-24T13:30:34.985Z` bracket the
production renderer rebuild; startup animation differences remain supplemental.

The Diff Viewer report adds 412 primary pairs, with 396 byte-identical PNGs and
no above-threshold pixels or recorded computed-style/geometry differences. Its
132 native pairs have 131 byte-identical PNGs and identical recorded behavior,
including real shadow DOM, 1023/1024px container layout, selection, context
expansion, collapse motion, mobile comment gestures and real clipboard deadlines
and rejection. Twelve deep-shadow controls vary CSS variables, interface fonts
and forced colors; all twelve are byte-identical. The remaining 17 primary/native
frames retain 14–24 raw corner pixels with summed RGB deltas at most six. Fresh
controls reproduce both complete image hashes within unchanged builds; full
precision edge probes match 732 deep nodes and 480 ordinary CSS properties.
The exact paint trigger remains unproved, and no product patch hides it.

This batch corrects the earlier assumption that opacity modifiers always become
direct HSL alpha. Locked Tailwind 4.3 emits oklab color mixes: using the exact
`text-foreground/90` declaration removes candidate path-color and glyph-edge
differences. The style guide now owns that exact-compiler rule. That finding led to the scoped alpha follow-up below. The initial five candidate
locations remain recorded in `diff-alpha-followup-inventory.json`; an existing
direct HSL style in the conversation diff panel is not a migration error.

Syntax highlighting and theme application finish after shadow lines first mount.
Both sides now require real colored token spans before accepting the large-diff
and native frames. Unready raw captures remain separate rejected evidence.
The 158 supplemental display pairs contain 156 acceptance/control pairs and two
explicitly rejected candidates/captures, including four actual Electron pairs
from `2026-10-24T16:07:55.008Z` and `2026-10-24T16:51:45.401Z` around the final
renderer rebuild. Startup animation differences retain their existing limitation.

The alpha continuation distinguishes unchanged pre-repair Current, labelled
runtime declaration controls, and a corrected-source reference retaining the
five utilities migrated in Final. Neither control is a whole historical HEAD UI.
The source reference isolates those migrations: 342 ordinary pairs are PNG
byte-identical, with 18,516 recorded nodes matching. The retained Current matrix
has 16 intentionally changed frames when the original mobile hover-media
contract is restored. Five real palette pairs verify light/dark variable
overrides and fallback, separately from normal theme screenshots.

Native acceptance remains bounded: of 184 source-reference pairs, 158 PNGs are
byte-identical and 164 have no above-threshold pixels; all recorded styles,
geometry, fonts and interaction states match. Twenty dark Removal frames retain
115 button-corner threshold pixels (4–10 each). Independent full-precision
CSS/pseudo/viewport and CDP layer probes find no differences or animations.
Thirty-six alternating fresh-load controls show shared complete PNGs across both
builds in three sampled states; one Source reference reproduces the formal
Final hash, and both builds reproduce the same two cleanup variants. These
observations do not reproduce every formal hash, explain the raster trigger or
close all 20 cases. Keep that visual limit explicit, without an antialiasing or
all-pass claim.

Late inline replacement itself changes non-target button paint on the old build:
one Sidebar frame has 432 threshold pixels and 28 mobile frames have 197. These
remain rejected reference evidence; the source reference removes the Sidebar
mismatch while preserving the mobile limit. The report embeds 225 supplemental
pairs, 20 real-screenshot-derived masks and actual Electron runs alongside the
342 ordinary pairs. Source hashes and origins stay in its delivery index.

The large alpha report uses bounded previews with intrinsic dimensions to prevent
lazy-load scroll jumps; unchanged original PNGs remain embedded by SHA for zoom.
Image validity decoding is separate from long-session UI validation. An isolated
Chrome process completes 24 uninterrupted navigation/resize/zoom cycles; a CLI
session-recovery incident is retained without an unsupported OOM attribution.

Generated evidence lives in ignored `packages/components/artifacts/visual/`;
`acceptance.html` retains the earlier continuation report;
`sidebar-acceptance.html` is the sidebar continuation report;
`chat-acceptance.html` covers the chat/mobile continuation;
`controls-acceptance.html` covers the four-file controls batch. The combined
`continuation-acceptance.html` preserves both sets and their provenance.
`next-acceptance.html` covers the subsequent seven-file batch;
`round-acceptance.html` covers the six shared adapters and their explicit controls;
`followup-acceptance.html` covers Emoji Picker / Drawer and their native controls;
`diff-acceptance.html` covers the Diff Viewer continuation;
`alpha-acceptance.html` records the alpha repair and its explicit unresolved
native visual limit. The initial legacy
report was not a completion record: it displayed only 88 spot frames, while
larger captures had 668 failures on each side. Baselines for this continuation
preserve the partially migrated tree. Supplemental original-source fixtures
were used for stories whose legacy static build could not render; those source
copies and per-frame capture origins remain in the local evidence.

### Element-local variable scopes

The property-row / installation-guide / information-chip batch moves 73 more
utility occurrences into local StyleX while preserving the existing DOM, events
and control APIs. Real fixtures now cover the formerly unconsumed `PropertyRowWide`
export, including caller child-width conflicts.

| Surface                                | Utilities before → after | Retained contract                                                                                         |
| -------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------- |
| Schedule property rows and field marks | 37 → 10                  | Two unknown-child width selectors plus eight existing card/ghost compatibility utilities.                 |
| Bub installation guide                 | 29 → 8                   | Button appearance and sizing overrides.                                                                   |
| Information chips and CI popovers      | 33 → 8                   | Primitive maximum width, padding and shadow overrides; width and border color are independently migrated. |

Subtree variable probes exposed a real migration bug: `stylex.defineVars`
references resolve at their definition scope. An inherited alias had already
resolved `--spacing`, radius and ink dependencies at the root, whereas the old
utility read the variable on its element. The schedule mark changed from 24px to
16px; the installation row changed from 13px radius / 10px spacing to 6px / 8px.
Root-only variable checks had missed this. Rejected candidates retain 16 schedule
frames / 711,092 threshold pixels, 16 guide frames / 215,817 pixels, and eight
chip scope frames with changed computed values. New declarations now preserve
exact local `var` / `calc` / HSL expressions. Existing declarations and shared
token definitions stay unchanged; their other scoped consumers remain unaudited.
This is a dependency-resolution correction, not a layout compensation.

The final `properties-acceptance.html` contains 886 paired real screenshots:
698 primary states and 188 native input / variable-scope states. All pairs have
zero threshold pixels and equal recorded styles/geometry; 879 are PNG-byte-exact.
The seven other pairs retain 12 raw pixels, maximum channel delta 3. Sixteen
alternating-source controls reproduce every one of the four primary After PNG
hashes on the unchanged Before source; the exact raster trigger is unproved.
Full snapshots compare 40,174 paired nodes; 72 additional schedule contracts
compare another 2,504 nodes, including actual tooltip list margins and focus.
The report embeds the original, rejected and corrected screenshots and keeps
historical unresolved evidence prominent.

The guide runner initially sampled its scroll endpoint before changed variables
and fonts settled. Both immutable sources were recaptured after observable font,
geometry and right-edge scroll readiness; the final 80 guide native pairs are
byte-exact. Rejected measurements and interrupted chip-run cleanup evidence stay
in local artifacts. Existing mobile long-link clipping and extreme 240px row
crowding remain byte-exact baseline limitations. These controls do not establish
native OS IME, WebKit or every theme outside the recorded matrix.

### Legacy sidebar lists

The legacy `TaskList` and `SidebarUpdatedTaskList` now have actual rendering
fixtures despite having no active product value consumers. Their remaining
utilities fall from 87 to 15 and 95 to 23 respectively. Local styles preserve
element-local variable evaluation, caller precedence, group hooks, drag inline
transforms, DOM, handlers and public APIs. Retained rules cover ancestor state,
anchor focus, shared fade/reveal and primitive composition. Two task swipe-action
color strings remain inside an unresolved expression, outside the counted 15.

`legacy-acceptance.html` contains 490 real pairs: 362 primary and 128 native
screenshots, with 99,960 matched nodes. Another 104 TaskList observations compare
28,288 nodes without being counted again as screenshots. All recorded fields
match, including recursive native CSS, focus, input, pseudo-elements, trusted
events and callback assertions. All 128 native PNG pairs are byte-exact.
Of the full matrix, 487 PNG pairs are byte-exact; three retain 29 raw pixels,
including three threshold pixels, maximum channel delta 10. These formal
exceptions remain **unresolved**: two pixels at a root-variable rename input's
bottom edge and one in the unchanged shared CI check SVG. Narrow row corners
account for the other below-threshold difference. Location is not a proven
rendering cause.

Alternating unchanged-source controls share complete PNGs for all three states:
final source reproduces the narrow-row and CI-icon Before PNGs; original source
reproduces the root-variable After PNG. Twenty TaskList control screenshots and
144 Updated support screenshots retain the full sequences. They do not reproduce
every formal variant or close the exceptions. The report embeds nine original
Before/After/control PNGs and keeps both current and historical differences open.

Coverage includes real touch at 390/767/768px, drag/cancel/reorder, rename,
archive, forced colors, root/subtree variables and caller overrides. Rejected
mixed-device hover and nested-button Enter captures remain: the original row
keyboard handler intercepts nested Enter, and touch devices cannot activate
desktop hover-only controls. Accepted primary captures use valid desktop
pointer paths; native runs cover actual touch. Early browser cleanup hangs are
retained separately; both final sources use the same headless Chromium runner
and exit cleanly. These are harness corrections, not product behavior changes.

### Active session lists and login

The active `SessionList`, `SidebarUpdatedSessionList` and `LoginPage` remove
110 more compiler-confirmed utilities: 97→12, 26→9 and 35→27. Project-group
headers preserve their exact local variable expressions, transitions and drag
inline styles. Updated rows qualify StyleX ancestor markers with their owned
row attribute; caller descendant overrides, precise opener navigation and
shared control composition remain intact. Login migrates its owned provider
wrapper and spinner margin while retaining the important descendant SVG rule
and primitive sizing. Public APIs, structure, handlers and auth behavior stay
unchanged; independent reviews check these boundaries separately from screenshots.

Real captures also exposed missing acceptance preconditions. A stable login
snapshot could still show a clipped, unfinished form; its profile now awaits
the existing stage/panel/expanding-row E2E completion contract. Existing login
stories share local storage, so their full matrix runs serially to avoid
cross-story last-used-provider input changes. Native drag requires the actual
moved pose and pointer hit state. Updated-list rest states require menu and
hover-card closure and a pointer outside rows. Both immutable sources are
recaptured after these corrections. Initial differences, unchanged-source
controls and final captures remain separate evidence; no product CSS patch or
pixel-threshold change substitutes for those observable states.

`active-acceptance.html` contains 880 final screenshot pairs: 648 primary and
232 native. Of these, 878 PNGs are byte-exact; two login pairs retain 518 raw
pixels, zero above the unchanged threshold, maximum channel delta one. Their
rendering cause remains **unresolved**. Full primary and native rendering fields
match across 253,476 screenshot-paired nodes. Another 124 SessionList computed
observations cover 42,624 nodes without adding screenshot pairs. Five native
SessionList diagnostic differences remain explicit: touch hover membership and
last pointer coordinates vary while final hit chains, CSS, geometry and PNGs
match. Updated's final 450 screenshot pairs are byte-exact; its final closed-card
state includes a real pointer re-entry/leave after menu detachment. This does
not prove that one Escape always closed the original hover card. Initial
119,914 raw / 117,675 threshold drag pixels, 59,833 raw / 58,892 threshold clipped
login pixels, and Updated's initial 100,729 raw / 91,090 threshold pixels remain
separate evidence with the old hover-card variants, failed closure candidates
and unchanged-source controls. Historical exceptions stay open.

### Mobile settings and workspace sheets

The next four-file batch removes 68 actual compiler-confirmed utilities:
project settings 57→5, account settings 76→68, create workspace 15→12 and delete
workspace 17→12. New styles preserve element-local spacing, ink, radius, weight,
the compiler's exact `color-mix`, and its complete dark/light-scope predicate.
Redundant primitive shrink classes are removed only where the primitive owns the
same value. Control sizing, Drawer overrides, field typography and pending
margins inside automatically closing confirmation actions remain explicit.
DOM, hooks, events, inline styles and public APIs are unchanged.

`mobile-acceptance.html` has 716 paired browser screenshots: 418 primary,
290 native and eight supplemental runtime theme-scope probes. Recorded rendering
fields match across 62,030 paired nodes; one Account `alertDialogOpen` diagnostic
was sampled before settling and differs despite equal settled DOM. Only 670
PNGs are byte-exact: 46 pairs retain 16,827 raw pixels, including 7,818 above the
unchanged threshold. These remain **OPEN**. Bounded unchanged-source controls
reproduce some complete formal variants, but do not explain every variant or
prove the raster trigger. The largest differences lie on the unchanged workspace
name Input's inset-shadow edge after blur; no compensating CSS is added.

Original failed locator/translation/pending-fixture captures remain separate from
accepted phases. Project fixtures retain their original immutable build; revised
Account/Workspace fixtures get a second original-source build. Both use the same
four original production files. Real touch contact is verified without inventing
a missing Chromium `:active` state. Local creation rejection, automatic deletion
closure and existing 320px long-title/close-button overlap remain visible limits.
Native iOS-branch and keyboard-inset probes are emulations. Current component
tests pass all 618 files / 6,137 tests; actual Electron build and four after-only
smoke screenshots pass. Root check still fails the existing Git-identity test;
types, typed lint, Effect lint, scripts and independent boundaries pass.

### Image preview, Markdown references and sidebar compatibility

The next three files remove 33 confirmed utilities: image preview 16→0,
Markdown renderer 27→18 and sidebar 37→29. Image DOM, object-URL lifetime,
callbacks and shared viewer stay intact. Markdown keeps its 15 table variants:
an actual public descendant selector changes winners when these move layers.
It also retains `leading-[1.55]`, whose `--tw-leading` writer composes with
caller text-size/leading utilities. Local reference radius and both transition
variable fallback branches have explicit browser probes; the unresolved base
class string remains outside the file's static count.

Real sidebar captures reject an initial StyleX candidate: primitive avatars
replace 16/20/25px dimensions with 24px, gaps become 8px instead of 6/7.5px and
Help minimum width becomes 200px instead of 160px. The rejected primary/native/
touch captures retain 203,530 / 63,888 / 10,471 threshold pixels. Restore nine
exact compatibility utilities and delete the failed StyleX declarations instead
of increasing specificity. All three final components are recaptured on one
corrected immutable build. Six computed-only sidebar observations retain six
private non-inherited `--tw-font-weight` writers disappearing; current source
and compiled CSS have no reader, and rendered weight/leading remain equal.

`leaves2-acceptance.html` has 348 distinct observed pairs: 206 primary, 125
common native and 17 supplemental witnesses. The common formal coverage is 331;
three image gesture witnesses, ten Markdown variable/caller probes and four
actual sidebar taps are separate. Recorded rendering fields match across 35,772
paired nodes. Of these PNGs, 343 are byte-exact; five retain 7,550 raw pixels,
including 5,631 above the unchanged threshold in two frames. These remain OPEN.
Markdown's 114 pairs are byte-exact. Sidebar's four raw variants retain one
threshold pixel; unchanged-source controls reproduce three whole-image variants
without proving the trigger or closing the formal differences.

Image native acceptance is explicitly incomplete: full Before has 44 entries;
full After has 41 plus one failed dark pinch. A bounded final-source replay
supplies three distinct valid states, while the original-source replay also
fails. This does not turn the full run into a success. Reduced-motion and
controlled-clock gesture attempts remain unresolved; final gesture witnesses
use normal motion, with reduced-motion primary coverage separate. The desktop
zoom pair retains 7,505 raw / 5,630 threshold pixels despite matching recorded
CSS/geometry/media bytes; screenshot-time JavaScript rebasing remains a hypothesis.
Original failures, motion modes and source/harness provenance remain inspectable.
Forty-four additional caret-policy diagnostic PNGs from the preceding workspace
build show small same-source edge changes, including repeated hide-policy shots;
they neither explain the earlier large variants nor close any historical pair.

### Build and test findings

Storybook 10.6's strict execution wrappers and shared async chunks introduced
initialization cycles around real WASM imports. A single-story probe did not
establish full-build correctness. Storybook now targets native ESM/TLA and
preserves module boundaries; the complete build was exercised through multiple
actual entry points before capturing. Desktop production configuration retains
its own target and WASM contracts.

The pre-integration component suite passes all 598 files / 5,917 tests with
`NODE_OPTIONS=--no-experimental-webstorage NODE_ENV=test`. Node 26's native
Storage otherwise interferes with jsdom's Storage fixtures; the initial ten
failures disappear under that environment without changing product behavior.
Utility-class assertions were replaced by observable behavior and SVG structure;
one test containing only class assertions was removed. Component typecheck,
type-aware lint, desktop builds and documentation checks also pass. Root typed
lint has zero errors and 17,396 warnings, with public-boundary, i18n and formatting
checks passing. Existing repository lint/documentation warnings remain warnings.

Integration with `main` at `cebc2e6171` resolves 17 conflicting paths while
preserving upstream multi-repository groups, ordering and launch capability gates,
PR status hues, queue touch alignment, terminal geometry and the updated diff
renderer API. The deleted Radix scroll adapter stays deleted; fixtures and native
scroll checks now consume Base UI's axis/visibility API. Unsupported old thumb
appearance and viewport-as-child fixture cases are removed rather than revived.

After integration, all 614 component test files / 6,083 tests pass. Root typecheck,
typed lint, Effect lint and root script tests complete. Root `pnpm check` then
stops in CLI testing: one SQLite-runtime suite cannot load under installed Node
26.11.1 (below upstream's new supported patch floor), and one Git identity test
fails. The CLI result is 330 files / 4,631 tests passed, two failed files and one
failed test; later aggregate stages do not complete. Fixture commits run with
command-local signing disabled, without changing Git configuration. Root format,
public-boundary and i18n checks pass. These results do not establish supported
Node-runtime or Electron integration acceptance.

The merged immutable Storybook build provides 240 real browser captures: 160
component states, 48 page states and 32 native wheel/drag/keyboard states, plus a
production-component geometry probe for the landing toggle's 5px/92px offsets.
This is post-integration smoke evidence, not whole-main pixel equivalence. Earlier
migration reports remain evidence for their original immutable source versions;
their 20 unresolved native frames / 115 threshold pixels remain unresolved.
The landing board/tab overlap also appears in an isolated, unchanged current-main
product build: 320 matched nodes have equal geometry, with 323 raw screenshot
pixels differing by at most two channel levels and zero threshold pixels. The
phone Command dialog's clipped left edge is byte-identical to the pre-merge
build. Both remain visible limits, not silent layout patches or new acceptance
claims. `main-merge-acceptance.html` embeds the integration captures and controls.

The subsequent integration of `a3de5d611` preserves upstream notice-copy layout
and E2EE scoped instructions, with no changes to the six leaf implementations.
A fresh Storybook 10.6.2 build and 434 integration captures have equal recorded
styles/geometry and zero threshold pixels (421 byte-identical). This separate
matrix does not replace the earlier native differences. The current component
run passes 617 files / 6,124 tests; one Electron-auth recovery suite cannot load
because the newly required Electron 44.9.3 binary is unavailable locally.
Installer fetches fail, and GitHub release download reports “release not found”.
The application builds, but this runtime smoke is blocked; the earlier real
Electron runs retain their original runtime/version scope. Root checking stops
with the same unsupported-Node SQLite suite and Git identity assertion (332 CLI
files / 4,697 tests pass). The integration proof is `leaf-main-integration-review.json`.

A final sync through `40e108f1a` keeps the upstream reset-time absolute/relative
toggle alongside the popover's migrated styles. The incoming toggle and its
styles remain structurally identical to main; both owning suites pass 21 tests.
The six leaf implementations remain unchanged. This integration does not broaden
the frozen leaf report's source/runtime scope. The final root aggregate records
331 CLI files / 4,697 tests passed, the same SQLite/Git failures, and an additional
file-index worker timeout; the worker's owning suite passes all seven tests in a
separate rerun. The aggregate remains failed. A separate post-merge browser smoke covers 48
frames across three actual popover stories, desktop/phone, light/dark, open and
absolute/relative toggle states. All interaction and date-bound checks pass;
`usage-toggle-postmerge-final/report.html` embeds the actual screenshots. This
smoke has no pre-merge pixel baseline and does not establish visual equivalence.

For the five-component batch, all 618 component files / 6,136 tests pass under
`NODE_OPTIONS=--no-experimental-webstorage NODE_ENV=test`; the seven owning suites
pass 112 behavior tests. Final root type/lint/Effect/script stages complete, but
the aggregate still stops on the unsupported Node SQLite guard and Git identity
assertion (332 CLI files / 4,698 tests pass). The current Electron application
build passes; its actual smoke attempt fails before launch because
`electron@44.9.3/path.txt` is missing. This adds no new Electron runtime acceptance.

The legacy-list continuation also passes all 618 component files / 6,136 tests
before main integration. Syncing through `ff17c0e68` resolves the sole new
`pr-merge-button.tsx` conflict by keeping StyleX and adopting upstream's compact
height of 20px (`themeSpace[5]`). Upstream queue/auth behavior is preserved. The
two legacy implementations remain byte-identical to their accepted source
snapshots. The integrated component suite passes 618 files / 6,137 tests; root
types, typed lint, Effect lint and scripts complete, while the same Node/Git
failures leave the aggregate failed (332 CLI files / 4,701 tests pass).
Independent post-merge browser matrices retain their own source scope and do
not replace the formal 490-pair exceptions. The integrated 362-pair primary
matrix has equal full recorded fields across 69,752 nodes; 359 PNGs are byte-exact,
while three pairs retain 27 raw pixels / two threshold pixels, maximum channel
delta six. These exceptions also remain open. A separate 16-frame real browser
smoke verifies the intentional 20px merge/diff height, method menu, squash
selection and Escape at 390/1280px in both themes. The integrated Electron app
build passes; missing Electron binaries still block actual runtime validation.

The active-list/login batch uses the officially downloaded Node 26.12.1 archive,
verified against its SHA-256 manifest, without changing the machine's global
runtime. All 618 component files / 6,137 tests pass; root types, typed lint,
Effect lint and script tests complete. SQLite runtime support now passes. The
aggregate still fails the existing Git-identity assertion (333 CLI files /
4,725 tests pass), so it is not a full repository check pass. Internationalization,
public-boundary and the remaining static boundary checks pass independently.
The actual final Electron 44.9.3 build and isolated smoke now pass onboarding,
agent configuration, Explore and local chat, with four real screenshots. This
is after-only application evidence; it does not resolve historical Explore
pixel differences or replace paired component acceptance.

### Onboarding, session surfaces and latest-main reconciliation

The owned batch removes 23 confirmed utilities: Overlay 13→1, desktop layout
16→9 and MarkdownTable 5→1. Preserve exact cream/slate/spacing values,
drag-strip precedence, resize alpha/transition semantics and the table's named
outer-group selector. DOM, callbacks, hooks and public APIs remain unchanged.
WorkspaceCard retains six utilities because real opaque StyleX callers otherwise
change winners. Backdrop retains four for its corresponding public boundary.
Search's 13 and conversation panels' 23 remain: exported class strings depend on
`cn` resolving conflicts in both argument orders, plus ring/shadow composition.
Adding styles under all retained utilities is not a migration.

Reconcile `main` through `05a60e018`, preserving its direct local-project deletion,
guided project rules and scheduled-message queue behavior. Retire the deleted
removal-confirmation components and their dedicated fixtures/runners; never
revive that UI for an old screenshot profile. Historical images stay unchanged.
Non-styling source comparison and owning tests preserve the upstream handlers,
public props, editing/IME semantics, menus and navigation decisions.

Real scoped-theme images expose an existing migration bug: inherited StyleX
aliases keep root ink while the component's CSS variables request different
colors. Queue and mobile settings now read exact element-local expressions,
including the compiler's alpha mixes, without changing shared tokens. Their
24/8 scope pairs are byte-exact after repair; rejected purple/green-versus-root
blue/red images remain. Restore the complete transition property list and
variable fallbacks, the queue's hover media condition, and Clock3's original
`flex-shrink: 0`. The Clock fix removes 24 rendering-field differences even
though the rejected 108 PNGs had matched.

Latest-main acceptance uses a source reference: the integrated graph and identical
fixtures, with four incoming-main files restored as the sidebar, mobile settings
and queue/pending dependency units. This is not a whole historical-main build.
The initial three-file reference cannot build because main's queue lacks the
migration-only export used by the migrated pending row; preserve that failure
and include main's original pending row rather than invent a bridge. Original
reference build 6101, corrected mobile/queue build 6103 and corrected sidebar
build 6104 remain immutable. Source hashes establish unchanged consumers across
those final builds. The real mobile fixture uses actual hooks/atoms and synthetic
command ports; existing sidebar no-op callbacks and scheduler preview slots do
not establish daemon mutations, a full router or scheduler end-to-end behavior.

`main2-locked-acceptance.html` combines 638 observed pairs: 234 primary,
370 native and 34 supplemental caller/theme-scope controls. Only 627 PNGs are
byte-exact. Eleven pairs retain 60,911 raw pixels, including 38,282 above the
unchanged threshold in five frames; they remain **OPEN**. The latest-main subset
is 330 pairs / 325 byte-exact / 155 raw / one threshold pixel across 72,132 nodes.
It retains 1,104 private sidebar writer differences and 72 shadow/pending-alpha
string differences. Actual geometry/events match; sRGB8-bit color probes support
selected expression equivalence without replacing raw fields or proving every
floating-point transition. The complete combined evidence covers 110,206 nodes.

The earlier owned subset remains 308 pairs / 302 byte-exact. Four desktop
onboarding Back/Skip states retain camera/paint differences: two have 1,512
changed node records / 2,275 scalar fields as a roughly 0.01px transform propagates;
two have equal recorded fields but different PNGs. Two bounded source controls
supply a matching third Skip variant and an original-source matching camera
matrix, without reproducing either formal whole image. The camera uses live rAF,
DOM-anchor measurement and rounded output; its raster cause remains unproved.
Both generic full-story runs still produce 12/32 frames plus four initial-opacity
readiness failures. Independent native 46/46 success does not close them. Overlay
actually resolves light for both requested themes, as its route requires.

The combined report embeds unchanged original PNGs and labelled derived masks.
A full assembly exceeded V8's JSON string limit; derived report views retain every
exact field the public comparator reads, verified against original layouts.
Complete native snapshots and separate full-field proofs remain intact. Failed
captures, rejected candidates and after-only Electron images are not formal pairs.
Current component tests pass 620 files / 6,207 tests; types, owning tests, formatting
and independent boundaries pass. Root check still fails the existing CLI
Git-identity test (4,868 pass / one fail). The latest CLI and actual Electron are
rebuilt and the four-view isolated smoke passes as after-only evidence; historical
application differences remain open. No P0/P1 is found in the integration review.
The final desktop environment verifies resolved SDK peers against the lock,
including Zod 4.3.6. The superseded combined report retains an earlier peer-version
mismatch; component screenshot evidence is unchanged, and locked CLI/desktop
validation is repeated for the final report.

### Owned layout and theme leaves

The `leaves3-acceptance.html` evidence is assembled from 316 paired real-browser
executions: 172 primary and 144 additional native executions, comprising 48
InfoBar and 96 Outline Rail frames. These counts identify separate capture
origins; UI states can overlap. All 316 whole PNGs are byte-identical, all 42,970
paired report nodes have equal recorded fields, and the unchanged threshold has
zero differing pixels. Independent assembly checks preserve every native row's
exact 13 comparator fields and source PNG bytes/SHA; complete original native
snapshots and full-field proofs remain available. All recorded fields in the 144
raw native executions also match. Fourteen overlapping Skeleton CSS observations
compare another 5,592 nodes and 8,753,714 CSS properties without adding screenshot
pairs or report nodes. Exact root/subtree spacing, local palette inputs, nested
theme scopes and real 671/672/673px containers are covered. Independent direct-file
HTML review verifies all 401 unique PNG payloads, 632 formal image origins and
eight supplemental source images. Search/filter, original-image pointer and
keyboard actions, close cleanup and 1280/390px layouts pass with zero page errors
or external requests. The rejected metrics label and stale HTTP-page run remain
separate evidence; only the final file is signed as reviewed.

The artifact server also handles directories without an `index.html`: missing
assets return 404 instead of opening a nonexistent fallback and crashing. Real
HTTP checks verify that the report remains byte-identical and readable after
missing-asset requests, while Storybook's existing index fallback still works.

Two additional after-only palette-pruning controls render the actual production
controls with all three palette variables removed. After finite animations and
four stable full-CSS frames, light/dark PNGs are byte-identical to their ordinary
same-source counterparts. Raw computed inks change from Oklch to the compiler's
Lab fallback polyfill; those fields are retained rather than called exact string
matches. Three-color Chromium samples in sRGB and Display-P3, each using unorm8
and float16, have zero measured channel delta. This does not prove float32,
arbitrary future backgrounds or intermediate transitions. Initial computed-string
equality failures remain diagnostic evidence. These two runtime controls are
outside the 316 formal migration pairs and their zero-field-difference claim.

Skeleton's accepted CSS observations retain 5,948 identical known console
warnings on each side. The shared primitive's width-only dynamic size call
compiles an undefined height atom, which StyleQ reports; this pre-existing bug
is not repaired by the four layout migrations. The initial strict-console run
and its nonzero exit remain diagnostic evidence. The accepted observer classifies
only that exact warning and records zero unexpected errors, external requests or
capture failures. The primitive's actual reduced-motion CSS disables breathing,
with zero animations observed; normal-motion breathing is not compared. Original
narrow footer clipping remains unchanged. No paint is hidden to make the captures
match, and none of the historical OPEN pairs, including the 638-pair latest-main
report, is closed or reclassified by this batch.

Current component checks pass 620 files / 6,207 tests. Types, typed lint, Effect
lint, scripts, formatting and independent boundary checks pass. The initial root
`pnpm check` fails 15 CLI tests: 14 encounter the host's commit-signing environment,
and one is the existing Git-identity assertion. A CLI rerun with command-local
`commit.gpgsign=false` passes 4,868 tests but retains that identity failure; Git
configuration and product behavior stay unchanged. Neither run is a root-check
pass. The rebuilt actual Electron smoke at `2026-10-27T12:22:33.898Z` passes four
views with real after-only screenshots. It supplies application smoke evidence,
not paired regression coverage or closure of historical application differences.

## Remaining work

Compiler-backed [usage inventory](../../../../packages/components/scripts/tailwind-usage.mjs)
replaces the old regex, which skipped single utilities and many values. It scans
JSX, class helpers, constants and static template fragments, validates candidates
against the locked compiler, and reports unresolved dynamic expressions. Counts
are source-occurrence lower bounds, not runtime coverage or emitted CSS size.

Across the preceding nine-file continuation, the component inventory falls from
2,377 to 2,100 compiler-confirmed occurrences, leaving a lower bound of 3,093
with 605 unresolved expressions in the component scan. The subsequent seven-file batch reduces
components from 2,100 to 1,907. The shared-adapter batch reduces `src/ui` from
992 to 742. The Emoji Picker / Drawer batch reduces `src/ui` further to 626. The Diff Viewer batch reduces `src/ui` further to 518. The pre-integration audited
lower bound is 2,421 occurrences after the alpha follow-up: components 1,902, `src/ui` 518 and routes 1,
across 188 affected files. The scanner separately
reports 690 unresolved expressions: 600 in components and 90 in `src/ui`.
After integrating upstream additions, the scan reported 2,572 occurrences across
188 files. The status/project-entry/rename batch left 2,497 occurrences across 184 files.
Following the later upstream integration, the scan reports 2,501
(components 2,009, `src/ui` 487, routes 5) across 185 files, with 692 unresolved
expressions (611 components, 81 `src/ui`). The property/guide/chip batch leaves
2,428 occurrences (components 1,936, `src/ui` 487, routes 5) across 184 files;
the 692 unresolved expressions are unchanged. The legacy-list batch leaves
2,284 occurrences (components 1,792, `src/ui` 487, routes 5) across 184 files,
with the same 692 unresolved expressions. The active-list/login batch leaves
2,174 occurrences (components 1,682, `src/ui` 487, routes 5) across the same
184 files and 692 unresolved expressions. Those snapshots predate recognition of
`withClassName`'s class argument.

The corrected scanner reads that helper's second argument while excluding its
StyleX props argument, validates candidates with the same locked compiler, and
retains unresolved dynamic arguments. A real compiler probe checks deduplication,
invalid tokens and dynamic values. Rescanning the four original files and final
files yields 165→97, removing 68; it does not count moving retained size classes
inside a helper as migration. On the same method, the baseline is 2,208 and the
current lower bound is 2,140 occurrences (components 1,648, `src/ui` 487, routes 5)
across 187 files, plus 765 unresolved expressions. Newly visible historical
helper usages explain the higher corrected baseline; these are lower bounds,
not a project completion percentage. The image/Markdown/sidebar continuation
then removes 33 on that same scanner, leaving 2,107 occurrences (components
1,615, `src/ui` 487, routes 5) across 186 files and 765 unresolved expressions.
Pure literal string concatenations are now joined before compiler validation,
without evaluating runtime or numeric operands. An independent real-compiler
probe verifies split token boundaries, source deduplication and unresolved values.
This recognizes 32 existing Markdown base-class occurrences and resolves one
previous expression: the corrected baseline is 2,139 across 186 files with 764
unresolved expressions. The onboarding/layout/table batch removes 23 on this same
method, leaving **2,116 occurrences** (components 1,624, `src/ui` 487, routes 5)
across 186 files and 764 unresolved expressions. The increase from the earlier
2,107 snapshot is a scanner correction, not added Tailwind styling. Neither count
is a completion percentage.

After reconciling main, the same-method snapshot was 2,102 occurrences
(components 1,610, `src/ui` 487, routes 5) across 186 files with 760 unresolved
expressions. That change includes upstream additions and retired UI rather than
another claimed migration removal. The owned Skeleton/InfoBar/Outline Rail batch
then removes 13 on the same method, leaving **2,089 occurrences** (components
1,597, `src/ui` 487, routes 5) across 185 files and 759 unresolved expressions.
These are measured lower bounds, not a completion percentage.

WebWorkspaceLayout remains deferred until its actual sidebar/runtime/router
graph has a bounded production-component fixture.

The unconsumed `src/ui/sidebar.tsx` retains 324 occurrences and is not re-exported
by `src/ui/index.ts`; direct public wildcard imports remain possible.
The unconsumed `src/components/task-list.tsx` retains 15 occurrences,
`src/components/sidebar-updated-task-list.tsx` retains 23; both now have real
rendering and native-input fixtures. The unused
`PropertyRowWide` export now has actual rendering fixtures and retains only its
two arbitrary-child selectors. Establish actual consumers and rendering fixtures
before migrating other unconsumed surfaces. The original phone terminal error span has zero width and invisible inline
feedback, while desktop/tablet/short-view feedback remains visible; the original
240px schedule fixture with an extreme label and nonshrinking Button overlaps.
Both limitations are preserved and documented, rather than redesigned during a
style migration.

The search fixture verifies expanded process disclosure, ordinary text and
Markdown marks. It lacks the builtin/DeepSeek SessionMeta needed to mount the
thought body and ThoughtCard; those are not visually covered. The five retained
container ring/shadow utilities in `sessions/session-search-context.tsx` remain
unchanged and unverified. Add the missing metadata before migrating and visually
accepting those retained rules.

The original bottom-corner open annotation card can extend past its
`overflow: hidden` canvas and clip its footer. Touch Resolve is verified on a
fully visible native card; the screenshot automation does not silently scroll a
clipped card into view and present that as the natural touch path. Recurrence's
two original dark variants, the `ghostValueClass` contract and PinButton primitive
compatibility remain. Trusted Chromium touch input does not establish native iOS
or WebKit behavior, and custom VS Code themes have not all been exercised.

Continue with the retained chat/mobile primitive overrides, remaining Emoji
Picker / Drawer compatibility, the diff adapters and other legacy `src/ui` wrappers, and
third-party descendant selectors. Sidebar compatibility still needs owned ancestor
markers and control-level composition.
Keep primitive compatibility separate from owned DOM work. Hard-coded dark
variants require an owned marker/theme contract; StyleX relational selectors
exist, so this is remaining implementation scope rather than an absolute
library limitation. The report records the final measured inventory and exact
unverified states, including file/hash metadata popovers and native gestures.
No screenshot set here establishes full remote/backend or every-theme coverage.
