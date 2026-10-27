# Style migration visual acceptance

Capture production components in a real Chromium browser, compare their pixels
and computed geometry, and generate a self-contained HTML report. Screenshot
evidence is separate from behavior tests and from the real Electron smoke run.

| Entry                   | Responsibility                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| `visual-regression.mjs` | Capture, assemble and compare immutable screenshot phases.                                                    |
| `serve.mjs`             | Serve a fixed Storybook build or report directory on loopback; missing files return 404 when no index exists. |
| `*-targets.json`        | Story, viewport, theme and interaction-state coverage.                                                        |
| `electron-smoke.mts`    | Launch the actual built OSS desktop through the existing isolated E2E harness.                                |

## Capture a component batch

From `packages/components`, before editing the selected components:

```sh
pnpm exec storybook build --output-dir /tmp/lody-stylex-before
node tests/visual/serve.mjs --root /tmp/lody-stylex-before --port 6017
```

In another terminal, capture a target profile:

```sh
node tests/visual/visual-regression.mjs capture --phase batch-before \
  --storybook http://127.0.0.1:6017 --targets tests/visual/continuation-targets.json
```

After implementation, build to a different directory, serve it on a different
port and capture the same targets as `batch-after`. Never replace the directory
being used by a running capture. Dev-server HMR can mix source versions or empty
an already-rendered story; use an immutable static build for acceptance.

```sh
node tests/visual/visual-regression.mjs report \
  --before batch-before --after batch-after --name acceptance
```

Open `artifacts/visual/acceptance.html`. PNGs are embedded as data URLs, so the
report remains viewable without the Storybook server or sibling image files.
The adjacent JSON preserves the raw comparison results. For very large
assemblies, derived report manifests may retain only the exact fields read by
`diffLayout` to avoid duplicate nested styles exceeding V8 JSON limits. Verify
every copied value and original PNG hash; keep complete native snapshots and
full-field proofs unchanged and report their additional differences separately. Each frame shows its
story ID, viewport, theme, state and source phases, so search can locate a
specific story rather than only its group. Capture failures,
missing frames and changed computed styles are not silently treated as passes;
`report` returns nonzero for them. Color-expression serialization, transparent
shadow layers and saturated circular radii can produce raw computed differences
even with byte-identical PNGs. Review and document that evidence explicitly;
never erase measured differences merely to make the report green.

Large reports can exhaust a browser session when many high-DPI screenshots stay
decoded after scrolling and expanding. After generating a report, run:

```sh
node tests/visual/preview-report.mjs --report artifacts/visual/alpha-acceptance.html
```

The optional postprocessor generates bounded canvas previews from the real PNGs,
embeds every unchanged original once by SHA and loads the original in the existing
zoom viewer. It writes a backup plus a provenance manifest. Verify preview and
original decoding separately, then exercise keyboard/click zoom, Escape, repeated
scroll/expand/resize and memory recovery in a real browser. A thumbnail is not an
original screenshot, and a derived diff mask is labelled separately.

Each capture waits for Storybook completion, visible content, fonts, visible
image loading/decoding, finite animations and stable geometry throughout the body,
including portal positioners that resize after their trigger has settled. `allowBlankIds`
permits deliberately blank or textless skeleton roots and portal-only stories;
skeleton profiles require a visible painted placeholder, and portal-only profiles
require a visible actual portalled control through `ready`. It never exempts that
required content. Failed image loads or missing content
fail the capture. Portalled content is part of the layout snapshot. A fixed
Date value stabilizes relative-time labels without stopping the browser's timers.
Every story gets a fresh page in its browser context. Reusing worker pages would
make native Back/Forward availability depend on which earlier story that worker
visited; changing the worker count must not change the captured UI state.

`--only <story-id-fragment>` limits a capture. `LODY_VISUAL_WORKERS=3` limits
parallel browser pages. `--resume` requires the original static build, exact targets
and the same capture script; use a new phase after changing any of them. Successful
screenshots are retained in a manifest, and failures include diagnostic screenshots.

Capture defaults to reduced motion. A target can set `reducedMotion` to
`no-preference`; `svgTime` on a target or viewport pauses real SVG SMIL at that
time in seconds, since Playwright's animation switch does not synchronize SMIL.
A viewport's `device` names a Playwright device descriptor, including its UA,
touch support and mobile mode. Width alone does not exercise mobile device
detection. These are Chromium device emulations, not native iOS/WebKit runs.

