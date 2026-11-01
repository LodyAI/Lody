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
reports 32/0/1/2 warnings respectively and zero errors. The complete source-locked
regression belongs to the later through 63 boundary below, not exact-through59
visual proof.
Original batch 59 portal-root errors remain beside the corrected strict dialog capture.
Component Header stories do not establish a current production menu flow; Calendar
phone bottom content and usage-share phone initial preview visibility stay
limited. Synthetic public data does not prove backend/publication/export/native
workflows, every animation frame or physical iOS behavior.

The notification, menu and native-dark continuation removes eight utilities in
six files. Private notification text reuses the existing action themes; their
four same-element token negative controls still expose a real ink difference.
Help uses the existing `minWidth={160}` API, and three popup overflow declarations
are redundant with the unchanged primitive. File-notice ink and active-terminal
fill keep the complete dark/light-scope predicate and element-local variables.

`leaves60-63-acceptance.html` retains **134 formal pairs: 132 byte-exact and two
OPEN**, totalling 43 raw differing pixels. Of 9,284 paired standard records,
9,270 agree; fourteen original height changes belong to an empty, hidden xterm
helper identified on both sources. Original records remain intact. Bounded
controls do not establish the historical pixel causes. The six original phone
Role viewport failures remain outside acceptance. Notification Before provenance
explicitly combines 48 healthy original frames with 16 corrected root-palette
frames; rejected calibration and distinct harness identities stay available.
Supplementary wheel captures, CSS probes and two terminal After-only inspections
are counted separately. This source boundary remains partially accepted.

The complete regression run freezes 1,486 product files through this boundary:
components pass 620 files / 6,207 tests and shared UI passes 25 / 307. Owning
subsets overlap those totals. Root checks retain the existing ACP prerequisite
failure; this UI work changes no ACP dependency or backend behavior. The report
also preserves the withdrawn batch 60 candidate and every earlier OPEN.

The control-spacing continuation removes 22 utilities in eight product files.
Five Select widths are already supplied by the well; the private archive fill
retains its opaque fallback and supported 35% mix. Other fixed controls write
existing public Button tokens at the element. An already themed Operation action
keeps appearance and spacing in one complete compiler-local theme; the owning
rules are in [`MIGRATION.md`](../../../../packages/components/src/style/MIGRATION.md).

Default screenshots alone missed a real imported-spread regression: 48 pairs
matched while parent gap reset 9→6px, radius 9→8px, font and colors changed. Its
actual parent-theme image has 3,317 raw differing pixels; the corrected image
matches Before byte-for-byte. The other rejected candidate has 180 unexpected
CSS differences. Final non-target token values agree. The private Button fixture now uses the same compiler-local complete map: its
20 affected real pairs and 724 records remain identical, and both actual CSSOM
themes contain all 27 declarations, including 18 inherited fields. This fixture
correction removes no product utilities. The two older message-action fixture
helpers still need that audit; measured explicit overrides do not prove omitted
inheritance declarations were emitted.

`leaves64-67-acceptance.html` retains **192 formal pairs, 191 byte-exact, and
48,356 identical full standard records**. One Select corner difference remains
OPEN (11 raw / 6 threshold pixels). A separate native sample retains one Button
and three children at y−4px, with no original PNG; a later matching full Dialog
control establishes no original cause. Eight same-element inline-token negative
pairs keep known layout changes outside the closed product inputs. Twelve
original error images, corrected gate assemblies and every earlier OPEN remain.
A supplemental working-tree regression through 71 passes components 620 files /
6,207 tests and UI 25 / 307, with all 1,861 UI source hashes unchanged during
the run. The actual OSS Electron build and four-page smoke pass; those images
are After-only, without an application Before baseline. These checks establish
no native icon, export or backend workflows. Frozen reports keep their own
source boundaries.

The modal/popup continuation removes 18 utilities across eight product files.
Fixed title, footer and popup geometry writes existing public tokens locally;
three standard token-module exports add no group or dependency. DrawerContent's
opt-in `width="full"` lets the actual file-viewer caller drop its two important
width classes; omission keeps the original directional class/style contract.
The five other fullscreen callers are not counted as migrated. Token overrides
remain limited to audited descendant readers, as the owning guide requires.

`leaves68-71-acceptance.html` separates **208 product pairs / 200 byte-exact /
10,248 identical full standard records** from 20 unchanged fixture-correction
pairs. Eight original trigger-corner differences remain OPEN (48 raw pixels,
zero threshold pixels). Two original normal-motion Drawer pairs also remain
OPEN (25,902 raw / 11,176 threshold pixels). A later protocol produced three
wrong compositor poses despite identical main-thread animation records; actual
pixel boundaries and a same-page WAAPI-order control establish that sampling
failure. Those captures are excluded, while a later matching control does not
close the original two differences. Known inline-token negatives, calibration
errors and the actual Electron After-only images are separate evidence.

The typography and command continuation removes twelve utilities in six files.
Title and description overrides retain the original element-local `--text-*`
size and `--tw-leading` fallback expressions, including the unchanged weight and
explicit leading writers. The closed Command backdrop preserves its `#0006`
fallback, feature-gated local black mix and complete nine-filter pipeline. Its
panel keeps `bg-transparent`: publishing the background token changed a real
child's inherited value and is unsafe for arbitrary public ReactNode children,
even when the default panel pixels agree. Both rejected source versions remain.

`leaves72-73-acceptance.html` retains **112 pairs / 111 byte-exact / 9,748 identical
full standard records**. The original blurred background opener differs by 429
raw pixels and zero threshold pixels. Independent Canvas and PNG decoding agree;
a bounded same-flow control matches After, which does not identify the original
cause. The legacy tool's `identical` status uses threshold/layout checks: the
initial forty-pair candidate actually has 39 byte-exact PNGs. Its old label and
explicit correction remain, alongside local-font positive controls, known inline
negatives and real portal-gate calibration failures. Earlier OPENs stay unchanged.

### Control ownership and capture boundaries

Batches74–95 move owned Tooltip, resize-edge, label, context and filled-action
styles through existing primitives, preserving their actual caller contracts.
The product adds no token group or dependency. Button gains CSS-typed `fontSize`
and `lineHeight`, plus an explicit flat `solid` variant; ResizableHandle gains
an opt-in edge appearance. Existing defaults remain unchanged.

Typography values must reach the physical CSS fields when the API accepts all
CSS values. The rejected custom-property Button implementation passed sixty
ordinary screenshots but changed `initial`, `inherit`, `revert` and nested `var()`
fallback semantics. The final fields merge with the owner's StyleX inline values;
omitting both preserves its original style object. It passes 104 browser semantic
cases and 24 class-priority cases, with direct caller-style behavior and Base UI
render-element merging recorded separately. Fixed-text Field labels instead write
existing size/leading tokens: inputs are siblings and there are no descendant
readers. Login retains full size/leading, while mobile labels change only size.
Weight, tracking and private leading writers stay compatible.

Fixed Card titles also use existing size/leading atoms, preserving weight and
tracking. Textareas use existing resize/min-height/background contracts and their
existing physical `style` fields for size/leading, retaining placeholder, controlled
value, pending and cancel behavior. These do not introduce a generic style API.

Skeleton adds an opt-in `ring` shape with a transparent centre and a 2px contour.
`strokeWidth` changes only that shape, accepts explicit zero, and restores the
contour when removed; other shapes keep their sizing and paint. The fixed calendar
ring uses its old local primary expression through the existing feedback token.
Its unsupported-color-mix fallback is opaque `hsl(var(--primary))`, not a guessed
10% HSL alpha. The current ring has no children; inherited-token overrides are not
an arbitrary-descendant contract. Normal pulse endpoints and existing default/
zero/removal sizing controls are separately rendered. No new token group is added.

Fixed Avatar callers keep the medium context while overriding only its existing
size token. Changing the named rung would also change fallback letters, glyphs
and radius. The app-owned mobile `xs` keeps local `spacing * 5`, literal `.68rem`
type and `.25rem` corners, inheriting its original line height. Protected
UserAvatar source remains unchanged. Ten direct same-element size-token controls
show the changed priority boundary and remain explicit negatives; the reviewed
private callers expose no such writer.

Accessible names remain mounted. Opt-in `visuallyHidden` composes the compiler's
nine invariant fields inside the actual Dialog and Vaul Title/Description owners,
and Popover Title, without changing contexts, DOM or ARIA attributes. The physical
1px/-1px and `inset(50%)` values do not follow theme spacing. Dialog Title also
clears its existing logical-end padding in the same owner composition. Default
parts retain their old fields, IDs, refs and render-element merging. The shared
Dialog/AlertDialog/Base UI Drawer Header supports the same opt-in for the whole
name block; Footer does not. Its Sidebar consumer changes only that attribute,
preserving the pre-existing user diff byte-for-byte. Gallery
images are After-only. The stack's original dangling `aria-describedby` remains
an equal missing reference on both sources, not a claim that all ARIA is valid.

`solid` owns only fill, label, fine-hover 90% alpha and the existing focus ring.
It reads existing primary inks and ignores destructive tone like primary, adding
no sheen, edge or press transform. The private Session theme inherits all other
twenty-five Button tokens. Six old shadow/transition/active utilities remain,
including their original focus result; all 165 old-variant control nodes retain
raw attributes and full ordinary, pseudo, custom-property and geometry records.
Token writes remain limited to reviewed fixed glyph/text subtrees. Real
same-element inline-token negatives are not accepted as arbitrary-input equivalence.

