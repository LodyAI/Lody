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

The connection/queue continuation removes another 14 occurrences:
`acp-session-select.tsx` 43→36, `stuck-connection-banner.tsx` 14→10 and
`message-queue-display.tsx` 12→9. ACP moves seven owned icon/chevron utilities,
using the exact element-local spacing expression. The stuck banner moves one
Spinner ink expression and removes three redundant shrink classes already owned
by Button/Spinner; negative Button margin and primitive appearance stay intact.
Queue moves only three internal scroll-region utilities, preserving the local
border-style variable and exact 30% border mix. Its nine public root utilities
remain: the original utilities layer beats opaque StyleX callers, while `cn`
resolves utility callers differently. Moving those root declarations would
change the exported composition contract. DOM, events, hooks, inline geometry
and recovery/queue ownership remain unchanged.

The shared Skeleton warning repair is a separate primitive correction. Compose
independent dynamic width and height blocks only when that axis is provided
(`!= null`), preserving explicit zero and the unsupplied shape dimension. A
candidate that substituted null passed the unit test but cleared the line
shape's default height, changing a real width-only line from 20px to 0px. That
candidate and its failing browser evidence remain preserved. The final split
keeps both provided axes in one StyleX composition and removes stale inline
sizes when props change; no shape/default/caller API is redesigned.

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

### Connection selectors, recovery hints and queue scrolling

Verified native ACP coverage contains 44 PNG-byte-exact pairs and 7,108 paired
nodes; all 10,450,646 recorded leaf values match. The queue's corrected native
matrix has 54 exact pairs, and six additional runtime-root probes bring its
native/control coverage to 60 exact pairs across 13,380 nodes, with no recorded
field differences. Stuck banner's 36 primary PNG pairs and 920 recorded nodes
are exact. Its 12 additional CSS observations cover 256 nodes and 400,768 CSS
properties with zero field differences and do not add screenshot pairs.

Root-theme intent is distinguished from observed input. ThemeProvider overwrote
the original queue and stuck-banner story root variables at commit; those story
frames do not prove custom-root coverage. Explicit runtime controls apply the
variables after actual theme completion and assert their values before capture.
Queue's six root controls verify all six inputs; the stuck probe verifies root
and subtree ink. ACP's root 650-weight/21px inputs are actually observed. A
five-error fixture type correction retains identical emitted JavaScript
(`7008b53e…9528194`); original failed type checking remains evidence rather than
a change to the compiled baseline's behavior.

The initial queue native matrix retains three scrolled-image differences:
21,670 raw and 19,234 threshold pixels despite matching recorded fields. Final
capture waits for real `scrollend` after every swipe, verifies the bottom row's
position and hit chain, and requires exact pre/post screenshot CSS, geometry and
input observations. Both sources are recaptured through all 54 states. Two
unchanged-Before states also change between the old and stronger-readiness
captures, supporting a readiness explanation without identifying a particular
browser scheduling bug. The three original exceptions remain **OPEN**: their
precise paint trigger was not independently proved. No source patch, mask,
subset replacement or threshold change hides them. Initial ACP nested-Escape /
JSON-size failures and the stuck profile's strict locator failure (zero captures,
20 reported failures) remain separate; the corrected ACP path observes the first
Escape close only the tooltip and the second close the menu.

Shared Skeleton acceptance compares 40 sizing states / 360 nodes, including raw
inline styles and 480 computed CSS properties, with zero rendering-field
differences; 176 original warnings become zero. One animation diagnostic remains:
light/320px/reduced-motion state 1 records no Before animation but a finished,
single-iteration native CSS transition at currentTime 0.01ms After. This raw
observation stays in `leaves4-sizing-comparison.json`; the record as a whole is
not called identical. Four normal-motion pulse screenshot pairs pause the real
animation at 400ms and are PNG-byte-exact. The unchanged UsageCalendarSkeleton
is also checked across 14 overlapping states:
5,592 nodes and 8,759,306 CSS property observations match, while its original
5,948 warnings become zero. These computed-only states do not add screenshots.
The initial null candidate is not included in final acceptance. Historical OPEN
reports and unchanged clipping limitations remain intact.

Component tests pass 620 files / 6,207 cases, and UI tests pass 25 files / 299
cases. The stateful Skeleton sizing case replaces two shallow class/markup
checks, reducing that suite by one case while adding observable rerender coverage.
Root types, typed lint, Effect lint and scripts pass; typed lint records 20,506
warnings and zero errors. CLI records 4,868 passes and the existing Git-identity
failure, so the aggregate is not a root-check pass. Independent final boundaries
pass. `leaves4-acceptance.html` contains 330 formal pairs (226 primary and 104
native) across 59,406 paired nodes, all PNG-byte-exact; supplemental pulse and
initial/rejected evidence stay outside those counters. Direct-file browser QA
verifies all 457 unique PNG payloads, 660 formal origins and 20 supplemental
source references, distinguishing original images from derived masks. Search,
filtering, original-image pointer/keyboard access, close cleanup and 1280/390px
layouts pass with zero page errors or external requests. Actual
Electron smoke at `2026-10-27T13:31:23.380Z` passes four views with after-only
images; it supplies no paired application pixel claim.

The skills-sheet continuation moves six Spinner size classes and one label clamp
into local StyleX, and removes one redundant shrink class; eight utilities leave
`mobile-project-skills-sheet.tsx`. AdaptiveTabStrip retains all 13 utilities:
its public opaque StyleX callers must keep the original utilities-layer winners.
The 72 primary pairs are PNG-byte-exact across 6,612 nodes, with no report-field
changes or capture failures. Detail capture adds 18 executions, including six
repeated resting states; assembly therefore has 84 distinct keys, not 90 unique
states. Four detail frames retain 25 raw pixels, zero threshold pixels and equal
layout; these differences remain OPEN in `leaves5-acceptance.html`. Eight separate
runtime-variable/normal-motion pairs are byte-exact across 514 nodes and 804,683
recorded CSS values. Types, 49 owning
tests and formatting pass; scoped lint has six existing warnings and zero errors.
This UI-only batch does not rerun root checks or close the earlier CLI Git-identity
failure, historical OPEN evidence or the overall PARTIAL verdict.

The filter/queue/mention continuation removes 29 utilities: FilterPillBar 6→0,
MessageQueueRow 8→2 and MentionHighlighter 22→5. Filter retains the exact element-local
scope predicate, `--color-white`, static alpha fallbacks and color-mix support branches;
only hover-capable devices get the 14% dark hover fill. Queue uses an owned-row marker;
mention mirrors preserve inline geometry and control APIs. Capture review found that
string arrows were truthy values rather than executed readiness checks. The runner now
invokes synchronous predicates; historical PNGs do not prove those function gates ran.
A same-Before trace shows stable accordion geometry at opacity 0 before 1, so current
captures wait for opacity and completed unmounting. Historical OPEN evidence stays intact.
The repaired runner verifies 178 distinct formal pairs (182 executions, four duplicate
rest states) byte-for-byte across 12,428 nodes. Six capture counterexamples and 63
owning tests pass; 16 separate native pairs match across 1,276 nodes and 2,013,732
computed values. `leaves6-acceptance.html` embeds the originals and diagnostic limits.

The home/project/recurrence continuation removes 22 utilities: Home 24→13, Project
16→7 and RecurrenceEditor 2→0, preserving local scopes, alpha fallbacks and input
feedback. `leaves7-acceptance.html` retains 192 formal pairs: 180 PNGs are byte-exact;
12 Home frames retain 50 threshold pixels and remain OPEN despite equal recorded
layout/font fields. All 24 separate native pairs are PNG-byte-exact; types and 47
owning tests pass, with story type repairs retaining identical emitted JavaScript.