`ready[storyId]` contains observable steps required before the first screenshot.
Use it to await a fixture's known logo: Base UI can preload an image before
mounting its `<img>`, so inspecting `document.images` alone cannot establish
readiness. `blockedHosts` explicitly aborts requests to the listed hosts. The
avatar profiles use this to exercise the real offline fallback on both builds;
they do not substitute images. Keep the original network-dependent captures and
document why they were unsuitable for a pair.

The `waitForFunction` step takes a nonempty browser `expression` and optional
`timeout` (default 15 seconds). Use a read-only predicate for an application
completion signal: a stable clipped form can still be an unfinished login
transition. The login profile requires the stage and expanding rows to reach
their visible phase and measured panel heights, using the existing E2E contract.
It applies the same predicate after view changes on both immutable builds.

## Target profiles and interaction coverage

| Profile                                                             | Coverage                                                                                                                    |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `continuation-targets.json`                                         | Auth/workspace pages, mentions, mobile files and annotation stories at 390/768/1280px in both themes.                       |
| `files-targets.json`                                                | Real desktop file browser, folder/text/binary/error states and 767/768px boundaries.                                        |
| `draft-targets.json`                                                | Empty, ready and submitting drafts, typing, hover, keyboard focus and disabled controls.                                    |
| `interaction-targets.json`                                          | Mobile drill/Markdown/HTML, annotation collapse/hover/independent keyboard peek, textarea focus and disabled state.         |
| `session-leaf-targets.json`                                         | Usage variants, relation trees/confirmation and the delayed notification prompt.                                            |
| `usage-portal-targets.json`                                         | Actually opened usage portals across seven variants.                                                                        |
| `regression-targets.json`                                           | Additional information-bar and onboarding checks; historical missing baselines remain explicit.                             |
| `status-targets.json`                                               | Working grids, unread/collapse states and spinner callers in both themes, including reduced motion.                         |
| `project-edit-targets.json`                                         | Actual project-editor entry, translations, truncation, keyboard/pointer activation and responsive boundaries.               |
| `rename-targets.json`                                               | Actual rename dialog, title wrapping, disabled/pending save, failure/retry, focus and 639/640/641px boundaries.             |
| `schedule-style-targets.json`                                       | Wide schedule rows, child-width precedence, issue tooltips, caller overrides and 639/640px boundaries.                      |
| `bub-style-targets.json`                                            | Install guide copy success/failure, long translation, code overflow and keyboard/pointer states.                            |
| `info-chip-style-targets.json`                                      | Production action/cluster/stage chips, context actions, CI portals and 419/420/421px container boundaries.                  |
| `usage-skeleton-targets.json`, `usage-skeleton-narrow-targets.json` | Actual day/week/year placeholders, root/subtree spacing, 671/672/673px heatmap containers and 320px layouts.                |
| `leaves3-info-bar-targets.json`                                     | Actual privacy/preview actions, compact and empty states, palette scopes and nested light/dark exclusions.                  |
| `outline-rail-targets.json`                                         | Actual rail, overflow, portal and caller precedence at 927/928/929px container widths.                                      |
| `skeleton-sizing-targets.json`                                      | Optional width/height, explicit zero and actual sizing changes on the shared Skeleton primitive.                            |
| `acp-select-targets.json`                                           | Actual ACP selection variants, disabled/empty options, menus, caller overrides and local scale variables.                   |
| `leaves4-stuck-banner-targets.json`                                 | Recovery/dismiss callbacks, long translated copy and narrow connection banners.                                             |
| `leaves4-queue-display-targets.json`                                | Real queue disclosure, utility/opaque callers, folding and root/subtree theme observations.                                 |
| `legacy-task-targets.json`                                          | Actual legacy TaskList rows, caller/root/subtree variable overrides, loading/empty/overflow and desktop pointer states.     |
| `legacy-updated-task-targets.json`                                  | Actual legacy flat Updated list, status/anchor rows, rename, archive, show all/less and scoped variables.                   |
| `owned-session-list-targets.json`                                   | Active SessionList project groups, selection, caller/root/subtree overrides, menus, folding and empty/loading states.       |
| `owned-updated-session-targets.json`                                | Active Updated list trees, precise openers, project groups, caller overrides, read-only/overflow and archive/rename states. |
| `owned-login-targets.json`                                          | Login providers, email/handoff pending states, scoped spacing and actual 860/861px layout boundary.                         |
| `mobile-project-settings-targets.json`                              | Production project settings with multiple machines, long labels, local editors, loading and read-only states.               |
| `mobile-account-settings-targets.json`                              | Production account/workspace settings, editable names, deferred token/invitation actions and scoped variables.              |
| `mobile-workspace-sheets-targets.json`                              | Actual create/delete drawers, validation, pending deletion, long translations and 320/390/768px layouts.                    |
| `file-image-targets.json`                                           | Actual fitted raster/SVG previews, null-source cases, constrained hosts, modal focus and close.                             |
| `markdown-links-targets.json`                                       | Actual prose/table file links, GitHub references, clipboard outcomes, caller overrides and read-only safety.                |
| `workspace-shell-targets.json`                                      | Actual sidebar empty states, menus, tooltips, keyboard focus, resize and root/subtree variables.                            |
| `sidebar-targets.json`                                              | Sidebar layouts, row parts, loading/empty/overflow and archive/menu states; narrow widths use a desktop UA.                 |
| `sidebar-mobile-targets.json`                                       | iPhone/Android descriptors, known-logo readiness and real touch menu/archive actions in both themes.                        |
| `sidebar-updated-interaction-targets.json`                          | Show all/less, selection, collapse/expand and focus/hover on the production Updated list.                                   |
| `sidebar-archive-long-targets.json`                                 | Long-title clipping and slot geometry during archive confirmation and commit.                                               |
| `sidebar-send-motion-targets.json`                                  | Normal-motion send rings at SMIL times 0 and 0.6 seconds.                                                                   |
| `chat-targets.json`                                                 | Composer/landing, selector menus, disabled-context hover/keyboard actions and connection-state transitions.                 |
| `chat-mobile-targets.json`                                          | Real iPhone/Android descriptors, touch actions, keyboard tooltip control and pasted-text layouts.                           |
| `chat-mobile-home-targets.json`                                     | Mobile home headers, workspace logos, onboarding, crowded status and reconnect/offline states.                              |
| `chat-boundary-targets.json`                                        | 311/312, 639/640 and 671/672px widths for compact composer and disabled-context styling.                                    |
| `chat-context-targets.json`, `chat-mobile-context-targets.json`     | Independent corrected context-action/tooltip captures; retain invalid initial selector diagnostics.                         |

