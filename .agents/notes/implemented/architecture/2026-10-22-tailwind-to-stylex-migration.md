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

| Surface | Utilities before → after | Retained contract |
| --- | --- | --- |
| Schedule property rows and field marks | 37 → 10 | Two unknown-child width selectors plus eight existing card/ghost compatibility utilities. |
| Bub installation guide | 29 → 8 | Button appearance and sizing overrides. |
| Information chips and CI popovers | 33 → 8 | Primitive maximum width, padding and shadow overrides; width and border color are independently migrated. |

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
the 692 unresolved expressions are unchanged. These are lower bounds, not a
project completion percentage.

The unconsumed `src/ui/sidebar.tsx` retains 324 occurrences and is not re-exported
by `src/ui/index.ts`; direct public wildcard imports remain possible.
The unconsumed `src/components/task-list.tsx` retains 87 occurrences,
`src/components/sidebar-updated-task-list.tsx` retains 95 and the unused
`PropertyRowWide` export now has actual rendering fixtures and retains only its
two arbitrary-child selectors. Establish actual consumers and rendering fixtures
before migrating the other unconsumed surfaces. The original phone terminal error span has zero width and invisible inline
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