The editor/terminal/warning/merge batch removes nine utilities: Editor 5→2, Terminal
2→0, view 127→125 and Merge 19→17; local variables and theme/focus predicates stay intact.
All 178 formal PNG pairs are byte-exact; recorded fields across 4,090 nodes match. Of
20 native pairs, 18 are byte-exact; two frames with an unfocused editor retain 90 raw / 15
threshold pixels despite equal recorded fields and remain OPEN. Unchanged Before
controls reproduce both the original light and dark After whole PNGs. A bounded
16-image diagnostic has eight byte-exact stage-matched pairs and equal full CSS /
geometry across the 11-node card subtree, including Send; separate same-page
6/7-pixel changes also occur without active animations. This does not identify the
original 36/54-pixel drawing trigger or close either OPEN record. Types and 70
owning tests pass. `leaves8-acceptance.html` retains originals, controls and historical limits.

The composer/fallback/sidebar continuation removes 21 utilities: Composer 83→81,
LandingView 4→2 and the exported legacy Sidebar 324→307. Warning ink reads the exact
element-local amber variables and dark/light-scope predicate; Sidebar preserves
its local background/foreground inputs, breakpoint and private transition writers.
Public caller/primitive overrides and group/peer states remain compatibility items.
Real selector failure enters the production composer boundary; editing and explicit
retry preserve the draft. Sidebar fixtures exercise its public adapter, not an active
application consumer. Of 140 formal pairs across 4,332 nodes, 139 PNGs are byte-exact;
one narrow palette frame retains two raw pixels, zero above the unchanged threshold,
at the unmodified composer-card bottom-left border/shadow. Recorded fields match, but
the drawing trigger remains OPEN. Four bounded controls reproduce the original
Before whole PNG on both sources, with equal full CSS/pseudo/geometry across 56
nodes; they do not reproduce the formal After variant. Playwright caret hiding
leaves the same empty textarea style attributes on both sources without a computed
change. Full native Sidebar observations also match; four separate normal-motion
pairs pause the real 200ms linear gap/left transitions at 100/200ms and are
PNG-byte-exact, with equal pre/post animation times. The four owning suites pass
24 tests; component types, scoped lint and formatting pass. Root checks
are not rerun. `leaves9-acceptance.html` keeps the original differing frame and
historical OPEN evidence separate from the formal counts.

The composer-surface/share-layout batch moves eight compiler-counted Composer
utilities and 22 previously unresolved `LAYOUT` literal utilities. Composer keeps
the exact dark 60%/70% border and 90% oklab fill, their full-HSL fallbacks and
supports condition. The opaque mention cover separately keeps its sRGB input /
background mix and input fallback on the actual painted wrapper. Complete drag
colour states preserve the original dark resting fill/edge while adding the ring.
Share layout retains fixed radii, title sizes and element-local spacing; its five
ring/shadow compatibility classes remain. Shared tokens, exported composer surface
strings, DOM and events are unchanged.

`leaves10-acceptance.html` has 124 formal pairs across 7,796 nodes, with equal
recorded fields and no missing/failed captures; 122 PNGs are byte-exact. Two original
Composer frames remain OPEN: 123 raw pixels on unchanged fixture buttons and 531 raw
pixels, including two threshold pixels on the migrated card corner and 529 raw
fixture-button pixels. The separate native 12 pairs have 11 byte-exact PNGs and
742 matching nodes, including 712,320 ordinary and 1,424,640 pseudo CSS values across
pre/post observations. Its repeated 531-pixel exception is the same original state,
not another distinct failure. One unchanged Before control reproduces its complete
After PNG, but does not prove the exact drawing trigger. Actual 150ms session colour
transitions paused at 75/150ms are byte-exact. Fixture controls dispatch browser
Files events to production handlers; these are not OS drag or upload-service tests.
Types and 20 owning tests pass; scoped lint and formatting pass. Root checks are
not rerun.

Pixel equality also exposed a pre-existing acceptance gap: the share card's seven
product-colour aliases resolve at the app root, so its background/title/metadata can
follow the app instead of the selected card palette. The 32 byte-exact layout pairs
preserve that regression; they do not certify palette isolation. The separate repair below uses complete local themes and a pre-migration source
reference.
Composer's local light mention cover can likewise differ from the inherited frame
alias in Before; this batch preserves that state. The no-chip dialog still uses
MentionInput and does not establish the plain-textarea branch. Historical OPEN
records and original screenshots remain unchanged.

The share-card repair binds complete `scopedThemeColors` and `scopedThemeSpace`
groups beside the existing product/conversation palette on the card scope. Each
group shares its unchanged canonical defaults with `defineVars`; the local themes
re-evaluate those aliases against the card's actual colour and spacing variables.
The caption also restores the original four-sided border-colour fallback and
supports-qualified 70% oklab mix. This repairs palette, logo-size and spacing leakage
without substituting seven per-element colours or changing the global defaults.

Of the 72 formal `leaves11-12-acceptance.html` pairs, 32 compare the final card
with its real pre-migration Tailwind source at `b84e18308^`: all PNGs are byte-exact
across 1,672 recorded nodes. Native reference checks also match 384 role nodes, 11,136 CSS fields
and 2,304 variable values; 252 semantic checks pass and the document root stays
unchanged. Comparing the buggy immediate Before instead yields 26 intentionally
changed frames and six identical frames. These are repair witnesses, not failed
migration-equivalence pairs. Eight separate unchanged-consumer controls match all
348 recorded nodes, but only seven PNGs are byte-exact; the remaining scoped-palette
frame has two raw pixels, zero threshold pixels and an unproved raster cause, so it
stays OPEN. Earlier rejected palette/spacing/border candidates
and historical differences remain separate evidence.

The Spinner continuation adds a primitive-owned `diameter` prop rather than
competing caller StyleX width classes. Numbers are pixels; CSS lengths can read
local spacing. Explicit zero applies, omission restores the named size, and SVG
width/height attributes still address the glyph. Two real consumers, the saving
message editor and busy merge control, remove four size utilities. The combined
report's 40 Spinner formal pairs are PNG-byte-exact across 1,116 recorded nodes.
Another 12 native pairs are byte-exact across 176 nodes, with 168,960 ordinary and
337,920 pseudo CSS values matching before/after screenshots. They pause the actual
900ms rotation at 400ms at DPR 1/2, verify 3/6px spacing scopes and preserve the same
SVG, wrapper and animation object through 16→0→named 24→14 updates. The 34 new inline
variable/empty-style records remain explicit, not labelled raw-DOM equality. Browser
identity checks use the actual SVG; forwarded-ref callbacks remain behavior-test
coverage. UI owning tests pass 38 cases, caller tests pass 31, and both package typechecks
pass. Root checks are not rerun; these matrices do not close historical OPEN records.
The combined HTML keeps unchanged full PNG payloads by SHA behind labelled bounded
previews. Separate payload decoding and two uninterrupted installed-Chrome UI
cycles pass. A CLI controller reset/stall and a pre-settle UI paint variation
remain diagnostic evidence; their exact causes are unproved, with no OOM claim.

The next Spinner caller batch removes 48 counted width/height utilities across
17 production files in authentication, mobile controls and miscellaneous loading
surfaces. Each caller uses the primitive-owned `diameter` expression against its
actual local spacing; margins, shrink, colour and interaction classes retain their
existing ownership. The 132 formal pairs are PNG-byte-exact across 6,848 recorded
nodes: authentication 40/2,692, mobile 48/2,964 and miscellaneous 44/1,192. The
42 owning tests, component types and scoped lint pass (227 warnings, zero errors).
The long reconnect story's eight clipped marks remain recorded as a fixture limit;
they are not visible-state coverage. A separate ActualControlsReconnect fixture
mounts the production third branch visibly. No account or authentication service
is exercised by the synthetic pending callbacks.