`schedule-style-native.mjs`, `bub-style-native.mjs` and `info-chip-style-native.mjs`
take `--phase <name> --storybook <immutable-url>`. They supplement screenshots
with computed child/tooltip contracts, exact clipboard and document-link intents,
and trusted pointer/keyboard states, including local theme-scope selectors. The
chip runner adds `--scope-only true` for its separate local-variable matrix. The
install-guide fixture intercepts its existing browser clipboard and external-open
boundaries; it never runs the displayed command or opens the live guide. Scope
probes verify selector matching, not theme-provider persistence or native OS UI.

`outline-rail-native.mjs` takes the same phase and immutable URL arguments. It
records actual keyboard navigation, pointer preview/jump, touch, overflow scrolling
and unrelated outer-marker states, including raw scrollbar pseudo styles. Caller
descendant ink must retain its original priority relative to named hover/focus
variants. Native frames are separate executions; overlapping states do not imply
additional distinct UI coverage. Full-field observations supplement the report's
smaller layout view without replacing the original screenshots.

Theme initialization can replace a story's early root palette override. Record
the actual element variables after initialization; a story's name is not scope
coverage. Runtime root probes apply and assert their values after that boundary.
Native queue scroll captures wait for real `scrollend`, verify the visible last
row and hit chain, and compare layout/CSS/input state before and after each shot.
Keep earlier scroll paints and their unresolved causes alongside recaptures.

`legacy-task-native.mjs` and `legacy-updated-task-native.mjs` take the same phase
and immutable URL arguments. TaskList writes `proof.json`: matching primary
computed observations plus separately named gesture screenshots. Updated writes
`manifest.json` with native screenshots, trusted events and callback assertions.
Do not count computed-only observations as additional screenshot pairs. Preserve
complete nested fields when comparing; native report adapters assign stable
node-index paths and retain original PNG hashes. Actual touch covers swipe/archive
and the 767/768px boundary; forced colors and drag/cancel/reorder are separate
states. Original nested-button Enter and touch-without-hover restrictions remain
explicit; an unsupported interaction is not a passing screenshot state.