Resize edge composes inside its owner rather than competing with the base through
caller classes. Its actual consumer is horizontal; default vertical coverage does
not prove an edge variant there. No-preference captures verify the actual 150ms
delay/duration and settled endpoints with screenshot animation disabling, not an
uninterrupted sequence. The private diff-notice and DiffViewer headers retain
their dark border utilities: real public `*:` callers expose a layer-order contract
that moving the declaration cannot preserve. Other header rules and the native
Chevron migrate, retaining its original non-square shrink behavior. Full-build
CSSOM verifies actual logical insets; the earlier margin-block compiler issue is
not generalized to every camel-case logical property.

Preserve compiler output and runtime scope. Tooltip `max-w-xs` is literal `20rem`,
while other fixed bounds remain 420px/22rem and spacing-based bounds keep local
variables. Context `px-*` and the UI owner both compile to `padding-inline`;
four vertical-writing PNG pairs verify all four nonzero physical edges. The
mobile menu row has no owner font-size declaration, and its detail preserves
the global monospace variable plus ligature hook. Two composer resize rules are
redundant across the actual CombinedMentionTextarea branches; this does not promise
that an exported class helper styles an arbitrary bare textarea.

Focus hint observes every original `.group` ancestor, including outside the
composer. Full compilation doubles its StyleX class, so the final
`:where(.group:focus-within *)` retains total specificity two. This still changes
a synthetic same-element `opacity-100` winner because the layer changed. The
private hint has no caller class/style slot; no extra specificity hides that
boundary. Tabs use manual activation: direction keys move focus and Enter selects.
Twelve original failed selection assertions remain beside twelve strict corrected
cells. Sixteen Login keys named `email-focused` actually fill the password last;
the report identifies filled credentials/password focus, preserving the old keys.

A small provider/memory-router fixture mounts actual MobileWorkspaceStack,
ChatLanding and the real SessionDetail loading branch, replacing no child or
runtime. The existing full-width owner API removes its own directional cap.
This accepts one real consumer; four SessionDetail inner Drawers remain unvisited.
Its known injected inline-width negative lies outside the private stack props.
Original native Escape timeout evidence stays beside a trusted content-key
control and explicit recovery sources; missing original DOM cannot prove the
old timeout's exact cause.

| Frozen report                 | Formal pairs / byte-exact / full standard records | Original OPEN retained, raw / threshold pixels                              |
| ----------------------------- | ------------------------------------------------: | --------------------------------------------------------------------------- |
| `leaves74-78-acceptance.html` |                                310 / 305 / 30,303 | Five formal 13 / 0; two sidebar supplements 882 / 829.                      |
| `leaves79-81-acceptance.html` |                                296 / 292 / 14,056 | Four formal 1,075 / 0; one native supplement 22 / 0.                        |
| `leaves82-84-acceptance.html` |                                306 / 305 / 12,854 | One disabled-button corner 10 / 7.                                          |
| `leaves85-88-acceptance.html` |                                284 / 284 / 12,554 | No new formal OPEN; all historical OPEN retained.                           |
| `leaves90-93-acceptance.html` |                                 164 / 164 / 8,068 | Original hover three pairs 5,602 / 5,534; native header one pair 473 / 402. |
| `leaves94-95-acceptance.html` |                                152 / 152 / 27,218 | No new formal OPEN; ten known size-token negatives remain separate.         |
| `leaves97-acceptance.html`    |                                   64 / 60 / 5,704 | Four original header OPENs: 78 raw / 2 threshold pixels.                    |
| `leaves99-acceptance.html`    |                                 110 / 109 / 2,848 | One original pending OPEN: 5,932 raw / 0 threshold pixels.                  |

The 85–88 group includes 36 actual stack pairs and 24 separately identified
existing-API controls; controls add no utility count. Later matching controls
never close an original unexplained raster difference. Theme gates reject
fixed-dark stories falsely labelled by light URL globals. Archive hover-state
and Monaco tokenizer failures have bounded same-source evidence and explicit
corrected cells, with every original preserved. Rejected typography candidates,
selector source without invented After PNGs, inline negatives, Gallery After-only
images and earlier OPENs remain separate evidence.

Field native verification explicitly focuses an input first. Observed
`scrollLeft=804` put the original rest labels outside the viewport; actual focus
restored it to zero without assigning scroll positions or changing product CSS.
Eighteen painted focused pairs agree, six token negatives differ, and original
offscreen/geometry failures remain rejected. Both final native processes recorded
all twenty-four rows then stalled after the last checkpoint without a Chrome
child. Their own Nodes were terminated; original `complete:false` remains and
the last label-click/cleanup is UNKNOWN, not normal closure or final-behavior PASS.

The 90–93 continuation removes eight source utilities through local Spinner
inks, fixed-text menu caption tokens and the Header option. Two actual mobile
file-viewer Buttons use the existing width/height API, preserving edge margins.
Their six migrated runtime utility applications delete no helper literals; making
two existing margin arguments statically visible explains the inventory delta.
The menu retains `font-normal`: a rejected private-weight writer compiled outside
CSS layers and changed a real `font-semibold` control from 600 to 400. No
specificity patch hides that failure. The Integration Spinner stays unchanged:
its local identity snapshot prevents the real pending branch from mounting.

Explicit outside-pointer/hover gates pass the final file-viewer matrix, but the
three original hover differences stay OPEN. An unchanged Before source also
varies between fresh contexts; that does not identify Chromium's exact trigger.
One native project-header pair remains OPEN outside the migrated Spinner;
matching target CSS and bounded same-source raster controls do not close it.
Rejected weight images, token negatives and unsuccessful captures remain distinct.

The complete working-tree regression through93 freezes 1,867 UI sources, 146
Electron sources, five metadata files and 733 test sources. Hashes stay unchanged
while components pass 620 files / 6,208 tests, UI passes 25 / 312, and actual
Electron build/four-page smoke pass. The primary agent views all four app images.
They are After-only; unconfigured local chat does not establish real-agent
send/stop dispatch. Table's 78 unchanged Styleq warnings match through84. Earlier
full runs retain their exact boundaries; the unrelated root ACP prerequisite
still blocks root-check PASS.

The core continuation migrates two fixed safe-area bottom paddings through an
opt-in on the existing Vaul Content owner. Its local `max(1.25rem,
var(--safe-area-bottom, 0px))` expression preserves rem and safe-area inputs;
default directional styles, keyboard positioning, focus and portal ownership stay
unchanged. A minimal actual Add-project story supplies the callbacks missing in
the earlier fixture. An injected `pb-0` utility exposes the changed layer boundary
and remains a negative for these fixed private calls, not a general public-caller
precedence promise.

Rename's fixed Textarea uses existing resize/min-height/padding contracts and a
layout overflow style. Its ref still owns height and switches overflow between
hidden and auto; long-value saving/failure renders with no draft change verify
that the new prop does not reset that writer. Leading and composed shadow/ring
utilities remain. The original 320px dialog clipping is recorded without redesign.
The one 5,932-raw-pixel pending frame remains OPEN despite at most one level of RGB
change per channel and zero threshold pixels. Canonical-launcher controls and
system-Chrome controls retain distinct engine boundaries; they do not prove the
original rendering trigger.

The shared UI-only run through95 additionally passes 25 files / 313 tests, with
111 source/test/manifest hashes unchanged and the same 78 existing Styleq warnings.
This does not extend the through93 Electron boundary. A later components-only
run through 99 passes 620 files/6,209 tests while all 2,539 recorded source, test
and metadata hashes remain unchanged. It includes the existing working-tree
user changes and does not claim another Electron, helper or root-check run.

### Independent review-renderer host

The helper establishes its own StyleX 0.19 compiler configuration across Vite,
Storybook, standalone HTML and Vitest, keeping its existing local CSS variables
and layer order. Findings and reference chips remove 59 source utilities;
private writers and local control compatibility remain. This host imports no
product primitive or palette group. The lock change adds only the helper's two
importer entries and five required peer-context snapshots, retaining all original
resolutions.