The password/account continuation removes another 20 Spinner size utilities in
three production files. Password pending states match all 16 formal PNG pairs
and 576 recorded nodes; account states match all 44 pairs and 4,660 nodes. Eight
separate account closing pairs retain actual paused WAAPI animation state and
pending marks; two deletion pairs mount the actual production branch through a
synthetic Capacitor iOS identity. All ten supplemental pairs are PNG-byte-exact,
but identity emulation is not physical iOS, WebKit or native-shell acceptance.
The two account owning tests and component types pass.

The Monaco wrapper moves two owned size utilities to local StyleX. Its eight
accepted pairs match PNG bytes and all 2,342 recorded nodes only after the gate
observes the actual positive-size main scrollbar: real editor hover makes it
visible, outside-anchor hover hides it, and the hidden class/opacity/no-running-
transition state stays stable for four fresh polls. The original 280 changed
pixels are exactly the scrollbar slider's measured colour composition, with zero
residual in the physical-pixel overlay proof. Original and settled differences
remain visible diagnostics; the rejected SHOW gate's zero captures and four
failures per side remain retained. That gate incorrectly included zero-size
hover-widget bars. No product CSS changed to satisfy readiness. The editor fixture
uses a light editor under both app themes, so it does not cover dark editor syntax.

`leaves13-14-acceptance.html` combines 200 PNG-byte-exact formal pairs and 14,426
recorded nodes across 20 unique production files, removing 70 counted utilities.
Its 40 supplemental pairs comprise 27 original historical OPEN pairs, ten account
motion/platform-identity pairs, two earlier Monaco changed pairs and one rejected-
gate error pair. These diagnostics remain separate from formal results. Historical
OPEN images retain their source hashes and dimensions; matching new batches do
not close them. The offline HTML uses bounded labelled previews while preserving
unaltered full-resolution originals for inspection.

The Popover continuation adds finite `padding`/`gap` choices (`default` or
`none`) on the actual Popup after its panel StyleX rules. Positioner ref, style,
events and positioning contracts stay on that outer node. Five production caller
files migrate eight zero-padding/gap utilities across seven popup nodes, retaining
widths, shadow, overflow and nonzero padding. `leaves15-acceptance.html` matches all
68 formal PNG pairs and 4,416 recorded nodes: primitive 40/1,272 and actual consumers
28/3,144. Defaults, zero choices, same-node reset, contained/forced themes and real
content controls have browser coverage. Four separate After-only Gallery frames
verify actual layout readouts; its 36 SSR styleq warnings are present in both
source baselines and remain unfixed. UI/gallery tests pass 28 cases, caller tests
pass 60, package types pass and typed lint reports 299 warnings/zero errors;
all nine changed files pass formatting checks.

The consumer theme limit is explicit: five stories honour both requested themes;
sender profile always renders light and desktop turn configuration always dark.
Initial sender-profile readiness failed four captures because the story's play
state left it closed; the accepted profile presses Escape and clicks the actual
avatar. That rejected evidence remains separate. Fourteen actual palette/padding/
gap observations match across sides. The independent diagnostic did not finish
cleanup after its final observation and was interrupted; that cause is unproved,
with no browser-cleanup or OOM claim. The complete formal captures succeeded.
The report preserves 27 original historical OPEN pairs and their exact images.

The next Spinner/Popover batch removes 24 counted utilities: 18 Spinner dimensions
and six Popup dimensions across ten distinct production caller files, plus the
shared Popover API. `width`, `minWidth`, `maxWidth` and `maxHeight` apply to the
actual Popup through guarded StyleX dynamic values: zero applies and omission
restores defaults; positioner style/ref/events retain their ownership. Ten
redundant static StyleX spreads introduced by the earlier `b84e183084` migration
are removed while retaining their identical explicit composed class names; the
owning build no longer emits those duplicate-attribute warnings.

`leaves16-17-acceptance.html` contains 144 formal pairs and 9,348 matching recorded
nodes: History 48/2,776, Session Spinner 36/2,584, Popup API 32/844 and consumers
28/3,144. Of these, 143 PNGs are byte-exact. One forced-dark consumer frame retains
five raw pixels, zero threshold pixels, at the unmodified top tab edge. A bounded
probe matches all 157,920 ordinary and 315,840 pseudo CSS fields across 329 actual
descendants; the union of 1,016,441 variable fields differs only by the intended
Popup width variable. One unchanged-source Before control reproduces After exactly.
These observations narrow the difference without proving its precise raster
trigger, so the original stays OPEN. The 27 earlier original OPEN pairs remain
separate, alongside rejected readiness frames and After-only Gallery evidence.

Rejected gates remain explicit: resolve confirmation closes the parent history
Drawer before its pending callback completes, requiring the real reopen control;
unknown-sharing contains two actual Spinners; `.25rem` is not `.25px`; and a block's
authored auto min-width resolves to 0px. Corrected readiness preserves these product
behaviours. Header and side-panel narrow stories retain their fixed minimum widths,
so they do not establish complete product responsiveness; the identity card uses a
synthetic callback rather than a backend integration. UI types and 28 UI/Gallery
tests pass; main owning tests pass 49 cases and final typed lint reports 276 warnings,
zero errors. Separate Session owning validation passes 121 cases and History six;
these scopes are not added as a unique-test total. The retained Gallery SSR warning
count is unchanged, and root checks are not rerun.

The project/About/Menu continuation removes 21 counted utilities in six caller
files: 12 Spinner dimensions and nine menu bounds. Menu adds actual-Popup
`minWidth`/`maxWidth`/`maxHeight` with pixel numbers, CSS strings, explicit zero and
omission reset, preserving the named regular/compact width and positioner
ref/style/events. Six actual menu nodes are covered; the Header Opened sessions
submenu's three bounds remain until it has a production-component fixture.

`leaves18-19-acceptance.html` retains 164 formal pairs/11,688 matching recorded
nodes: Project 56/3,032, About 32/3,024, Menu API 44/1,432 and consumers 32/4,200.
Of these, 162 PNGs are byte-exact. Two forced-dark Owner narrow captures share the
same four raw pixels, zero threshold pixels, on the highlighted parent Change
owner row. A 281-descendant probe matches 134,880 ordinary and 269,760 pseudo CSS
fields; 869,974 variable fields differ only by five expected bounds variables.
One unchanged-source Before control reproduces After exactly, but the raster
trigger remains unproved and both original frames stay OPEN. The prior 28 original
OPEN captures, including the earlier five-pixel tab frame, remain separate.

Fork focus feedback originally covered other submenu rows with a tooltip; the
accepted profile focuses the real last row for full visibility and retains the
original tooltip frame. An initial wrong story ID selected only 20 frames; the
complete accepted selection has 32. About's original 0/24 unsupported native-theme
subscription failures remain: only the synthetic bridge was corrected before
rebuilding its Before. About updater IPC and project CloudApi are synthetic,
with no real updater installation, backend, worktree RPC or GitHub authorization
claim; the original narrow Community-row crowding remains. Two Gallery and four
actual OSS Electron smoke pages are separate After-only evidence. The current UI
build passes with existing CLI artifacts; isolated smoke cleanup completes.
UI 53 and main owning 34 tests, package types and seven-file lint (164 warnings,
zero errors) pass. Separate About 23/Project 16 test scopes are not added as a
unique total. Root checks are not rerun.

The Integrations/Ceremony batch removes 11 counted utilities in two production
files: six Spinner dimensions through `diameter`, and the Ceremony root's five
fixed/inset/z-index/overflow/slate-ink declarations through local StyleX. The
explicit `VITE_LODY_PLATFORM=cloud` Storybook build supplies synthetic public
Auth/org/CloudApi data; OSS composition and real auth/network behavior are unchanged.
The actual onboarding route owns light theme, so a dark host is stress coverage,
retaining the original low contrast.