The `owned-session-list-native.mjs`, `owned-updated-session-native.mjs` and
`owned-login-native.mjs` runners also take `--phase` and `--storybook`.
Capture `owned-login-targets.json` with `LODY_VISUAL_WORKERS=1`: the existing
LoginPage stories share a context's last-used-provider storage, so concurrent
stories can change the hidden panel's input state. Use the same story order on
both sources.
SessionList writes `proof.json`; only entries with `shot` are screenshot pairs,
while matching primary observations supply additional computed fields. Drag
captures require the intended moved pose, settled geometry/styles and actual
pointer hit testing. Updated-list captures preserve precise-opener callbacks,
mention payloads, caller precedence and actual touch archive behavior. Login
captures inspect provider SVG sizing, pending spinner spacing and synthetic auth
intents without completing a sign-in. Retain initial mismatched interaction or
transition captures when improving readiness; compare both sources again with
the same final runner and keep raw pixel and diagnostic differences explicit.

`mobile-project-settings-native.mjs`, `mobile-account-settings-native.mjs` and
`mobile-workspace-sheets-native.mjs` use the same phase/immutable-URL arguments.
They record trusted pointer/touch/keyboard events, callback results, focus, exact
geometry and nested computed styles. Project touch-held states record the original
Chromium behavior without claiming `:active` when that pseudo-class is absent.
Account iOS-branch emulation and sheet keyboard-inset CSS probes do not establish
native WebKit or an OS keyboard. The local build rejects cloud workspace creation;
the create runner verifies that rejection and never substitutes a successful
cloud mutation. Delete uses a deferred synthetic callback and verifies its actual
completion/close/reset behavior. Keep failed fixture/locator calibrations, raw
pixel differences and unchanged-source control runs separate from formal pairs.

The compiler-backed [inventory](../../scripts/tailwind-usage.mjs) also inspects
`withClassName`'s second argument, including calls spread onto a component. Its
first argument contains StyleX props and is not a utility expression. Recount
both sources with the same scanner version; older snapshots missed this helper
and cannot establish the current batch's removal count. Pure literal string
concatenations are joined before tokenization, including tokens split across
operands. Mixed runtime or numeric operands remain unresolved; the scanner never
evaluates expressions. Recount the baseline when this recognition changes.

`session-layout-native.mjs`, `search-table-native.mjs` and
`onboarding-surface-native.mjs` capture the owned layout, table and onboarding
fixtures. Keep caller-class precedence, named outer-group hover, resize-handle
pseudo-elements and clipboard deadlines in the recorded contract. Onboarding
overlays resolve to light even when the surrounding Storybook preview requests
dark; record the resolved theme separately. A generic story-sequence capture
that leaves Motion at its initial opacity is a failed capture, not an acceptable
blank baseline. Preserve that run alongside independent native-input evidence.
Its native runner fixes Date while timers and rAF continue, and records explicitly
paused infinite WAAPI icons per frame. Stable computed fields do not certify the
custom tour camera's private rest state or screenshot-time raster equivalence;
retain changed camera coordinates and PNGs in the report.

`file-image-native.mjs`, `markdown-links-native.mjs` and
`workspace-shell-native.mjs` use the same phase/immutable-URL arguments.
Image observations digest loaded image bytes while keeping random blob URL
identities in separate source metadata. Its final native gesture witnesses use
normal motion; reduced-motion primary coverage does not establish reduced-motion
pinch behavior. PhotoView has JavaScript throttling and geometry rebasing beyond
CSS animation completion. Preserve incomplete full runs when adapting common
entries, and label later individual-state witnesses as supplemental. Never let a
zero-failure subset manifest erase the original failure or missing sequence.
Markdown clipboard deadlines use the controlled clock and actual deferred
clipboard boundary. Sidebar pointer/keyboard and separate trusted-touch probes
are distinct input coverage. Supplemental theme/caller probes and computed-only
custom-property observations keep separate counts and original provenance.

`chat-search-ready-targets.json` explicitly enters the search query and waits for
the filtered result. Storybook play completion can precede a successful input
during menu autofocus; a stable unfiltered menu is still the wrong state.