Real `file://` verification caught missing compiled styles after a successful
build: extraction ran before Vite emitted CSS, and its fallback wrote an unused
sidecar after single-file inlining. The final configuration keeps pre transforms
and moves the same plugin's output hook immediately before the inliner. The
[standalone build owner](../../../../packages/code-review-helper/standalone-build.md#style-extraction-and-single-file-output)
records the ordering. Eight fixed standalone pairs match PNGs and complete
records. The original broken HTML, twelve images and eight rejected comparisons
remain; identical crops with unequal offscreen records were not accepted.

`leaves96-98-acceptance.html` contains 128 formal pairs: 125 byte-exact and
66,536 equal full standard records. Seven original raster differences, including
four native supplements, remain OPEN at 187 raw/zero threshold pixels; bounded
same-source controls do not establish their cause. The existing helper suite
passes five files/33 tests, and the public-boundary check passes. These results
cover the fixed Vesper theme and audited states, not unvisited helper sections or
the whole monorepo. Core component inventories do not subtract these removals. The independent
through100 helper snapshot checks 32 production JS/TS files against the successful
build hashes, excludes stories/tests, and validates the same v2 AST candidates
with the helper's actual CSS entry. It records a lower bound of 1,151 occurrences
across ten files and 26 unresolved expressions, including 891 occurrences in
ReviewRenderer. This host count is separate from the core product timeline.

The severity continuation moves twenty more tone utilities into one local map,
using the helper's actual warning/danger variables, exact alpha/fallback rules
and fine-hover predicate. Both readers remain private: the finding badge and
light-DOM inline marker. The real fixture renders all five badge tones and the
three valid inline marker severities; no third-party shadow implementation is
substituted. `leaves100-acceptance.html` records eighty formal pairs/44,560 standard
records and six standalone pairs that match. Four original native differences remain OPEN at 130 raw/zero
threshold pixels, despite equal complete recorded fields. A bounded full-panel
control, two normal-motion pairs and two coarse-pointer pairs also match;
none establishes the original raster cause or extends the fixed theme scope.

The group/Alert continuation removes another 76 utilities: 49 in the private
group section and 27 in the local Alert owner. Header refs, ResizeObservers,
sticky offsets and callbacks remain unchanged; the narrow page's original
non-pinning behavior is retained. The index keeps `calc(infinity * 1px)`, the
statistics keep the actual complete monospace stack, and six private writers or
compound rules remain. A mistaken camel-case CSSOM lookup produced an empty
font-family candidate: both builds failed before producing any accepted After
image. The corrected candidate reads the real compiler declaration.

Alert keeps CVA as its variant selector, mapping its existing cases to static
StyleX classes rather than replacing its default/null behavior with a new
normalizer. Six SVG/conditional-grid utilities and three Title writers remain.
Seven alpha declarations preserve the original opaque HSL fallback and matching
color-mix support condition. Chromium's supported-feature screenshots alone missed
that omission; four isolated-fallback comparisons match after the repair, while
four retained candidates differ by 564,770 raw/558,438 threshold pixels. That
CSSOM branch isolation is a diagnostic, not execution on an unsupported browser.
Its local light/dark palette fixtures are distinct from the fixed Vesper host.
Twelve original dark-labelled frames actually used a light palette and are not
accepted as dark coverage.

`leaves101-102-acceptance.html` records 92 formal pairs, 76 byte-exact PNGs and
24,255 equal standard records. Sixteen original formal differences total 75 raw
pixels; five native differences add 22 raw pixels, all with zero threshold pixels.
They remain OPEN. The first 66-frame group matrix separately retains ten unequal
full-record pairs and nine unequal PNGs. One strict, fully prewarmed matrix then
compares all 66 complete records equally; it does not close the earlier evidence.
Native checks cover 1,486 complete recorded nodes. No group-specific standalone
Before/After run occurred; two real standalone After-only images remain explicitly
smoke coverage. The combined report passes real desktop/phone browser QA.

The same independent helper inventory after these two units records 1,075
occurrences/ten files/26 unresolved expressions across 32 production JS/TS files,
all checked against the successful final build. The decrease from 1,151 is 76;
stories, tests, active later work and the core component timeline are excluded.

### Private comments and compatible local controls

The comment/finding continuation migrates 114 private Renderer utilities. The
literal `font-sans` was retained in103: a rejected 115-utility candidate changed its fallback
family list despite 112 matching PNGs. Thirty-five record-different candidate
pairs stay rejected. Later version-matched probes identify the cause in unplugin's
Lightning CSS1.33 postprocessing: default Browserslist includes Android144, which
triggers its system-ui compatibility expansion; Tailwind4.3 uses fixed targets
without Android. The [versioned font implementation](https://raw.githubusercontent.com/parcel-bundler/lightningcss/v1.33.0/src/properties/font.rs)
and independent per-stage/per-target probes agree. A fixed private variable on the
textarea preserves the original literal without a root-font alias, fallback or
compiler-target change. In an ignored copy, two complete builds and fourteen real
positive pairs match; two direct writes to the new private name remain negative.
Batch112 implements that private element-local variable. Twenty-two positive font,
placeholder, legacy-variable and interaction pairs plus two whole-renderer pairs
preserve existing fields and PNGs; the new private declaration is checked separately.
Two direct writes to its new private name remain negative. Generated StyleX layer
names shift by one, but 710 common rules in each host preserve selectors,
declarations, conditions and relative order; no handwritten layer reference binds
those generated names. This neither accepts arbitrary DOM injection nor closes
any original115-candidate difference. `leaves103-105-acceptance.html` contains 156 formal pairs,
153 byte-exact PNGs and 73,555 equal standard records; three formal OPENs total
17 raw/zero threshold pixels and one native OPEN adds 17 raw/one threshold pixel.
Actual navigation, composer resize, keyboard save and eight offline file pairs
are covered. Original caret-tool and readiness failures remain separate.

Two unused internal Card/Badge modules account for another 54 removed occurrences,
with zero migration credit. A resolved AST import/export graph finds no supported
entrypoint or runtime consumer; standalone JavaScript is byte-identical and CSS
only loses 25 selector contexts/1,929 bytes. The cleanup comparison uses the same
older control candidate on both sides and proves that deletion delta only.

The local Dropdown/Tooltip and Button/ToggleGroup owners keep two explicit paths:
ordinary elements use StyleX; legal `asChild` children retain the original utility
cascade. Exported class selectors keep their raw strings and order for 285 inputs.
One module-local CVA declaration supplies both selectors without runtime class
parsing or a public styling-engine option. Source removal is zero; the 35+51=86
normal-runtime mappings are a separate metric. Moving Slot defaults to the earlier
StyleX layer caused real child-precedence regressions; the first repair also
omitted three forwarded flags. Both failed candidates remain, with 55,508 and
31,564 raw differing pixels. The final five forwarded flags preserve original tags,
focus, geometry and cascade, without a specificity patch.

`leaves104-106-acceptance.html` contains 194 current exact PNG pairs and equal
complete records: 98 formal/1,476 standard records, 84 native/Slot pairs, eight
actual Renderer toolbar pairs and four offline pairs. The earlier fourteen positive
pairs belong to historical sources. Actual phone CommitRow Tooltip remains
NOT_ACCEPTED after failed paint gates on both sides; dedicated and desktop success
do not close that callsite. Both new reports pass real 1280/390 browser QA and
retain every historical OPEN. Root independently reopens original PNGs/full records
and views both final reports; root full-check, Electron and core-component coverage
do not advance from these helper-only results.

The tree/commit continuation migrates 182 more private utilities into local styles.
It preserves native checked/indeterminate state, filename clipping, RTL physical
properties, commit details, clipboard write/readback and the local white-variable
contract. Full Storybook and standalone CSS still contain the original white
writer and reader after the last `text-white` literal disappears; no alias or
fallback is added, and the compiler's retention mechanism is not inferred.
The unreachable EmptyThread branch removes another 27 occurrences with zero
migration credit: its private guard is the exact complement of the only caller's
panel-mount condition. Actual empty/save/cancel/delete paths retain behavior.

The frozen 107 matrix has 136 formal pairs, 108 exact PNGs and 66,456 equal records.
Twenty-eight formal OPENs retain 7,795 raw/7,536 informational threshold pixels;
one normal-motion pair adds one raw pixel. Thirty native pairs/2,694 complete
records and ten real offline pairs match. The phone missing-record tooltip remains
offscreen identically and does not establish painted tooltip coverage. Two original
reviewed-state cells are rejected: aria-expanded can change while forceExpanded
keeps the body mounted for two seconds. Their replacements wait for actual body
absence without writing state. A bounded Viewed control records checkbox properties,
seven pseudo predicates, focus, complete CSS and precise geometry; repeated Before
frames match the original After raster. A separate root probe at1024px records every
header descendant and reproduces the original Before PNG on both sources; its
three PNGs match; the Before/After pre objects match, as do their post objects.
Both bounded controls retain
the screenshot tool's null-to-empty style serialization separately. Original frames
lack those flags, so neither
the exact paint cause nor closure of any original OPEN is claimed.

A production-only source snapshot through 107 matches all thirty successful-build
input hashes and validates the same v2 AST candidates against the actual helper
CSS: **698 occurrences/eight used files/18 unresolved expressions**. ReviewRenderer
accounts for 519. The 1,075→698 decrease separates 296 migrations from 81 unused or
unreachable cleanup occurrences; the 86 control runtime mappings remove no source
literals. Stories, tests, later work and the core 1,424 inventory remain separate.

The Separator continuation applies the same ordinary/Slot split to six normal
runtime mappings, with zero source removal. Its existing JavaScript orientation
branch remains authoritative for styling; raw or normalized Radix data attributes
do not replace that branch. Refs, semantic/decorative roles, nested children,
inline/caller precedence and even the old invalid-orientation mismatch are preserved.
Thirty-six paired PNGs/full records match, including four real Sidebar crops over
Storybook and offline files. Four initial local-color frames were rejected: a reused
stability counter accepted the previous color before a tiny real transition ended.
Resetting the counter per state and waiting for finished animations and the target
RGBA fixes the capture protocol, with no product patch. Full-page images are
After-only and mobile Sidebar paint is not claimed.

The diff/context continuation migrates 78 private utilities, preserving the original
logic before rendering byte for byte. Two Button SVG size sentinels, primitive
callers and private font/ring/leading writers remain. The unlayered `.crh-block`
background still wins over `bg-card`; that inactive utility is not hidden behind
an ineffective StyleX declaration or credited as migrated. A minimal real parser
fixture exercises nine context lines, four selected rows, a long line and the
missing-resolved-file Alert. This does not establish parse-error coverage; that
branch's original styles remain.

Its 120 formal pairs have 76 exact PNGs and 39,822 equal standard records. Forty-four
formal OPENs total 207 raw/nine threshold pixels; two native OPENs add 140 raw/126
threshold pixels. All 1,029 complete native records agree. Eight normal-motion
pairs/304 complete records and ten offline pairs/454 records plus 1,850 geometry
records match. Native After and offline finalization did not return; owned Node
processes were stopped after preserving complete checkpoints, and both retain
`closedNormally=false`. Matching frames do not establish successful cleanup.
Root independently verifies all 204 pairs across both units, including full raw
record arrays, original SHA values and decoded pixels, and observes the real
context/composer UI at desktop and phone sizes. Historical OPENs remain untouched.

The private shell/navigation continuation111 removes163 utilities without changing
refs, observers, callbacks or inline column geometry. Its133 formal pairs retain
44,522 equal standard records and118 exact PNGs; native20 and offline20 pairs match.
One normal-motion OPEN plus15 formal OPENs total119 raw/24 informational threshold
pixels. These16 OPENs remain unclosed; the original native finalization is UNKNOWN.
Batch112's font evidence stays a separate positive/negative contract above.

Markdown/diagnostics115 removes27 utilities:22 recognized by v2 plus five in a
fixed default codeClassName parameter that v2 omits. Removing the last space-y
utilities also pruned the original reverse property's registration and fallback.
That candidate remains rejected: all six full records differ and four PNGs differ
by326,910 raw/312,705 threshold pixels. The final stylesheet preserves the exact
original properties-layer registration and compatibility fallback; the unlayered
code-block margin remains its owner, with no ineffective StyleX margin replacement.
The94 current pairs preserve all full records;85 PNGs match and nine OPENs total185
raw/zero threshold pixels. Original candidates and old raster variants remain
separate. Root independently checks original records, hashes and decoded pixels.

The exact successful-build inventory through115 freezes thirty production source
hashes and the actual final helper CSS: **434 occurrences/eight used files/21
unresolved expressions**, including255 in ReviewRenderer. Through112 remains
456/8/18;115 removes22 scanner occurrences and five separately audited defaults.
Three new unresolved entries are private StyleX blockClassName references, not new
Tailwind. Through109 remains historical620/8/18; cleanup/runtime mappings are not
migration credit. At that helper cut, the separate core inventory was
1,424/157/726 through 110; later helper 117/119 and unvisited states are excluded.
Those helper-only checks did not advance full components or Electron coverage;
current integration checks are recorded with the product continuation below.
The root ACP prerequisite failure remains.

### Legacy Sidebar compatibility and correction

The public legacy Sidebar retains its original 303 utility occurrences. An empty
caller-class guard protects neither ancestor selectors nor their layer priority.
A real compiler-accepted zero-specificity ancestor utility loses to the old direct
utility class, but wins after that default moves into the earlier StyleX layer.
This changed Header gap from 8px to 48px, MenuButton width from 239px to 40px, and
GroupLabel height from 32px to 48px. The button's used width is limited by its
retained padding; it is not evidence of a 40px min-width. Slot behavior staying
correct did not establish ordinary-element compatibility.

Correction 127 withdraws all 111 default-runtime mappings from 110/113/114/116/120
and restores the actual Before110 source byte for byte. The earlier three internal
27 migrations remain. Disabled-state 121 and typography 122 candidates are also
rejected with zero credit; the former allowed blocked ARIA mouse callbacks to fire.
No specificity, compiler/layer, event or styling-engine workaround is added.
The original class strings, CVA variants and public caller composition remain
available. Future work must preserve the complete supported caller contract;
retaining compatibility classes is preferable to a misleading normal-only route.

Original→restored127 has 32 exact PNG/full-record pairs: eight ancestor/default
cases with 152 nodes and 24 existing native cases with 600 nodes. The six actual
ancestor counterexamples retain 197,149 raw/195,018 informational threshold pixels;
reverse correction images describe the same six cases, not another issue count.
All old reports stay immutable. Their bounded matching matrices did not establish
public equivalence; their 111 runtime migration credits are withdrawn, and none of
their historical raster OPENs are closed. The task-only Git blob excludes the
user's Tooltip whitespace; its browser source differs only at that exact byte.
The isolated Storybook tree's 25 untouched user-file differences remain explicit.

Permanent browser regression132 adds three actual compiler-generated ancestor
callers to the existing fixture. Six theme/scenario tests compare real Default and
caller PNGs, explicit geometry and twelve click paths. All twelve positive image
comparisons match; the same suite rejects all six historical unsafe cases after
actually checking their CSS rules, taking screenshots and exercising clicks.
The197,133 raw/195,115 threshold full-frame pixels and six unequal crop dimensions
are negative evidence, not extra migrations. It is a narrow regression canary,
not an exhaustive computed-CSS or public compatibility audit. Missing locked
browser startup and installer recovery failures remain separate setup evidence.

### Closed consumer controls and integration evidence

SessionSearchBar118 moves ten fixed Input/Tooltip utilities through existing owner
tokens. Its 30 formal pairs/984 standard records and 26 positive native pairs/690
nodes plus 3,328 geometry records match. All 73 non-target tokens match on nodes
and three pseudos; seven intended target-token changes are explicitly separate.
Six direct DOM token-write negatives remain outside the fixed private call graph.
The original 12-utility candidate is rejected: all 30 formal PNGs matched while
button radii changed 6→10px, or 13→29px under inherited stress. A same-element
message-action theme outranked the radius atom. Two physical rounded-md classes
therefore remain, without a new radius API or specificity patch.

ChatLanding124 migrates two navigation-button dimensions through existing owner
width/height props. This uses real Electron local-chat UI, not a copied action:
12 default target crops match; six variable/inline controls retain two target OPENs
(146 raw/128 threshold). All 18 full captured target/pseudo/ancestor/state records
match. The 18 context views are attached views of those cells, not additional pairs.
A bounded same-After diagnostic reproduces the old Before crops, without proving
or closing the original paint cause. Both builds share their complete input graph
except the consumer; emitted CSS, OSS main and bundled CLI stay byte-identical.
Their fixed environment included the later-rejected 122 source, which the actual
app Sidebar does not consume; it is not accepted integration of that candidate.

Login125 moves two dimensions only in the existing DEV Electron email-button
branch. Independent immutable DEV source snapshots verify the real served DEV flag;
22 target and context views, full captured fields and email/back callbacks match.
Production does not render this branch, so it earns no production UI coverage.
MobileAccount128 moves six ink utilities in three private Workspace action glyph
buttons. Its 48 formal, 16 legacy-variable and four normal-motion pairs match;
51 non-target tokens remain equal. Two intended token carriers and four direct
primitive-token negatives remain separate. These fixed glyph-only consumers do
not authorize the same token override on an arbitrary public primitive.

Personal identity130 migrates the private Authorize button's gap and responsive
self-alignment through the existing gap token and local StyleX. Both background
compatibility classes remain because the owner exposes no equivalent resting/hover
fill contract. Sixty-six positive complete physical/non-target records match across
1,312 nodes and ancestors; 65 target PNGs match, while one crop retains ten raw
pixels. All 66 context views match but cannot close that crop OPEN. Two direct gap
token-write negatives change geometry and remain excluded; unequal-sized target
images are not assigned a fabricated raw pixel count.

Long-user131 replaces two ink utilities on the fixed plain-text Show more/less
control. Its 48 formal, 12 actual-stream and 16 ancestor/element-local legacy
variable pairs are PNG-exact with equal rendered fields and 51 non-target tokens.
Two target carriers intentionally change; four direct token-write negatives remain
outside the private call graph. Four normal-motion frames match, but their collector
did not close normally; they remain diagnostics, not a completed acceptance run.

The helper's accepted117 annotation migration removes 27 utilities while retaining
literal font, numeric registration and private reader/writer semantics. Its 54
positive pairs include 15 raster OPENs (401 raw/zero threshold). Helper129 removes
14 fallback utilities plus one redundant cleanup, using an actual React error and
ErrorBoundary rather than a mock fallback. Fourteen formal and twelve full native
pairs match; four real reload/valid-story recovery pairs retain one OPEN (six raw).
Caught React errors are expected evidence, not zero-console-error acceptance.
Actual host light palette controls are distinguished from browser preference; the
viewer defaults to Vesper. Candidates119/123/126 remain rejected and rolled back:
offscreen checkbox colors and inherited typography/scroll geometry fail complete
contracts even where screenshots or default records match. No compiler, layer,
specificity or production lifecycle patch hides those failures.

Usage-share133 migrates Description line-height and the fixed QR label's ink.
The original utility writes both line-height and `--tw-leading`, not font-size;
both reader and writer semantics are retained through the existing owner token.
Thirty-two positive cells have64 exact target views and32 exact context views,
992 complete CSS records and17,752 dialog geometry records. Only the two intended
local token carriers differ; original `--tw-leading` stays strictly equal. Four
direct-token negatives remain separate. The unavailable Field.Label font-weight
contract keeps its physical `font-normal` class instead of adding an API.

Helper134 moves19 private commit-control outline, focus-ring and transition
utilities while retaining every font/rotation/class selector outside that unit.
Its44 formal pairs have43 exact PNGs and24,438 equal standard records. All40
original native own records match after explicitly accounting for comma whitespace
in two private color/shadow carriers; their raw objects are not called equal.
Eight original whole-page geometry cases still fail, and the subsequent eight
prewarmed screenshots differ because actual Tooltip visibility was not matched.
Both cohorts remain unaccepted. A final bounded eight pairs explicitly close real
Tooltip portals with Escape, retain actual keyboard focus and match PNG, full
records, geometry and state. Those closed-portal controls and eight matching
single-file supplements do not replace the failed cohorts or verify open Tooltips.
Three original raster OPENs total26 raw pixels. No product patch or broad field
normalization hides them. Exact helper inventory through134 is373/8/21 from30
production files checked against the successful293-input build; the19 decrease
from392 is migration, not cleanup. Later136 remains outside this boundary.

Bub135 deliberately keeps its last `p-0` utility. In a real legal zero-specificity
ancestor fixture, removing only that class changes all four padding edges0→12px
and height16→40px. Default screenshots alone had suggested it was redundant.
The link variant fixes inline padding but the block reset belongs to preflight;
no equivalent existing Button padding API covers this contract. Eight diagnostic
cells retain the actual compiler rule and screenshots; they earn zero source or
runtime migration credit. Unequal-sized crops have no invented raw-pixel count.

Helper136 removes13 FileTreeRow native control utilities by reusing the verified
focus/transition roles without changing their definitions or callbacks. Its36
formal pairs have35 exact PNGs and18,864 equal standard records;34 native pairs
have15 exact PNGs with2,556 matching physical/state/geometry records, allowing only
the already explicit comma-space carrier differences. Ten standalone pairs match.
Twenty original target OPENs total197 raw pixels. A separate natural-navigation
pair retains11,423 raw/157 threshold pixels in the desktop sidebar; its original
three captured records did not cover that sidebar. One independent bounded audit
observes156 finite150ms sidebar transitions still running when the old main-only
gate passes. After actual sidebar stabilization,155 complete nodes match in
ordinary/pseudo fields, with only explicit class/token/origin carriers different;
one new raw pixel remains. The original frame lacks those fields, so this does
not prove its cause or close it. No CSS or callback patch was added.

Private muted137 moves two plain summary colors through the shared modern
Dialog/Drawer description token and one Spinner wrapper color through local HSL.
All30 positive target/context views match,434 full records and1,114 geometry
records match with the single intended description-token carrier explicit.
Four direct-token negatives remain separate; their two image views cover the same
changed pixels and are not summed. The sharing state is an existing synthetic
cloud-capability fixture, not evidence of OSS cloud composition. Every public
compiled CSS rule remains equal; the added description writer is locally scoped.

The fixed integration cut at146 passes620 component files/6,209 tests with3,200
recorded inputs unchanged. Its790 scanner source hashes match both that run and
the actual OSS renderer input graph. The three-root lower bound is1,379/156/727;
visual qualification remains separate. New UI owner141 independently passes25
files/313 tests and types with its four owner files hash-locked. Both146 renderer
builds exit zero and keep335 main/CLI/lock artifacts unchanged. The original wide
After gate remains FAIL: besides the consumer, this guide changed between builds.
An independent qualified comparison excludes only that proven unconsumed Markdown
file; all3,834 remaining observed inputs differ only at the consumer, and the
complete emitted CSS is byte-identical. The original full gate is not rewritten.
The earlier132 default4GB heap failure, same-source8GB success and four actual
After-only Electron smoke pages remain separate evidence, not a whole-app baseline.
No check clears the existing root ACP prerequisite failure or old raster OPENs.

The helper's exact through129 inventory has392 occurrences/eight used files/21
unresolved expressions across30 production sources, each checked against its
successful293-input build. Its decrease from407 separates14 migrations from one
redundant cleanup. Stories, tests and later candidates are excluded. The core
inventory below remains independent of browser coverage.

### Independent ink fields and exact compiled conditions

A primitive's label token can also feed its background. The rejected139 secondary
candidate changed real coarse-pointer hover fills: four cases changed9,568 raw /
3,699 threshold pixels. Those six classes were restored. Button141 therefore adds
only the opt-in physical `labelColor` field beside its existing typography fields,
without a token group, variant, background or default change. CSS-wide keywords
reach the actual field; omitted values preserve the original style branch. Existing
Base UI render-element style precedence remains separately verified. This explicit
inline API does not promise arbitrary DOM/class injection keeps its former priority:
140's same-element `.dark` diagnostic hits Konsta's real unlayered rule and fails.
The fixed Account consumers have no such class/style/render port; actual loaded-rule
and caller audits support that bounded scope, not a public cascade guarantee.

All96 default-owner raw objects match;94 PNGs match and two remain OPEN (347 raw /
82 threshold). All152 Account and36 callback pairs match rendered fields and PNGs;
only360 exact inline-color attribute carriers differ. Root independently reopened
all284 original compressed records and decoded their PNGs, preserving both OPENs.
The216 CSS keyword/reference API frames are After-only, not paired screenshots.
The new owner passes25 UI files /313 tests and typecheck; its four owner files are
hash-locked, without claiming a fresh stable-input gate over the entire UI graph.

| Unit                    | Source utilities migrated | Verified boundary and remaining limits                                                                                                                                          |
| ----------------------- | ------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native helper138        |                         9 | Formal48/47 exact; native58/40; file14/12. Two group-hover colors restored after compiled specificity increased; raster OPENs remain.                                           |
| Account139/141          |                      3 +6 | Primary139 retained; secondary141 uses independent ink. Semantic-background failure and139 incomplete normal-motion cleanup remain.                                             |
| PR merge140             |                         2 | All60 positive pairs exact. Static hover background and two ink classes remain; two held-touch states NOT_ACCEPTED.                                                             |
| Helper142               |                         8 | Formal55 exact; complete134-pair set108 exact. Fractional-rem and20px initial-font tests retain exact original media predicate;26 raster OPENs remain. One cleanup is separate. |
| Helper143               |                        13 | Local Button opt-in width/height/ink preserves raw selectors and Slot merge;210 pairs204 exact, six OPENs387 raw/143 threshold. Invalid menu-state captures remain rejected.    |
| Private paste144        |                         1 | Positive24 target/context pairs and580 full records match. Real34px safe-area and vertical-rl corner failures keep padding/radius classes.                                      |
| Fixed Mermaid/Banner145 |                         2 | Source2/runtime5;144 pairs143 exact. One SVG OPEN4 raw/zero threshold. Rejected touch captures and persistence gaps remain unaccepted.                                          |

The helper's new fields stay in its independent owner; product primitives are not
imported. The original raw variant factory and Slot child precedence remain intact.
A media condition written as `<64rem` was compiled to `<=63.99rem`, leaving a real
fractional interval different. The accepted142 source keeps the exact original
`not all and (width >= 64rem)` predicate. Real20px initial-font cases distinguish
React's1024px mount decision from CSS's64rem visibility threshold; default16px
screenshots cannot authorize removing the hidden rule.

Paste144 keeps `calc(var(--spacing) * 0)`, including local initial/inherit cases.
Direct gap-token negatives change computed gap0→19px but have identical PNGs
because there is one content child; that is a valid nonvisual negative. Actual
safe-area emulation exposes padding0→34px and height816→850px without `p-0`;
vertical writing exposes different logical corner mapping without the radius
class. The production legacy sibling portal host has source-graph evidence only;
the fixture verifies its actual body portal, not an unmounted nested Composer.
These bounded checks do not close old Sidebar, pixel, portal, native-input or
cleanup failures.

Navigation146 migrates one fixed Electron navigation-button ink occurrence. All24
positive cells retain ordinary/pseudo fields, geometry, flags and custom values
except576 explicit inherited `--lody-boot-elapsed` values; complete raw objects are
not equal. That variable has real boot-shell animation readers, so it is not
called unused diagnostic data. These target observations do not establish full
page computed-field equality. Twenty-one target and21 context views match; three
target OPENs total45 raw/14 threshold pixels and three context OPENs total5,676 /
261 remain separately counted. Views overlap and are not independent state pairs.
Two same-element-dark DOM negatives remain outside the fixed caller graph, and
all click/Enter/Meta+B paths match. The two original zero-frame collector failures
and the original wide build-gate failure remain in the evidence, without resampling
successful cells or assigning an unproved paint cause.

### Public callers and the remaining cascade boundary

Accepted scoped migrations since147 remove165 source utilities, including the six private
spacing consumers in189. The two opacity candidates in192 remain Tailwind.
Six redundant size/shrink occurrences remain separate cleanup. The nine native
compiler-trial defaults were restored after188 and receive zero credit.
The helper's accepted207 cut contains230/8/21 across30 production sources.
It adds fifteen private ReviewCheck base declarations to196; its actual671-input
build resolves audited immutable dependencies rather than the live Root tree.
The accepted204 full non-story components cut contains1,333 occurrences in145
files and720 unresolved expressions across1,397 sources. Its three core roots
contain1,324/143/716 across791 sources: components895/129/623, legacy UI429/14/93,
and53 route files0/0/0. The other nine occurrences are eight shared conversation
column classes and one keyboard-sheet important bottom override. These are
source lower bounds, not completion rates or whole-branch visual approval.

`inventory-source-through204-accepted-proof.json` freezes those inputs; relative
to203 only three accepted authentication title owners change. The three former
template-class expressions also leave the unresolved count; they were not three
additional utility removals. Helper207 is frozen separately. Together these inputs
give a static lower bound of1,563 occurrences in153 files with741 unresolved expressions; it is not an exact total or completion percentage.
The helper remains a separate frozen207 input; its exact scan and source hashes
are in `inventory-helper-source-through207-proof.json` and
`inventory-helper-v2-after207.json`. Scope185
removes twenty manually audited literals but only seven were in v2 resolution;
its retained `h-svh` hook is also outside that lower bound. The earlier147 dictionary
gap remains separate. The fresh198 `@lody/ui` scan recognizes zero utilities
across84 files while retaining131 unresolved expressions; zero does not prove
all dynamic classes. No fresh whole-test/renderer qualification is inferred from
these inventories. Exact positions and unresolved expressions remain reviewable
in the frozen JSONs and `remaining-source-inventory181.html` (the older181 cut).

Tailwind's automatic scan also consumes source-Markdown examples. Final191 adds
three arbitrary-property rules from the migration guide; none matches the two
observed final DOMs. These are emitted rules rather than additional measured
product class occurrences, so source inventory never substitutes for a full CSS
comparison. The older measurements of unchanged CSS retain their exact input scope.

The earlier 147 cut removed seven utilities while the scanner fell by three:
four original `CI_ICON_TONE[state]` strings were outside v2 resolution. That known
gap does not change the counting method or create extra migration credit.

The root160 stable suite passes 620 files/6,209 tests with all 3,208 recorded inputs
unchanged; all 790 frozen core147 hashes match that test boundary
(`root160-core147-stable-test-qualification.json`). This qualifies those tests,
not a new whole-render or Electron capture, the later 161 source, or the isolated
159 prototype. Owning suites and immutable captures retain their separate scope.

| Unit                          | Real rendered result                                                                                                                                                                                 | Limits retained                                                                                                                                                                                                                                                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Goal and CI147                | All162 pairs byte-exact;10,034 standard plus2,864 complete target records,24 callbacks match                                                                                                         | Only1,008 precise class/style carriers differ; the legacy bar's container lookup missed its portal, so container CSS is not claimed. Original shallow-class test failure retained;21 owning tests pass after deleting only that assertion. One new broad-type lint warning is explicit.                                             |
| Shadow and outline148         | Formal30 exact;86 complete pairs78 exact                                                                                                                                                             | Eight forced-color OPENs356raw/52threshold; exact named shadow comma-space differences remain. Fourteen registrations/fallbacks and a real no-probe production build verified.                                                                                                                                                      |
| Chevron151                    | Native96 and file16 pairs;103/112 PNGs exact,448 full captured records match                                                                                                                         | Nine OPENs874raw/2threshold. Fifty-six actual transition events/timing structures match; screenshots prove settled endpoints, not every animation frame. No shared formal-runner pairs invented.                                                                                                                                    |
| File glyphs and shrink152     | 117/126 PNGs exact;2,808 full captured records/geometry match;three real SVG assets have matching bytes and decoded sizes                                                                            | Nine OPENs69raw/15threshold. Original22 partial frames, pointer failures and incomplete termination remain. Zero-size glyphs are not called painted; keyboard recovery replaces impossible pointer hit testing only.                                                                                                                |
| Cancel153                     | Actual Cancel56 pairs50 exact;all90 positive/reference pairs77 exact with656 matching physical records                                                                                               | Thirteen OPENs58raw/zero threshold; exact new inline/private-variable carriers retained. Six private-variable negatives separate. Translate candidate restored after two actual utility-writer probes changed1.98→4px,60,471raw/52,490threshold.                                                                                    |
| Delete margin155              | 115/128 PNGs exact;2,514 full captured records/geometry and real clipboard/delete outcomes match                                                                                                     | Thirteen OPENs44raw/15threshold. Six supplemental states establish actual keyboard focus-visible. Sixteen original Copied/rest images remain before-only; authoritative idle-ready replacements are separate and do not close older OPENs.                                                                                          |
| DiffStyleControl158           | 103/112 PNGs exact;1,120 full captured records/geometry match;actual radio Arrow/Space/pointer and visible modified-file single HTML verified                                                        | Nine OPENs511raw/267threshold remain. Original24 unpaired PNGs, seven error records with only six completed error images, two zero-image discovery failures and one corrected null-root gate remain. Root height migrates once; two sm-item heights are cleanup credit0. Full CSS,63 registrations/fallbacks remain byte-identical. |
| Parse-error fallback160       | 29/32 PNGs exact; all 228 captured records/geometry match. Real inner parser failure, collapse/reopen and standalone output verified.                                                                | Three OPENs total four raw/two threshold pixels. One padding migration and one redundant SVG-size cleanup. Two original Before build logs were overwritten; retained exit/input/HTTP/driver evidence remains, and original log preservation is not claimed.                                                                         |
| Session-limit notice161       | All 96 PNGs exact; 476 full captured records and four keyboard/pointer/touch callback sequences match.                                                                                               | The 188 exact class carriers are separate; no whole raw-object equality. Baseline follows mechanical extraction of the actual presentational owner, not a mounted stateful quota or Electron branch. Original empty-label zero-sized button and collection/QA failures remain.                                                      |
| Transparent Checkbox input162 | All 63 collected paired PNGs match, but only 61 complete objects match; three painted-target diagnostic pairs also match.                                                                            | Five candidate utilities restored, zero credit. Two offscreen geometry/derived-color differences, native-After and unchanged-source file-Before strict failures, and nine missing states per direction remain. This does not establish that the five styles caused those failures.                                                  |
| Edited-files expansion163     | 38/48 PNGs and complete records match; ten real public-root caller color reversals preserve geometry.                                                                                                | Two utilities restored, zero credit; 3,990 raw/3,512 threshold counterexample pixels. Immediate coarse-tap visual limits remain separate from these healthy paired regressions.                                                                                                                                                     |
| Private typography165         | 28/38 PNGs exact; all 806 target records match. Five explicit first-navigation pairs add 775 matching sidebar records apart from five exact asset-URL port carriers with identical HTTP image bytes. | Ten OPENs total 28,779 raw/27,837 threshold pixels. Original33 pairs did not capture complete sidebar state. The supplement adds a different explicit interaction, not replacement images; cleanup and missing explicit scroll-offset ledger remain limited.                                                                        |
| Monaco native wrapper166      | Fourteen candidate pairs provide 56 strict native records; eight actual public-caller layout reversals, including two with identical PNGs.                                                           | All four utilities restored, zero credit. Actual mobile minHeight0 controls do not prove positive caller precedence; eight full-Monaco pre/post geometry OPENs remain outside the strict native proof.                                                                                                                              |

| Private weights169/172 and type174 | 112 full pairs/90 PNGs exact; all captured target, real Chrome font, sidebar and portal fields match apart from precise logo port carriers whose HTTP resource bytes match. | Twenty-two OPENs total 838 raw/465 threshold. The 174 group-heading records are unmigrated controls. Portal focus recovery and unknown cleanup limits remain; normal and file captures are separate. |
| Tabular numbers178 | Six source utilities; 27 full pairs/16 PNGs exact and 1,512 target/font records match. Actual painted PR default and feature-combination endpoints are included. | Eleven full-record OPENs total 775 raw/486 threshold. Four separate Copied feedback pairs match only their limited feedback fields and add 57 raw/zero threshold pixels. Original offscreen/scroll-mismatched PR supplements are rejected, not replaced evidence. |
| Actual chat route170 | Twelve actual Electron PNGs and all captured geometry match; editable synthetic prompt preserved at 1280/820/390 in both themes. | Two cells retain 32 boot runtime field differences across pre/post, including a real animation reader. Narrow Electron remains compact desktop, not the mobile/null branch. |
| Offline workspace route173 | Four utilities; 28 PNGs and captured fields exact; four actual online/offline/Refresh/recovery flows. A fresh-route fixture recovery reproduces all 28 original After captures exactly. | Pure in-memory synthetic platform ports, not live backend/IPC. The corrected fixture uses the original component in a fresh route and does not mutate the exported route singleton. Generated route-tree ordering drift is unchanged by either style source and is excluded. |
| Mobile integrations175 and solo share title181 | One utility each; 36 and 32 PNGs exact, with 3,788 and 4,356 captured scene records. Disabled/auth/role/search/Switch flows and native font-token boundaries are covered. | Mobile role-provider defaults retain 12 control pairs. Share origin differences are 128 exact URL carriers across pre/post; paths, link behavior and actual logo bytes match. The story's existing inconsistent effect return is mechanically made explicit `undefined`; original capture hashes remain retained. |
| Fabric canvas179 | Default PNGs and GPU pixels match, but a legal zero-specificity ancestor changes computed pointer-events and trusted hit target from DIV to CANVAS. | Both candidate utilities restored, zero credit. Default-only report is superseded by the public-caller counterexample; matching pixels cannot accept changed interaction. |
| Content pane182 | Five owned layout utilities;18 real Electron PNGs/3,242 scene records match, including theme settings, compact overlay/inert/Escape and focus return. | One light767 state retains12 non-content hover differences. Boot612 fields,432 generated IDs/refs and16 blob URLs are explicit carriers;32 ID values are bijective,108 references resolve to the same nodes or same absence, and actual trace image bytes match. Original OOM/evaluate/restore failures remain. |
| Private line-height183 and numeric186 | Nine source utilities;39/39 and20/23 PNGs exact,495 and339 target/font records match. Lengths inherited by table cells, original48rem reader, actual navigation/reviewed/copy states are preserved. | Three186 OPENs total111raw/72threshold; all recorded fields match apart from exact asset ports.183's two file-run cleanup outcomes remain unknown. Production CSS and registrations stay intact without a retention patch. |
| Shared layout helper185 | Twenty source literals;46 formal pairs/41 PNGs exact and5,118 scene records match. Safe-area/keyboard variables and actual250ms transition endpoints are covered;`h-svh` is retained for old-browser/devbar hooks. | Five formal OPENs709raw/zero recorded threshold;4 diagnostic OPENs585raw and8 reused same-source controls (4 vary,832raw) do not establish a paint cause. Three cleanup outcomes remain unknown. All formal captures used the frozen native trial; independent non-empty ordered legacy CSS qualification covers3,950 ordinary/2,866 unlayered/8,596 non-native rules,108 registrations and18 layer declarations, not a new legacy visual replay. The original empty-group projection was invalid and its bytes were overwritten; the independently frozen replacement is authoritative. The first after-only test environment retains16 readiness and16 geometry failures: its searched helper rules were absent and roots were content-box. The unchanged97-line test subsequently passes all16 cases in audited healthy190, with loaded preflight, matching helper/fixture hashes and the original geometry, natural250ms transition, focus and draft expectations. The persistent browser suite is restored; the old32 failures and original46 visual comparisons remain separate. Evidence: `leaves185-persistent-browser-blocked-proof.json` and `leaves185-healthy190-after-only-verification.json`. |
| Native time-input constraint190 | One private native-picker hiding rule;18 full Input and indicator regions are pixel-exact,78 real UA shadow nodes match, and keyboard/controlled-value results remain equal. | Whole view15/18 PNGs exact;three light390 OPENs2094/2112/2094raw have maximum channel delta1 and remain unproved. The constraint does not replace the Input well/font or add a primitive API;no leading/same-pseudo competition exists in this closed call graph. |
| Private helper spacing189 | Six consumer utilities use five optional CSS-typed properties. Final six shorthand/longhand-order screenshot pairs and342 records match. The56 original healthy states have a final-source real-browser bridge over1,360 records; three Copied records also match. | The original56 images are55 exact and Copy3 are2 exact; two OPENs total68raw/43threshold remain. The bridge is field qualification, not new PNGs, and only18 exact logo-port carriers differ. The naive merge's four actual failures3922raw/3436threshold remain. Caller/Slot order is preserved by omitting overwritten API-owned fields; old dimension/ink-only and ToggleRoot Provider behavior stay unchanged. Two original cleanup outcomes remain unknown; all four final bridge runs close normally. |
| Private warning interaction191 | One Popup pointer-events constraint;16 pairs,148 target records and1,204 form-geometry records match apart from12 exact class carriers. Original Positioner hit interception, blur and narrow-story clipping remain. | Twelve PNGs exact;four caret-location OPENs total72raw/72threshold remain without a timing-cause claim. The paired After includes192 isolated candidates; a separate final191-only build matches Root inputs. Its documentation scan adds three unused arbitrary-property utility rules; existing ordered rules/registrations remain equal. Final observation is supplemental After-only evidence, not new paired PNGs. |
| Actual pending child193 | Two size utilities use the existing Spinner diameter API. All11 actual Electron PNG/RGBA pairs match, with77 target,176 ancestor and3,443 geometry records; Back restores the main conversation in all22 captures. | Raw objects differ:957 exact boot-clock/generated-ID fields and44 binding/dimension carriers remain explicit. The real900ms rotation is sampled at a fixed400ms phase; this does not prove every natural animation frame. Eight other unreachable or unheld pending-state dimensions stay Tailwind. |
| Login handoff link194 | Two size utilities use existing Button width/height props. All32 expanded-link regions and pixels outside the live canvas match;4 separate native reduced-motion whole PNG/RGBA pairs are exact. Tab, Enter, pointer activation and the actual handoff href match. | All32 normal-motion whole-image OPENs remain, totaling191,628 raw/threshold pixels inside the WebGL canvas; no exact paint cause is claimed. The same-origin sandbox fixture blocks external-protocol launch and records manual activation. It proves the actual post-transfer UI, not OS handoff. Two precise legal-link origins, frame environment and binding carriers remain separate raw differences. |
| Usage Skeleton195 | Three consumer utilities move to optional inline display and bar/tile shapes. All44 real-browser PNG/RGBA pairs and14,732 full node records match; six new Gallery views are After-only. Old shapes, optional sizing, local spacing and mini-radius11 remain verified. | Bar keeps the line default height and mini bottom corners, with3px top corners; tile owns20% corners without height/aspect ratio. The caller retains square geometry. One wrong-dependency After44-frame group is rejected and retained; final workspace resolutions identify the actual new UI source. Four normal pulse pairs use400ms phase sampling, not natural timeline synchronization. |
| Private review Checkbox196 | Seven utilities move to local input/glyph styles, preserving exact zero-spacing expressions and native state/events. Original20 default-dark pairs have18 exact PNGs; two CSS-wide and two genuinely5px pairs are exact. Real pointer/Tab/Space, directory indeterminate and reload reset remain unchanged. | Two original single-pixel OPENs and17 raw difference entries, including a mismatched whole-node list, remain. Same-source native scrolling proves a112px placeholder becomes a534px diff host, accounting for422px; historical observer timing is unproved. The one loaded-scroll pair has equal pixels,45 target records and560 geometry records. Old phoneSpacing5 identifiers were actually default Vesperdark; a correction sidecar and true5px supplement preserve this distinction. Light is untested because the existing provider is fixed-dark. |
| Join-request Textarea197 | One private minimum-height utility uses the existing element-local field Token, with the exact spacing expression. All44 PNG/RGBA pairs and644 node records match in physical CSS, other variables, state and geometry; actual controlled typing,1000-character limit and submitting disability match. | Full raw objects differ by44 classes,132 target Token carriers and36 exact avatar URL port changes; both URLs serve identical independently fetched PNG bytes. The original strict failure is retained. Root/local spacing, zero, initial/inherit/unset and ancestor Token overrides are covered at stated alternating widths, not a complete Cartesian matrix. |
| Field label weight198 | A field-group labelWeight Token defaults to500 and is read by Field.Label. Three fixed Login labels retain their local medium variable and private writer. All21 Login/QR formal whole PNGs match, including380, initial400 and inherit/unset500; the existing QR font-normal remains400. Root integration passes25 UI files/313 tests and both package types. | Two default Gallery pairs keep the original control ROI; two new measured500/620 rows intentionally add172px. These are separate from product equivalence. The two same-element font-semibold negatives keep physical600 but change private600→500; one dark caret image retains18 pixels OPEN. Immediate-read reduced-motion transition evidence is preserved; settled and actual normal0s behavior match, without a natural-all-frames claim. |
| Mobile/QR label weights200 | Four fixed labels reuse the canonical field Token and exact medium/normal writers. All48 strict pre/post states retain198 target records,11,798 dialog geometry records, actual fonts, Range and legacy writer values;45 whole PNGs are exact. | Three Share820 OPENs total30 raw/zero threshold pixels outside recorded target boxes, with unknown paint cause. Only66 class and102 Token carrier changes are excluded explicitly. The actual states use default4px spacing; no5px coverage is claimed or required for these weight-only calls. |
| Workspace ground201 | One private background utility moves into a finite page/sidebar option on the existing helper. Its default page/settings output stays byte-identical; the actual non-settings root chooses the sidebar atom exclusively. Twelve real Electron states keep the same backgrounds and layout across74 root observations and3,406 geometry records;11 PNG/RGBA pairs match. | One original Logo OPEN retains239raw/zero threshold pixels; cause is unknown. Startup viewport640/1280, real boot flag/elapsed readers, twelve CSS URLs and ten exact ID/ARIA paths are kept separate; startup-history equality is not claimed. Renderer1222 and335 guards are restored after owned App exit. Original8598 rules/802 at-rules retain order with one added background atom and no root-class hook. |
| Login margin/glyph202–203 | One private submit margin and one fixed descendant-size occurrence move to local StyleX. Twelve submit-state pairs and ten SVG pairs are PNG/RGBA exact; six fixed glyph calls retain18px boxes, original display/shrink and Lucide presentation attributes. Production and natural DEV cover the sixth Mail, with provider click/disabled and email focus/Back behavior verified. The integrated203 working tree passes619 component files/6,199 tests; its pre-existing user edits remain part of those test inputs, not a pristine renderer qualification. | Submit records contain24 exact class and72 rule-routing changes; glyph records contain84 class, two fixed DEV debug-source attributes,42 matched-rule projections and24 CSS URL carriers, with no other raw differences. The original misreached Unverified pair and collector failures remain rejected; Resend lacks its fixture error code and is not covered. The glyph build only removes the old important descendant rule and reuses existing atoms. |
| Card title typography204 | Two optional physical owner props retain the default600/live semantic tracking reader; three authentication titles remove five utilities while preserving their legacy variable writers. Fifteen real-browser consumer cases reject the alias/fallback design in five cases and support the physical declaration. All51 actual/variable page viewports and four original Gallery Card ROIs are PNG/RGBA exact;471 records and1,468 geometry records differ only at102 exact title class/inline carriers. | Four new Gallery rows are After-only. Both collectors exit1 on the same48 pre-existing styleq logs plus four broken-avatar console errors/four aborted requests in Gallery; page cells have none. Normal final cleanup succeeds; the first rejected selector run retains its unknown cleanup boundary. No token group, global CSS retention rule or fallback patch is added. |
| Private review label207 | Fifteen native label base utilities become local StyleX with the same variables and medium-weight writer. All16 original PNG/RGBA pairs and112 target records match outside exact class/CSS URL carriers. A separate real wheel/scrollend/return sequence in the two affected profiles matches all six paired stages, geometry, extents, hits and original PNGs. Source inverse and737 retained CSS rules/182 at-rule nodes match exactly. Actual inline-only standalone files add eight native-state pairs; desktop four are PNG/RGBA exact, and two extra real navigation scenes retain matching final nav/scroll fields and PNGs. | Phone standalone four retain34 raw/zero-threshold pixels and their original reader lacks nav attributes; new fresh lazy/observer histories and equal horizontal-pan boundaries remain recorded. Two original initial states retain348 document-extent/later-position differences of446.5px; all original8,562 geometry records remain available. The offscreen600/153.5 states match the existing content-visibility intrinsic-size mechanism, but old cache/fixture history was not recorded and its cause remains unproved. Adopted private declarations do not establish all initial whole-page states equivalent; no14-state code subset or lazy/content-visibility fix is claimed. Actual theme is fixed Vesper dark. |
| Spinner opacity192 and queued pulse | Both opacity candidates are rejected: four direct controls match, but four actual zero-specificity ancestor cases change0.7→1,721raw pixels. Root sources stay unchanged. | Tailwind's named default wins by specificity inside utilities; ordinary StyleX is earlier than the caller utility layer. A naive move cannot preserve that contract. The separate full animation-variable shorthand probe emits no CSS under the locked compiler mode; default keyframes cannot replace the element-local variable contract. No compiler mode, primitive API or specificity patch is adopted. |
| Native compiler trial188 | Three real arbitrary-property callers change strip598→16px, viewport598→840px, and clipping/hit testing despite passing default/named controls. | All13 trial paths restored,6 new files removed and3 temporary dependency links removed;cache packages retained. Nine defaults remain Tailwind. Earlier66-pair successes and actual-App312raw OPEN remain evidence, not acceptance. |

The notice's original 18 style fields, native DOM and parent callback were moved
without changing quota, translation, telemetry or settings ownership. Its parent
has a final comment-only cleanup; runtime token AST matches the build input,
not its byte hash. The eight amber replacements preserve element-local palette
variables, the exact self/ancestor dark predicate with light-scope exclusion,
fine-pointer hover and the compiler's color-mix feature query and fallback.
A plain `when.ancestor` introduces a marker requirement and is not equivalent.
The new owner makes real presentation states testable without duplicating their
UI or introducing a second quota policy.

The typography unit preserves both private writes and the original physical
readers: tracking reads its theme variable or literal directly, and leading-tight
reads `--leading-tight`, not `--tw-leading`. Complete production builds retain
`--tracking-wide` through actual StyleX CSS references even without the diagnostic
story utility; a separate no-reference control prunes that default. No static
retention patch or CSS-file change was needed. The exact source and lower bound
are in `inventory-helper-source-through165-proof.json` and
`inventory-helper-v2-after165.json`. The original unmatched sidebar states and
pixel OPENs remain in their reports, not hidden by target-field equality. Font-weight likewise reads its element-local theme token
directly while preserving the private writer. Tabular numbers are different:
the physical declaration reads all five numeric variables with the compiler's
empty fallbacks. Full Storybook and standalone output retain the same numeric
atoms and all registrations/defaults; no new static retention or generic style
escape API is introduced.

Public composition supplies real blockers, beyond default-state screenshots.
Assistant actions149 retain all six classes: four supported custom-icon token
readers change6→9px or10→18px when spacing tokens are published, and eight
supported Stream unlayered caller cases change ink under physical inline color.
Eight low-specificity controls match. These twenty are explicit DOM-only proposed
field calibrations, not a product After or migration; the coarse-hover gate failure
and four uncollected phone states remain. The product View stays byte-identical.

Adaptive150 retains nine layouts:18 controls match, while18 ancestor and two opaque
caller cases fail. Six ancestor PNGs are identical despite changed overflow or
container type, so they are still rejected. Progress154 retains height/flex after
four real public Sidebar caller failures: height4→48px, track4→6px, or track width
218.125→0 and fill82.875→0. Thirty-eight matching/default/motion pairs cannot
accept those four. Outline157 retains padding: an actual named popup host carries
a public zero-specificity ancestor that changes12→48px, or18→72px under local
spacing. One separate twelve-pixel context OPEN remains unexplained; the popup
itself matches in that control. The320px Rail is genuinely suppressed, not a popup
whose locator merely missed. All candidates were restored and receive zero credit.

The isolated156 extraction experiment supports a
[proposed, bounded route](../../proposed/architecture/2026-10-31-stylex-cascade-compatibility.md).
A distinct namespace/prefix in flat utilities before Tailwind preserves thirteen
native Adaptive cases, but not general Slot source order. Late injection breaks
other Slot/query/caller cases; reused atoms change ordinary StyleX overflow even
when pixels match. Native sublayers and two unplugin instances are not substitutes.
No product compiler, dependency, lockfile or global layer order was changed, and
no universal compatibility route was adopted. Continue owned migrations while
keeping these specific caller contracts explicit.

## Remaining work

The compiler-backed [inventory](../../../../packages/components/scripts/tailwind-usage.mjs)
validates AST-discovered candidates with the locked Tailwind compiler. Counts
are source-occurrence lower bounds, not runtime coverage, emitted CSS size or a
completion percentage. Unresolved expressions remain a separate work list.

| Source boundary                                                 | Scanner method | Occurrences | Files | Unresolved |
| --------------------------------------------------------------- | -------------- | ----------: | ----: | ---------: |
| Frozen 29–30                                                    | v1             |       1,736 |   175 |        721 |
| Frozen 31–33                                                    | v1             |       1,715 |   175 |        717 |
| Same pre31 source snapshot                                      | v2             |       1,741 |   176 |        725 |
| Frozen source through 35                                        | v2             |       1,705 |   175 |        721 |
| Frozen source through 40                                        | v2             |       1,676 |   175 |        721 |
| Frozen source through 43                                        | v2             |       1,664 |   173 |        721 |
| Frozen source through 45                                        | v2             |       1,656 |   171 |        721 |
| Frozen source through 47                                        | v2             |       1,646 |   169 |        721 |
| Exact source through 49                                         | v2             |       1,637 |   169 |        721 |
| Exact source through 54, visual limits recorded separately      | v2             |       1,620 |   168 |        721 |
| Exact source through 59, excluding later candidates             | v2             |       1,602 |   168 |        722 |
| Exact source through 63, with partial visual acceptance         | v2             |       1,594 |   167 |        722 |
| Exact source through 67, with partial visual acceptance         | v2             |       1,572 |   166 |        718 |
| Exact source through 71, with partial visual acceptance         | v2             |       1,554 |   165 |        718 |
| Exact source through 73, with partial visual acceptance         | v2             |       1,542 |   165 |        718 |
| Exact source through 78, with partial visual acceptance         | v2             |       1,507 |   163 |        718 |
| Exact source through 81, with partial visual acceptance         | v2             |       1,489 |   163 |        724 |
| Exact source through 84, with partial visual acceptance         | v2             |       1,474 |   163 |        726 |
| Exact source through 88, with partial visual acceptance         | v2             |       1,451 |   159 |        726 |
| Exact source through 93, with partial visual acceptance         | v2             |       1,445 |   157 |        725 |
| Exact source through 95, with partial visual acceptance         | v2             |       1,430 |   157 |        725 |
| Exact source through 99, with partial visual acceptance         | v2             |       1,424 |   157 |        725 |
| Exact product source through 120, including final Search118     | v2             |       1,414 |   157 |        726 |
| Qualified product source through 128, excluding later131/130    | v2             |       1,404 |   157 |        725 |
| Exact fixed core at132, includes130/131 and excludes133/134     | v2             |       1,399 |   157 |        726 |
| Observed source-only through145; not full-regression qualified  | v2             |       1,380 |   156 |        727 |
| Qualified core146; stable full-suite and actual renderer source | v2             |       1,379 |   156 |        727 |

The through145 source-only snapshot rechecks all790 canonical paths twice before
scanning: components946/140/634, legacy UI429/14/93, routes5/2/0. It is a new
source inventory, not a replacement for the fixed132 full-suite/renderer boundary.
Its19-occurrence decrease matches the accepted later core removals; it does not
close any partial visual scope. Helper143 separately records329/8/21 from30 files.
The same source-only cut also snapshots all1,396 product src files except stories:
1,389 occurrences/158 used files/731 unresolved; all790 overlapping hashes agree.
Its nine outside-root occurrences and four unresolved expressions remain separate
from the three-root count, with no new scanner-method credit.

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

The published through 99 v2 split is components: 990 occurrences/141 files/632
unresolved, legacy UI: 429/14/93 and routes: 5/2/0, from 790 recorded source files.
Shared UI source and export metadata are frozen outside that three-root count.
Known StyleX templates remain unresolved expressions, not newly introduced
Tailwind strings. Through88 remains a separate immutable inventory; eight source
removals plus two newly visible retained margins produce the net decrease of six.
The 94–95 group removes fifteen further source occurrences; 97 and 99 remove
six more. The frozen broader through95 count remains historical. Later batches and
other package hosts are excluded.

The full product `src` audit through95, excluding stories, uses the same v2
scanner and records 1,439 occurrences/159 files/729 unresolved across 1,396 frozen
JS/TS files. The through88 full-scope inventory remains unchanged at 1,460/161/730. The
nine occurrences beyond the three roots belong to `conversation-layout.ts` and
`use-keyboard-aware-scroll-into-view.ts`; four additional unresolved expressions
are recorded separately. The separate through88 manual compiler audit identifies sixteen latent
skip-link factory literals, three shared touch-helper literals and six call-site
margin arguments omitted by v2. Two of those margin arguments become visible in
the 92 consumer migration; four remain opaque. The skip-link factory has no in-repository caller;
installing a new link would not prove a migrated existing UI. These known parser
gaps remain separate from published lower bounds, with zero migration credit for
the audit; historical inventories are not rewritten. Existing touch callers need
the actual Button sizing API and their own visual evidence, not an opaque caller
class that competes with the primitive.
The through 67 transition below explains its
unresolved changes.
Five Usage templates and one Archive class lookup disappear; two FileError/Bub
StyleX templates remain unresolved, not new unknown Tailwind utilities. A separate helper audit identifies another nine
occurrences across two lib/hooks files, outside these three roots; it is neither
folded into the same-boundary through59 total nor called a new product regression.
Expand the inventory scope explicitly before comparing that additional work. Batch34–39 visual differences and rejected
calibrations retain their own status; this source inventory does not accept them.

All inventory totals above concern `packages/components/src`, not the entire
monorepo. The Electron renderer imports that package's Tailwind sheet; its
development-panel CSS hooks are not utility-removal credit. The standalone
`packages/code-review-helper` renderer and `site-docs` have separate Tailwind
pipelines and remain outside these inventories. The helper's findings/reference
batch has its own compiler and standalone evidence above; other helper sections
and site-docs still need independent baselines. Component screenshots do not
implicitly accept either host. Isolated ACP demo/editor apps are excluded
from this migration; no submodule operation is needed.

WebWorkspaceLayout now owns its background through the shared helper’s finite
surface choice; Sidebar control compatibility remains. Actual Electron content/layout and the healthy layout browser test
have bounded evidence above; they do not validate every retained rule.
The helper gutter Button’s size utility also remains: the existing real hover,
line-comment and Split paths did not render that Button in the tested Before.
`leaves199-baseline-blocked-proof.json` records the actual empty gutter slots and
source callback in `ReviewRenderer.tsx` (`renderGutterUtility`); establish a real
reachable state before changing its dimensions, without altering behavior for
migration credit.

The unconsumed `src/ui/sidebar.tsx` retains 303 occurrences and is not re-exported
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