`leaves20-acceptance.html` records 96 formal pairs/4,344 matching nodes: Integrations
56/3,392 and Ceremony 40/952. Only 94 PNG pairs are byte-exact. Two narrow-dark
Ceremony captures share the same differing image pair, each with 379 raw and 42
threshold pixels; their exact paint trigger remains OPEN. A bounded 17-node probe
matches 77,232 CSS/variable/double-pseudo records per snapshot, geometry, hit stacks,
ink and animation state, with stable pre/post observations. The image bytes match,
and the sole unchanged-source control reproduces original Before, not After.
These observations do not establish visual equality. Thirty earlier original OPEN
pairs remain separate; no CSS patch or antialiasing assumption closes them.

The Ceremony fixture pauses the film with reduced motion and excludes audio;
actual Skip/Configure controls and the 480ms completion callback are observed, not
the full normal-motion timeline. Integrations' original 40 captures/16 failed
resolved gates remain: English Manage was mistaken for Connect, corrected only in
the profile. Integrations' 11 cache tests/types and Ceremony's two theme-lifecycle
tests/types/zero-warning scoped lint pass. All formal captures retain the original
harness hash and source copy; a later optional click-button argument does not
retroactively change their provenance. Root checks are not rerun.

The ContextMenu continuation adds actual-Popup `minWidth`/`maxWidth`/`maxHeight`
with guarded pixel/CSS values, zero and omission reset, retaining positioner
ref/style/events. Six private row menus remove six minimum-width utilities.
All 56 real right-click pairs are PNG-byte-exact across 10,212 recorded nodes:
32 primitive/1,040 nodes and 24 consumer/9,172 nodes. Two Gallery images separately
verify light and Vesper bounds after opening by actual mouse right-click; they
are After-only. UI 54 and owning 34 tests, package types and eight-file typed lint
(170 warnings, zero errors) pass. The capture harness changes only optional
`click.button`, defaulting to left; its derivative hash identifies these captures
without rewriting the earlier preserved harness. Historical OPEN remains.

The Button continuation adds owned `width`/`height` after named size and variant,
with numeric pixels, element-local CSS expressions, zero and omission reset.
It removes 38 utilities: 30 across ten mobile/leaf/auth files, plus eight across
three private files. The latter represent five JSX sites but four actual Button
nodes: one Header trigger, Reply card/dialog and Plan Copy. Search four,
Finished Copy two, unmounted Login four and opaque public callers stay unchanged.

`leaves21-22-acceptance.html` combines 228 PNG-byte-exact formal pairs and 18,056
matching recorded nodes: ContextMenu 56, Button API 40, mobile/leaf/auth 100 and
private callers 32. Four real held-mouse active pairs separately match full CSS,
double pseudos, focus, geometry and animations under reduced motion; 16 new
private dimension-variable records and eight root class/style differences are
intentional. This is not normal-motion timeline coverage. Thirty-two historical
original OPEN pairs remain separate and unresolved.

The private Before is an audited 32-frame subset of original successful images,
not a recapture. The initial 52-frame plan's eight failed gates and deferred six
utilities remain: Search needed a searchbox gate, while Footer's original story
never made the hovered control visible. Earlier syntax/portal/ancestor gate
failures and local navigation failures are retained; profile corrections and
unchanged-source fresh-browser retries establish the accepted matrices without
claiming an OS/browser cause. Gallery is After-only; the readout-touching first
Button candidate remains rejected, separate from its Sample-column correction.
Full component regression passes 620 files/6,207 tests and UI 25 files/302 tests;
package types and scoped owning checks pass. Root checks are not rerun.

The next two caller batches remove 32 more counted utilities through the existing
Menu/ContextMenu and Button APIs, without adding a primitive API. Six remaining
context-menu bounds and the now-visible Opened/Search/finished-footer controls
account for 15; message actions and Mermaid/MobileAdd/UsageClose/Loro recovery
account for 17. Mermaid's four controls move together: reset keeps automatic
width above its existing minimum, while all heights read element-local spacing.
Loro square defaults belong to a module-private helper; its four-caller verification
and migration are recorded below. Opaque public compatibility boundaries remain.

`leaves23-24-acceptance.html` records **176/176 byte-exact PNG pairs** and
**19,996 paired node records: 19,993 identical, three different**. Only 173 frames
have fully identical raw records. The three original differences are an empty,
`visibility: hidden` xterm helper's height, 0↔300; all other fields match. Forty-eight
bounded observations reproduce both heights in both builds with unchanged visible
viewport/scroll range; four additional genuine image pairs match. Original raw
records remain unchanged. Thirty-two historical original OPEN pairs remain open.

Eight separate Chromium-touch/clipboard-feedback pairs match, with 292 nodes and
1,371,394 CSS records, while 40 private dimension-variable and 24 root attribute
changes remain explicit. The receiver is synthetic, not the OS clipboard; the
controlled 1199/1200ms boundary is reduced-motion evidence. Mermaid uses a real SVG
clone as production Viewer input, not parser/native-gesture acceptance. Existing
narrow Usage clipping and sidebar-story crowding are preserved. Rejected selector,
loading and navigation candidates remain separate from accepted phases; the
unfrozen initial batch23 profile has reconstructed semantics, not claimed original
bytes. The batch24 accepted capture bytes and formatted profile are hash-traced
and semantically equal. Package types and scoped 53/39/68-test checks pass;
scopes overlap and the 68 comprises three green suites plus a Mermaid rerun after
removing two obsolete Tailwind class assertions. Root checks are not rerun.

The primitive-invariant/private-Fork batch removes another 18 occurrences in ten
product files. Sixteen duplicate declarations already owned by the primitive;
two are defaults in a module-private Fork helper with exactly two internal
callers. The latter uses the existing Button dimension API while retaining caller
overrides, rather than adding a generic style escape.

`leaves25-acceptance.html` independently records **72 byte-exact PNG pairs and
4,222 identical paired node records**: invariants 40/2,658 and private Fork
32/1,564. The separate **44-root/68,837-value computed proof supplies no extra
PNG pairs**. Computed values, geometry, raw style, disabled/text and matched
primitive declarations agree; raw classes retain only the expected 16 removals.
Four owning suites/62 tests pass. This does not claim full CSS coverage of the
private Fork helper or a fresh Electron/Gallery capture.

The helper's original 23 successes/nine failures remain: eight used the wrong
legacy Spinner selector and one timed out before Storybook readiness. Both early
computed attempts also remain, including a timeout after 22 records; their exact
browser cause is unproved. Accepted phases use explicit readiness and unchanged
product builds without CSS/timer patches. Thirty-two historical OPEN pairs and
earlier frozen reports remain unresolved and unchanged. Root checks are not rerun.

The following invariant/private-footer batch removes 14 counted utilities in eight
product files: ten duplicate Spinner declarations, two Loro dimensions and the
message row's native hidden-actions/Avatar defaults. Loro's `IconButton` is
module-private with exactly four internal callers; the earlier public-helper
classification was incorrect. Public `SidebarChatRow` compatibility stays intact.

Five private content-spacing utilities remain at `ai-gui/view.tsx:8495`, `:8500`,
`:9325`, `:9341` and `:9390`. The rejected candidate emitted the exact logical
margins, but the complete build grouped reverse writers with priority-zero root
variables and output them without a layer. A real child utilities-layer writer
then lost: leading 12/9px became trailing 12/9px. A standalone writer-only compile
probe had omitted that group and was misleading. A local layer condition nests
under the automatic StyleX layer and does not reproduce the original root layer.
The five utilities were restored; the original browser probe's fields and PNG
match again. Evaluate the shared grouping/layer behavior separately with broad
consumer regressions; no upstream defect acknowledgement is claimed.

`leaves26-acceptance.html` records **136 formal pairs, with 134 byte-exact PNG pairs and
9,782 identical paired node records**. Spinner contributes 48/3,042, message
controls 40/2,616 and Loro 48/4,124; unchanged spacing controls remain in that
matrix. Four separate normal-motion pairs pause the actual CSS animation at
400ms: 6,270 Spinner and 150,288 Button/pseudo values agree. A bounded Owner-menu
repeat matches PNGs and 1,471,622 rendered values across 162 nodes/two stages;
it does not replace its original formal frame.