The `controls-session-*-targets.json` profiles cover production SessionList
layouts, real mobile detection, group creation/collapse and keyboard reordering.
Their skeleton readiness checks a visible placeholder before allowing textless
content. `controls-terminal*-targets.json` exercises the real dock and xterm
against a synthetic transport, including limits/errors, tab lifecycle and normal
motion at separately named viewports. `controls-schedule*-targets.json` covers
property rows, real recurrence consumers, native time/date input and portals;
`controls-view-targets.json` opens production turn metadata and activity states.
These fixtures replace transport data, never the rendered UI.

The `next-preview*-targets.json` profiles cover native annotation actions,
corner peeks and explicit theme scopes. `next-search*-targets.json` checks the
real search bar and visible text/Markdown marks; a process disclosure opening
does not establish that provider-gated thought content rendered.
`next-recurrence*-targets.json` and `next-pin-targets.json` cover day/date toggles,
native input segments and the shared pinned-message column. `next-swipe-targets.json`
and `next-queue*-targets.json` exercise production rows and cached-image previews.
`next-swipe-touch.mjs` adds trusted CDP touch input and native Tab/Enter for the
gesture paths the ordinary capture steps do not implement. Its phases use the
same manifest shape and can be assembled with the ordinary captures.

The `round-{command,slider,copy,layout,scroll}-targets.json` profiles exercise the
shared adapters and their actual consumers. Command virtual-list readiness
filters and clears through the real input before requiring mounted rows; an
initial empty virtual viewport is not accepted as list coverage.
`round-layout-native.mjs` and `round-scroll-native.mjs` add trusted pointer,
touch, wheel and keyboard paths. `round-slider-copy-native.mjs` exercises native
range behavior in Chromium/Firefox and uses Playwright's clock plus the real
clipboard for the two-second copied state. Scroll and slider/copy runners take
`--phase <name> --storybook <immutable-url>`; slider/copy also requires
`--kind slider|copy` and optionally `--engine firefox`. The layout runner takes
`LODY_LAYOUT_PHASE` and `LODY_LAYOUT_URL` environment variables. Keep both sides
on the same runner.

The `followup-{emoji,drawer}-targets.json` profiles cover the real Emoji Picker
and Drawer adapters and their settings consumers. Emoji readiness waits for the
actual filtered row count, active emoji and visible footer label; a filled search
input alone precedes Frimousse's deferred list update. The corresponding native
runners capture paused/released local Emojibase requests, sticky headers, native
keyboard selection and forced colors, plus Vaul touch drag/close in four directions.
Run either with `--phase <name> --storybook <immutable-url>`. Drawer waits for
Vaul's own 500ms no-drag opening guard before trusted touch input. Failed
forced-colors candidates and caret hash controls remain separate evidence.

The `diff-{main,leaves,edge}-targets.json` profiles mount the production Diff
Viewer, comments and action buttons. Shadow-line readiness proves body layout;
async syntax/theme frames also require real colored token spans. The native
runners capture actual shadow DOM, container breakpoint changes, context expansion,
selection, normal-motion collapse frames, touch comments and real clipboard
success/rejection/deadlines. Both take `--phase <name> --storybook <immutable-url>`.
Keep nonstandard native scenario keys as separately verified supplemental pairs:
assembling them as ordinary profiles can invent canonical rest frames that the
runner never intended to capture. Inspect original phase failures and expected
counts rather than accepting that invented matrix.

The historical `alpha-{mobile,surface,sidebar}-targets.json` profiles separated an
unchanged baseline, exact original CSS-declaration controls and final source.
Runtime restored-declaration images are real browser controls, not whole
historical builds. A later independent source-reference build keeps verified
color/state/palette repairs while retaining the five utilities being migrated;
its screenshots isolate migration equivalence without late inline mutation.
Preserve rejected reference paint results and their provenance when using that
source reference. The native runners record target uniqueness, computed values,
media/input state and the exact declarations applied. Mobile captures must await
finite animation completion and stable geometry, transform, opacity and color.
Upstream direct folder selection retires the removal-confirmation components and
their dedicated AlphaSidebar stories/profile/runner and mobile-removal palette
runner. Current AlphaMobile covers tabs only. Reproduce retired states from their
recorded source commits; their original report images remain historical evidence.
The `main-*-integration-*` runners compare the updated live surfaces with an
explicit source-reference unit on the same integrated graph, not a whole
historical-main application. Preserve that reference boundary and failed builds.
`main-mobile-settings-scopes.mjs` and `main-queue-integration-scopes.mjs` keep
root/subtree ink, hover and focus probes reproducible with the same
`--phase` / `--storybook` arguments. Preserve real command-port, no-op callback
and scheduler-preview-slot limits instead of labelling these as daemon tests.