Two formal pairs remain OPEN: native audio controls (987 raw/567 threshold pixels)
and Owner transfer pending (24/four). Thirty-two historical OPEN pairs and seven
additional original diagnostics also remain: Project avatar one, normal-motion
four and rejected spacing-candidate audio two. Later asset/transition readiness
and identical repeats cannot establish their original paint triggers. The report
keeps originals and raw-difference masks rather than treating a zero threshold
count as a pass. Chromium phone emulation and synthetic product props/callbacks
do not establish native devices, playback/backend flows or unvisited routes.

The exact `d951` Before-view bytes were reconstructed from the preserved `c618`
batch25 Before plus its three known changes and hash-matched to the independently
recorded Before26 fingerprint; they are not an original capture-time source backup.
Rejected gate/fixture phases and the failed asset deadline remain separate from
accepted source phases. Existing owning checks pass in their respective scopes:
view six suites/58 tests, Loro two/26 and Spinner four/28, with package types and
scoped formatting/lint (224/19/220 warnings, zero errors). These overlapping
scopes are not summed as unique coverage; no new root check or Electron/Gallery
run is claimed.

The next Sidebar/ManagedPreview/private-Card batches remove 16 utilities in three
product files. Sidebar removes three ordinary internal defaults; a proposed ten
was narrowed after real DOM prototypes changed outer ancestor and public caller
winners. Its other seven gap/border/radius utilities and separately excluded
floating shadow remain. ManagedPreview uses the existing Spinner diameter API and
removes redundant Cancel shrink. Private `CollapsibleCard` has exactly three
internal callers; explicit `containerStyles`/`bodyStyles` compose with base styles
in one StyleX props call. Worktree retains its inherited bottom-spacing alias;
Tool padding and activity radius keep element-local variables. Space-y writers,
search ring/shadow compatibility and public primitive APIs stay unchanged.

`leaves27-28-acceptance.html` records **192/192 byte-exact formal PNG pairs and
9,684 identical paired node records**: Sidebar104/6,736, Managed32/904 and
Card56/2,044. Twenty separate actual Sidebar-caller pairs have 18 exact PNGs and
two OPEN originals (2/93 raw pixels, zero above summed RGB12); all selected
180-node CSS/pseudo/variable records agree. Three earlier narrow-prototype raw
pairs remain OPEN (5/2/2 pixels); new green product captures cannot close them.
Four independent Managed normal-motion pairs match at actual animation400ms,
including 3,840 ordinary CSS values. Prototype counterexamples, wrong-device
Before12 gate failures, Managed Cancel/raw-spacing assumptions and the initial
Card matched-rule-reader omission remain documented separately.

Managed captures use the real credentialless sandbox iframe and production
inspector resolution, a genuine target click, draft cancel/reopen and a held
synthetic public writer. They do not prove runtime/backend/native-device flows.
Card Worktree acceptance stops at the actual terminal step header, not its
unmounted output. The real direct ThoughtCard/search caller does not complete
assistant builtin/DeepSeek SessionMeta search integration. Sidebar's nine tests
are two adjacent primitive/focus suites, not a nonexistent direct Sidebar suite;
Managed15 and Card82 owning tests, package types and scoped format/lint pass
(3/5/224 warnings, zero errors), without a unique summed coverage claim.

The frozen batch26 report retains its 32 historical, two formal and seven
diagnostic original OPEN pairs. That 41-pair compact index is not an exhaustive
project inventory: earlier main/leaves4 and other reports remain unresolved and
unchanged. This batch adds five supplemental originals, no new formal OPEN,
and no fresh Electron/Gallery or root-check claim.

The message-action/Billing continuation removes another 25 utilities: three colors
at seven fixed ghost Button sites and two dimensions at each of two Billing
Spinners. The existing Button implementation/defaults stay unchanged; its token
module gains a standard package export. Complete local themes explicitly inherit
50 non-target Button/semantic tokens. This scope contains only fixed Lucide glyphs
or the legacy Spinner wrapper, not arbitrary children. A partial Button theme was
rejected because it reset inherited gap and focus-ring tokens; the proposed new
three-color-role API remained research. Fine/coarse hover winners and element-local
legacy variables are preserved through the reviewed existing token groups.

`leaves29-30-acceptance.html` records **168/168 byte-exact formal PNG pairs and
17,216 identical paired node records**: message actions 120/13,208 and Billing
48/4,008. The action matrix retains 112 original pairs and eight stronger-state-ready
pairs. Its original 119-raw/113-threshold Copy/Check mismatch stays visible: the
pending-Fork gate omitted a sibling copy-feedback reset. No product timer/CSS was
changed. Eight separate native default/scoped pairs match ordinary CSS, pseudo
maps and glyph descendants; all 50 non-target tokens retain 46,800 recorded values.
The three retargeted inputs intentionally differ in 1,092 raw token values.

Four same-element original-token inline stress pairs each differ by 673 raw and
672 threshold pixels. Before physical Tailwind colors dominate those primitive
inputs; After the new local theme permits stronger inline inputs to affect ink.
This is real CSS non-equivalence. Current seven source sites expose no such
style/token/child props and the two private Fork callers pass only opacity/margin
classes; supported ancestor themes remain distinct and verified. Do not promote
this theme to arbitrary Button consumers or descendants reading `colors.label`.
The negative controls and single-panel compiler/DOM-clone research are separate
from accepted product screenshot pairs.

Billing uses actual component preview, Cancel/reopen and held confirmation paths
with synthetic public providers, not real Stripe/auth/backend E2E. Four accepted
normal-motion pairs agree at actual animation 400ms, including 3,840 ordinary CSS
values and explicit dialog/ancestor paint state. Four earlier byte-equal but
near-transparent dialog pairs were rejected; exact original opacity was not
logged. Initial accessible-name gates and native runner/cleanup failures remain
separate. Earlier 27–28 five supplemental OPEN pairs and batch26's non-exhaustive
41-pair compact index remain unchanged, alongside all earlier reports.

Owning checks pass for message actions three suites/39 tests and Billing two/30,
with scoped types/lint (224/36 warnings, zero errors). Full components pass 620
files/6,207 tests, but view changed from pre29 to the candidate during that run;
this is explicitly mixed-source, not frozen-final29 coverage. UI 25 files/302 tests
pass on unchanged recorded UI source. The submission audit's root `pnpm check`
fails in ACP adapter preparation on 32 unresolved SDK export paths; subsequent
stages did not run and no unrelated ACP work was attempted. Root `format:check`
passes but omits components/UI; a separate read-only check of 313 changed files
finds 20 visual JSON profiles needing formatting, without product-source failures.
Profiles remain frozen for evidence. Offline lockfile-only verification in a
47-file manifest/patch tree leaves the lock hash unchanged; no dependency change
is required for the export. All 315 precheck dirty-file hashes remain unchanged.

The panel/iframe/search continuation removes 26 actual utilities: 15 panel
header/rule/title/body occurrences, five managed-iframe declarations and six
colors at two fixed SearchBar Button templates. Frame/background/font-weight
compatibility remains in the panel; search keeps its disabled ink `/40`, rounded
shape and transitions. All values retain element-local reads. Iframe lifecycle,
security attributes and preload are byte-identical outside the style block and
single class assignment. No new primitive default or token group is introduced.

`leaves31-33-acceptance.html` records **168/168 byte-exact formal PNG pairs and
12,024 identical paired node records**: panel 56/2,180, iframe 32/904 and search
80/8,940. Native panel observations add 314,928 values across 216 role snapshots,
not unique DOM nodes or more screenshots. Iframe paint is checked at 192 declared
points in 64 original full PNGs; three extra native pairs agree in pixels and
8,676 CSS/pseudo/runtime values. The accepted transparent fixture document matches
the child color scheme. Its original dark v1 really painted white despite computed
cyan; a same-frame child-scheme-only diagnostic caused white→cyan. That experiment
and the failed v1 screenshot are separate from accepted product Before/After.