Static Storybook builds explicitly retain `@pierre/diffs`' shipped web-component
registration module: version 1.0.10's side-effect metadata names an unpublished
source path. Require rendered shadow-DOM lines before accepting a diff body;
an unregistered zero-height custom element only verifies its surrounding chrome.

The `states` object maps a story ID to ordered state names and observable steps.
When another surface such as an error toast also uses `role="dialog"`, locate
the intended dialog by its accessible name. Portal-only fixtures still require
visible actual content even when their unpainted story root is allowed blank.
Steps use roles, text or owned selectors and can click, tap, hover, focus, fill, press,
move the pointer, or assert visible/hidden/enabled/disabled state. States execute
in sequence after a fresh story load. Move the pointer away before a keyboard
peek so a hovering pointer cannot satisfy the intended keyboard condition.

`create-targets.json`, `notification-targets.json` and `join-targets.json` are
supplemental profiles used to replace invalid legacy captures with verified
original-component frames. Before-source copies and per-frame origins stay in
the local evidence; no recreated or generated image serves as a baseline.

To combine independent profiles, give each its own capture phase and assemble
them. Later successful captures of the same key supersede earlier frames or
failures, while source manifests retain their origins and failure history:

```sh
node tests/visual/visual-regression.mjs assemble \
  --phases pages-before,files-before,draft-before --phase acceptance-before
node tests/visual/visual-regression.mjs assemble \
  --phases pages-after,files-after,draft-after --phase acceptance-after
node tests/visual/visual-regression.mjs report \
  --before acceptance-before --after acceptance-after --name acceptance
```

Already assembled phases can be combined again. Each frame retains its original
capture phase and URL, and nested source metadata remains in the manifest. When
combining progressive batches, document each batch's baseline and final build;
do not describe every frame as coming from one final build.

An optional `--context <json-file>` adds `scope`, `checks` and `limits` string
arrays and an `evidence` array of `{label,dataUrl}` screenshots to the report.
`metricsDescription` states which assembled phases the counters include; use it
when native captures are part of the matrix.
`coverage` rows contain `{file,before,after,remaining}`. `evidencePairs` contains
`{label,beforeUrl,afterUrl}` with embedded PNG data URLs; `evidenceTitle` and
`evidenceDescription` identify the evidence and its limits. Use these for measured
coverage, reviewed differences and separate Electron images. Keep ignored runtime
artifacts out of commits.

## Real desktop smoke

From the repository root:

```sh
pnpm --dir apps/electron build
pnpm --dir e2e exec tsx --tsconfig ../apps/cli/tsconfig.json \
  ../packages/components/tests/visual/electron-smoke.mts
```

If the bundled CLI is already built and synced, `build:app` rebuilds the desktop
without repeating that work. Reused dependency trees need resolved SDK peer
versions checked against `pnpm-lock.yaml`; the SDK version alone is insufficient.
Rebuild and sync the CLI after correcting a verification environment before
accepting its desktop screenshots. The runner mounts the production main/preload/
renderer/IPC/CLI graph through the existing E2E harness. It owns temporary data,
user-data and endpoint bindings and verifies shutdown cleanup. Each immutable
round contains application PNGs, trace, console/runtime logs, assertions and
build hashes. A single run is after-only evidence. Two runs around an actual
rebuild supply application before/after images; natural startup animations still
need separate phase control before their pixel differences can be a gate.

Set `LODY_STYLE_MIGRATION_SCHEDULES=1` on the smoke command to additionally open
the actual local Schedules editor, switch daily/weekly/monthly rules, toggle a
weekday with Space, edit the native time segments and toggle a month date.
The runner leaves this isolated draft unsaved and records seven application
images rather than the default four.

The component behavior suite is separate. On Node 26, disable native Web Storage
so jsdom supplies its own Storage objects:

```sh
NODE_OPTIONS=--no-experimental-webstorage NODE_ENV=test pnpm test -- --maxWorkers=2
```