Search exercises real typing/navigation/wrap/clear/Escape, Close unmount/reopen,
keyboard focus, held mouse release outside and coarse sticky hover. The States
story labelled 42/128 actually clamps to 5/5; the full story reaches 128/128.
Eight supported native pairs agree in pixels, 181,640 ordinary CSS and 72,656 root
pseudo values, including actual glyph descendants. Fifty non-target tokens retain
28,500 values across all twelve scenes; three changed inputs retain 940 raw
string differences. Four same-element original-token inline negatives each change
392 raw/392 threshold pixels, with 1,480 ordinary and 1,156 pseudo differences in
total. These are real CSS non-equivalences. Current SearchBar forwards no visual,
style or arbitrary-child props, and its three production callers pass only
height-only rootFill; the private skin is not a general Button/ancestor contract.

Artificial ancestor prototypes remain non-authoritative: fine computed ink changes
although both original PNG pairs match; coarse selected ink stays equal while one
phone-light pair differs by two raw pixels. No paint cause is inferred. Panel's
three predicate failures, iframe v1 and search's saved-screenshot/cleanup stalls
remain diagnostic. Final native data completed before two cleanup processes were
stopped; normal process exit is not claimed. Scoped checks pass: panel 26 tests,
iframe 15 and search 30, types and format, lint 7/1/120 warnings with zero errors;
these overlapping scopes do not establish a new full/root suite. Offline report
QA decodes all originals/previews and passes two continuous 1280/390 Chrome
interaction cycles. Earlier frozen 29–30/27–28 negatives and OPEN indices remain
unchanged and are not exhaustive; no new Electron/Gallery acceptance is claimed.

The fixed-ink/project-selector continuation moves ten source utilities: three
Operation reply/Header More ink declarations and seven group-glyph declarations.
The ink theme changes only `ghostLabel` and semantic `colors.label`; all 51 other
tokens, including `ghostHover`, inherit unchanged. Backgrounds and control defaults
are not restyled. The discarded second More JSX child's old class remains. Group
glyphs retain element-local spacing/opacity, owned shrink0 and fallback shrink1,
including the fallback's 16px flex slot and actual public caller overrides.

`leaves34-35-acceptance.html` is **partial visual acceptance: 105/108 formal PNG
pairs byte-exact, three current OPEN; all 5,264 paired standard node records equal**.
Ink accounts for 48/2,992; selector 60/2,272. Selector final rows reference 48
unchanged original closed-state pairs plus twelve real painted-menu captures,
with original manifest/key/PNG/layout provenance; this is not a synthetic capture
manifest. Four natural menu pairs preserve real 70% opacity without a caller
mask. The original gate accepted mounted geometry at popup opacity0/translateY(-4px).
Only readiness was repaired to require painted opacity1/identity/no lifecycle flags
or pending finite transitions; no product CSS patch supplied acceptance.

Three current focus-ring corner pairs retain 14 raw/zero threshold pixels; six
original menu pairs retain 24 raw/zero threshold pixels separately. Both sets
remain OPEN. The changed pixels lie outside migrated glyphs. A bounded eight-PNG,
197,883-value ring probe retains three desktop pre-shot transition declaration
differences and stable same-source repeats; post-shot maps and full boxes agree.
It does not prove the exact raster cause or retrospectively close either set.
Selector probes also preserve disabled focus/nonactivation, keyboard selection,
caller removal and 44 SVG snapshots, not additional formal pairs.

Eight supported ink native pairs agree in pixels, 160,608 ordinary and 68,832 root
pseudo values. Across twelve scenes, 51 non-target tokens retain 25,704 values;
two targeted inputs differ in 456 raw values. Four same-element old-token inline
negatives genuinely change ink (975/966 raw, 744/740 threshold pixels by palette),
while backgrounds and original input tokens stay equal. Fixed current children
and no style/token forwarding bound this adoption; it is not a generic Button skin.
Native checkpoints complete before cleanup stalls on both sources; exact tool
cause remains unproved and normal process exit is not claimed.

Ink's 16 and selector's 14 owning tests, types and scoped format pass; lint has
3/5 warnings, zero errors. The report preserves raw differences and derived-mask
labels, with independent original-source/hash/payload verification and two
continuous 1280/390 Chrome UI cycles. It references frozen earlier report hashes
without closing any historical OPEN or negative contracts. These are synthetic
public component fixtures, not full backend/runtime/native-device coverage; no
new whole-project, root-suite, Electron or Gallery success is claimed. A later
stable-source UI regression passes 620 component files/6,207 tests and 25 UI
files/302 tests. Its 2,364-file snapshot was recorded after launch, with all product
owners already frozen; no snapshotted source changed, but the launch-to-snapshot
interval remains a stated limit. This later evidence does not close pixel OPENs
or the unrelated root ACP preparation failure.

The control-dimension continuation removes twenty utilities across file-error actions,
attachment menus, desktop run-config bounds and preview connection status, using
existing primitive APIs. Exact local spacing expressions preserve subtree readers;
compact submenu bounds are transferred through one private shared object across
five actually rendered consumers. No primitive defaults or behavior change.

`leaves36-39-acceptance.html` preserves **248 formal pairs: 246 byte-exact, two
OPEN; all 13,210 standard node records agree**. The file actions contribute
60/1,332, attachment 68/2,512, run-config 72/7,390 and preview 48/1,976. The two
original differences are eight raw pixels at a model-search popup edge and
226 raw/three threshold pixels at the unchanged fixture control's edge. Seven
of 51 additional Browser Preview pairs retain 57 raw/zero threshold pixels.
Twenty selected normal-motion/local-variable supplementary pairs are exact.
New bounded captures and matching CSS do not close original pixel differences.

The preview's first element-local capture mixed a 633px After screenshot height
with 1,000px Before images. Those frames are rejected as capture mismatches.
Four later cross-method pairs also differ despite equal sampled styles; they
remain separate diagnostic evidence. Repeating both sources with the same real
Chromium, viewport/PNG-dimension gates and actual animation timelines gives four
exact pairs. A bounded original-flow probe records full ordinary/pseudo styles,
ancestors, hit stacks, pointer/focus states and animations without CSS writes:
new PNGs match the original Before, but no original raster cause is proved.

The existing 51-story browser regression also exposed four production Storybook
`React.act` failures. Only the story's native input/submit sequencing and the
test's configured base URL changed; both corrected Before and After runs pass.
The original failed runs and screenshots remain evidence. Temporary verification
directories disappeared during continuation; stored manifests/PNGs survived.
The approved Node archive was restored against its official SHA, and isolated
builds were recreated from the local committed UI plus hash-locked inputs. No
main synchronization, runtime/backend repair or user-work reset was performed.

The subsequent solo share-title continuation removes nine owned native layout
utilities while retaining the font-weight writer and explicitly composing the
existing active-tab styles. Its 28 real PNG pairs and 4,102 standard node records
agree. Twelve CSS scenes compare 24 pill/label nodes and 112,728 ordinary/pseudo
values, including scoped 40px height/13px radius and actual long-title ellipsis.
The border still reads the existing global `--tw-border-style` registration;
removing Tailwind's global infrastructure needs separate contract work. Scope
checks pass, including twenty sharing tests; lint retains thirteen warnings and
zero errors. This successful subset leaves all prior OPEN evidence unchanged.
A subsequent frozen-source regression passes all 620 component files/6,207 tests
and 25 UI files/302 tests. Its 1,264 product/style files were hashed before test
launch and remained unchanged; independently prepared next-batch stories were
outside that product freeze. This is UI-suite evidence, not a root/Electron pass.

The spacing/avatar-default continuation removes twelve more utilities: six from
Banner/Fork/Share glyphs, four from mobile account controls and two encrypted
workspace-mark defaults. The typography retains the original size/leading variable
readers; the body-scoped share glyph keeps its actual 16×17.5px flex shrink rather
than being forced square. Two account inputs already inherit the primitive's
100% width, and pending-spinner margins remain local spacing reads. The encrypted
mark's nullish fallback still lets an empty or opaque caller class replace the
entire default; its SVG size14 attributes and actual Menu/Sheet ancestors remain.

`leaves41-acceptance.html` records 60 exact PNG pairs/1,900 equal standard records.
Each side references 52 original successful frames plus eight explicitly sourced
missing frames; neither is described as a single clean capture. Four subtree-gate
timeouts per side, original candidate frames and the wrong square-glyph gate stay
diagnostic. Eighteen CSS scenes compare 66 samples/310,275 values; twelve newly
introduced private width/height variables and expected attributes differ. The
initial Banner timeout trigger remains unknown, with an executable bounded
follow-up rather than an asserted clock cause.

The 42–43 continuation records another 64 exact PNG pairs/4,536 standard records.
Eight real normal-motion closing pairs hold the actual finite exit at its start
and advancing Spinner timelines at 400ms; they do not prove the entire closing
animation. The mark compares twelve CSS scenes/36 glyphs/169,302 values, including
actual caller replacement and body palette overrides. Scoped checks pass (19, two
and eight owning tests respectively); lint retains one/twelve/zero warnings with
zero errors. Existing source-profile mistakes and label-case calibration failures
remain separate from the matching final matrices; no prior OPEN is closed.

The modal-spacing/avatar-glyph continuation removes eight more utilities. Dialog
and AlertDialog share explicit padding/gap choices instead of callers competing
with their panel styles; defaults, omission reset and inline style callbacks keep
their contracts. The API is documented in the owning [UI README](../../../../packages/ui/README.md).
Drawer remains separate because its logical safe-area padding and Base UI state
callbacks require independent acceptance. The two avatar fallback SVGs use local
100% width/height styles inside the existing five-rung glyph holders, preserving
all root APIs and mounted nodes. UserAvatar's actual working-tree d22e source,
including its original parameter-format hunk, is the Before; a differently
formatted HEAD copy is not substituted.

`leaves44-45-acceptance.html` embeds 108 byte-exact formal pairs and 7,536 equal
standard node records: modal API/callers 84/2,520 and avatar glyphs 24/5,016.
Twelve modal CSS scenes compare 48 nodes/231,048 values; four avatar CSS scenes
compare 120 nodes/563,580 values. Expected raw class changes remain recorded.
The avatar DPR3 probes are CSS-only; formal screenshots use DPR1 and reduced
motion. Four actual Gallery and four actual Electron images are After-only,
separate from these pairs. Electron main/preload/renderer were rebuilt with the
unchanged bundled CLI artifact; its waiting configuration, synthetic Explore
tour and empty local chat do not establish agent/cloud or desktop Before/After
equivalence.

The first Rename consumer capture met the real popup's conditions but failed the
harness's visible-story-root gate because the entire dialog was portalled out of
an empty decorator. Only those two target IDs opt into the existing blank-root
exception, retaining strict actual-popup paint, spacing, theme, focus and motion
gates. Five original error images, two interrupted successful images and the
count-correction addendum remain; no original data is overwritten. The modal
fixture intentionally changes only its legacy-class adapter to API props between
Before and After, with both byte hashes recorded. Full UI checks pass 25 files/304
tests; a later source-locked components run passes 620 files/6,207 tests, with all
1,264 product/style hashes unchanged. Root format passes; the attempted root
check still stops at the existing ACP SDK export build failure. Earlier pixel
OPENs and negative contracts retain their status.

The Dialog-consumer/Spinner-spacing continuation removes ten utilities across
seven product files. Pasted-text editing and Quick Open use the modal spacing API;
Operation reply removes two declarations already owned by that primitive. Five
private Spinner margins retain physical `margin-right` and element-local spacing.
`leaves46-47-acceptance.html` records 128 exact formal pairs/7,484 equal standard
records. Both sides of the pasted-text interaction use a real coordinate click
through its pointer-transparent mirror to the textarea, with the same runner.
The Spinner matrix retains its earlier frozen runner independently.

The normal-motion supplement has eight exact pairs and two Billing OPENs
(137/123 raw pixels, 18/20 above the summed-RGB threshold). All 470,114 target
CSS/pseudo values and recorded geometry/400ms animation fields match; the original
background paint phase is unproved. Four original whole-app RTL offscreen-popup
failures and rejected animation-target calibration remain. Eight local pending-button
RTL states establish physical margin behavior, not whole-app positioning. In a
forced UI-dark/global-light fixture, the paragraph remains rgb(30,30,30) on a
rgb(22,22,22) panel in both sources; its inherited alias chain was not independently
resolved. No palette patch or full-theme integration claim hides that limitation.
The two owning groups pass 13/14 tests, types and formatting; lint retains 17/38
warnings with zero errors. Earlier full-suite evidence keeps its original source
boundary, and no earlier OPEN is closed.

The input-height/CommandDialog continuation removes another nine utilities.
`Input` and `PasswordInput` expose `controlHeight` for the well while preserving
the existing native `height` attribute on the input. Named density and leading/reveal
slots stay fixed. Plain inputs merge dynamic StyleX variables before the original
style object/state callback; wrapped controls keep that callback on their inner
input. Zero, omission reset, mounted refs/focus/value and password reveal are
verified. The owning UI README records the public API. No token group is added.

`leaves48-49-acceptance.html` records 96 formal pairs/5,296 equal standard records:
93 PNGs match and three Input revealed-state frames retain one green-channel-unit
pixel difference each. Their exact raster cause remains unproved; a single unchanged
Before control matches the original Before rather than After. The 28 CSS snapshots
compare 296 selected records and 425,352 ordinary/pseudo values without differences;
84 expected new private height-variable values and 90 attribute changes stay separate.
Four real Gallery images are After-only. Full UI passes 25 files/307 tests and
source-locked components passes 620/6,207 with all 1,264 product/style hashes unchanged.

CommandDialog's 40 pairs preserve its existing 512px panel overflow in a 390px
viewport. Two original phone errors and eight originally unexecuted states remain;
the accepted source list explicitly combines 30 healthy originals with ten real
known-overflow captures rather than fabricating a capture manifest. The matching
result does not assert viewport fit, native/backend execution or closure of earlier
OPENs. Current implementation and visual limits remain distinct.

The private-spacing/input/loading continuation removes seventeen utilities in
eleven product files. Existing primitive APIs own the three input heights and
workspace-delete, Emoji and public-browser Spinner dimensions. Nine private
margin/offset changes preserve local spacing; actual build rules establish their
longhand precedence while retaining absolute positioning and the opaque Skeleton
class marker. Unknown source markers are not treated as redundant shrink utilities.
The Emoji runner holds real bundled requests and continues their actual responses,
so Loading and loaded/search/keyboard/scroll/forced-color states are real UI.

`leaves50-54-acceptance.html` contains 208 formal pairs/12,304 equal full recorded
layout nodes: 204 exact PNGs and four original OPENs. Method origins remain explicit:
180 standard and 28 native pairs. The collapsed PlanBar retains 14 raw pixels/zero
above-threshold pixels; three deletion-sheet frames retain 28 raw/four
above-threshold pixels. Bounded controls and equal CSS/geometry do not prove those
original raster triggers. Four real normal-motion renderer Spinner pairs are
separate and exact. Selected CSS probes retain their expected private variables
and raw attributes; the first unsettled Emoji color samples are not silently
normalized or substituted for formal screenshots.

The public-browser fixture accepts only renderer Loading/ready/error and explicit
never-forward synthetic IPC replies. Its first 32 candidate frames are rejected:
a normal probe exposed two actual unhandled theme-setter IPC errors. Correcting
only the fixture and rebuilding original product source establishes a new clean
Before32/normal4. Original errors/images and the first 32 candidates remain. This
does not cover WebContentsView contents, native navigation or network execution.
The five owning groups retain their scoped check results; the full components/UI
runs keep their through49 boundary. The report includes eight original spacing
gate failures, with four Banner triggers still UNKNOWN. New successful scopes
do not close these or earlier OPENs.

The private-header, dark-option and pinned-message continuation removes eighteen
utilities in six product files. Existing primitive APIs retain control sizes;
local StyleX owns private margins, offsets and the usage-share Header. The
protected Calendar source reverses only its two task hunks to reproduce the
actual original working bytes; its user formatting is not part of that patch.

`leaves55-59-acceptance.html` records **164 exact formal PNG pairs and 26,232
identical full standard layout records**: 55 has 44/7,920, 56 has 48/4,080,
57 has 48/880 and 59 has 24/13,352. Each row retains its original immutable
build/manifest and hashes; computed-only checks add no screenshot pairs. The
report embeds 143 unique actual browser PNGs, four separately labelled derived
masks, sixteen rejected candidate pairs and four original readiness-error images.
Prior reports and their OPENs stay frozen.

The dark option map retains the exact dark/light-exclusion predicate, white-alpha
fallback/support branch and hover media. Coarse hover still uses the original
foreground at 5%; dark keyboard focus reads local `--color-white` at 10%. The local
scope fixtures do not force a whole UIThemeRoot palette. SessionPin retains
`flex-1`/`justify-start`: a real full-build DOM prototype replacing all six classes
changed flex-shrink from 1 to 0; only four non-conflicting properties migrated. The wide
action is a toggle, not uniformly expansion. The usage-share Header preserves
logical padding-inline and physical right padding at 639/640px and RTL, the
local border-style writer and the compiler's **opaque** border-color fallback;
color-mix support supplies 70%. Other typography/primitive compatibility remains.

WindowDragStrip (58) accepts zero utilities. Its actual renderer/public-caller
counterexample reverses absolute/fixed precedence; the tested z-index case stays
unchanged, and other geometry properties remain unproved. It does not verify
native OS window dragging. The later sidebar (60) candidate also accepts zero:
all three original sources are restored after real base/state and public
descendant callers change color, opacity and pointer-event winners. Its retained
16-pair candidate subset has 12 pixel matches and four differences, outside the
164 formal pairs. Remaining properties are not all assigned the same proven
failure. These are scoped counterexamples, not a permanent block on public
styling: a later unit can migrate the complete owner and real caller contracts
together. The incomplete native candidate has 25/28 checkpoints; its timeout
trigger remains unproved, with no missing screenshots invented.

Owning checks pass (55: 22 tests; 56: 5; 59: 27 related aggregation/export-adapter
tests). Batch 57 has no direct owning suite, so actual callbacks, keyboard/unpin/wide-toggle
and CSS evidence retain that boundary. Types/explicit format pass; typed lint
reports 32/0/1/2 warnings respectively and zero errors. A later source-locked
through 63 run passes components (620 files / 6,207 tests) and UI (25 / 307), with 1,486 product
files unchanged; it is not relabelled as an exact-through59 run or pixel gate.
Original batch 59 portal-root errors remain beside the corrected strict dialog capture.
Component Header stories do not establish a current production menu flow; Calendar
phone bottom content and usage-share phone initial preview visibility stay
limited. Synthetic public data does not prove backend/publication/export/native
workflows, every animation frame or physical iOS behavior.

## Remaining work

The compiler-backed [inventory](../../../../packages/components/scripts/tailwind-usage.mjs)
validates AST-discovered candidates with the locked Tailwind compiler. Counts
are source-occurrence lower bounds, not runtime coverage, emitted CSS size or a
completion percentage. Unresolved expressions remain a separate work list.

| Source boundary                                            | Scanner method | Occurrences | Files | Unresolved |
| ---------------------------------------------------------- | -------------- | ----------: | ----: | ---------: |
| Frozen 29–30                                               | v1             |       1,736 |   175 |        721 |
| Frozen 31–33                                               | v1             |       1,715 |   175 |        717 |
| Same pre31 source snapshot                                 | v2             |       1,741 |   176 |        725 |
| Frozen source through 35                                   | v2             |       1,705 |   175 |        721 |
| Frozen source through 40                                   | v2             |       1,676 |   175 |        721 |
| Frozen source through 43                                   | v2             |       1,664 |   173 |        721 |
| Frozen source through 45                                   | v2             |       1,656 |   171 |        721 |
| Frozen source through 47                                   | v2             |       1,646 |   169 |        721 |
| Exact source through 49                                    | v2             |       1,637 |   169 |        721 |
| Exact source through 54, visual limits recorded separately | v2             |       1,620 |   168 |        721 |
| Exact source through 59, excluding later candidates        | v2             |       1,602 |   168 |        722 |

Earlier method changes recognized single utilities, `withClassName`'s second
argument and supported static class arrays. Historical per-batch counts remain
in their frozen reports; their baselines must not be combined across methods.
For example, the four-file helper rescan measured 165→97 rather than treating a
retained utility moved inside a helper as removed. Some migrated runtime layout
literals also lay outside the static count.

Scanner v2 additionally follows direct dot/bracket `className` assignments.
This closes the concrete iframe gap: v1 omitted five real utilities, so batch31–33
removed 26 source utilities while its old static lower bound fell by 21.
The original scanner source and inventories are preserved. Re-running v2 on an
independent exact pre31 source snapshot makes the baseline 1,741 rather than
rewriting the frozen 1,736 report. Functional parser tests cover aliases,
source-location deduplication, direct writes, dynamic/compound writes and valid
utility-looking strings in comparisons or unrelated properties. Ambiguous writes
remain unresolved. Two adapter `className` writes expose four additional unresolved expressions,
explaining the corresponding increase in that count.

The published through 59 v2 split is components: 1,153 occurrences/152 files/629
unresolved, legacy UI: 444/14/93 and routes: 5/2/0. These totals cover only those
three source roots. Normalized paths retain the raw scanner output and all 688
component JS/TS byte hashes in the exact through 59 snapshot; later 61–63 edits are
excluded. Calendar's className template adds one unresolved expression while 18
utilities disappear. A separate through 63 helper audit identifies another nine
occurrences across two lib/hooks files, outside these three roots; it is neither
folded into the same-boundary through59 total nor called a new product regression.
Expand the inventory scope explicitly before comparing that additional work. Batch34–39 visual differences and rejected
calibrations retain their own status; this source inventory does not accept them.

WebWorkspaceLayout remains deferred until its actual sidebar/runtime/router
graph has a bounded production-component fixture.

The unconsumed `src/ui/sidebar.tsx` retains 304 occurrences and is not re-exported
by `src/ui/index.ts`; direct public wildcard imports remain possible. Its public
adapter now has real rendering fixtures, including mobile open and desktop collapse.
The unconsumed `src/components/task-list.tsx` retains 14 occurrences,
`src/components/sidebar-updated-task-list.tsx` retains 22; both now have real
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
clipped card into view and present that as the natural touch path. The
`ghostValueClass` contract and PinButton primitive compatibility remain. Trusted Chromium touch input does not establish native iOS
or WebKit behavior, and custom VS Code themes have not all been exercised.

Continue with the retained chat/mobile primitive overrides, remaining Emoji
Picker / Drawer compatibility, the diff adapters and other legacy `src/ui` wrappers, and
third-party descendant selectors. Sidebar compatibility still needs owned ancestor
markers and control-level composition.
Keep primitive compatibility separate from owned DOM work. Hard-coded dark
variants require the exact element-local theme predicate, as FilterPillBar now
preserves; owned ancestor states use qualified markers. Remaining variants need
their own caller and scope verification. The report records the final measured inventory and exact
unverified states, including file/hash metadata popovers and native gestures.
No screenshot set here establishes full remote/backend or every-theme coverage.
