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

The legacy report's `identical` status uses threshold/layout checks, and
`changedPixels: 0` does not prove byte equality or zero raw RGBA differences.
Inspect `pngIdentical` and retain independent raw-pixel counts. A nonzero raw
comparison stays OPEN even when its threshold count is zero.

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
including portal positioners that resize after their trigger has settled. A target
label must also intersect its clipping ancestors and pass a real hit/paint check;
a visible input alone does not establish that its label is on screen. Stable
geometry and identical pixels alone do not establish the intended state: constrain
sibling copy-feedback icons when a timer can reset them, and record actual popup
and ancestor opacity/visibility before accepting dialog captures. Keep byte-equal
but unpainted calibration frames separate from painted acceptance. Element-local
original-token stress can expose real CSS differences even when the current fixed
component props cannot produce those writers; report that contract boundary
without presenting DOM injection as an observed application caller. `allowBlankIds`
permits deliberately blank or textless skeleton roots and portal-only stories;
skeleton profiles require a visible painted placeholder, and portal-only profiles
require a visible actual portalled control through `ready`. It never exempts that
required content. Failed image loads or missing content
fail the capture. Saved, validated frame checkpoints from a stalled runner remain
frame evidence only: final behavior assertions and normal process/browser closure
require their own completion signals. Portalled content is part of the layout snapshot. A fixed
Date value stabilizes relative-time labels without stopping the browser's timers.
Every story gets a fresh page in its browser context. Reusing worker pages would
make native Back/Forward availability depend on which earlier story that worker
visited; changing the worker count must not change the captured UI state.

`--only <story-id-fragment>` limits a capture. `LODY_VISUAL_WORKERS=3` limits
parallel browser pages. `--resume` requires the original static build, exact targets
and the same capture script; use a new phase after changing any of them. Successful
screenshots are retained in a manifest, and failures include diagnostic screenshots.

For native browser controls, a decoded media source and `readyState` do not establish
that the browser's internal controls painted the same state. Preserve original
frames and inspect the user-agent shadow controls when ordinary DOM records agree
but duration labels or control positions differ. A later settled capture cannot
retroactively prove the original state or close its unexplained pixels. A state
key does not establish focus: ordered fill steps may finish on a different control.
Preserve inherited capture keys and annotate the actual focused state separately.

Check migrated custom-property writers in the complete built CSS, including their
layer ancestors. A writer-only compiler probe can omit priority-zero root/theme
rules and produce a different grouping result. Pair inherited, inline and real
caller-layer overrides on the actual child; do not infer cascade equivalence from
matching default screenshots.

Capture defaults to reduced motion. A target can set `reducedMotion` to
`no-preference`; `svgTime` on a target or viewport pauses real SVG SMIL at that
time in seconds, since Playwright's animation switch does not synchronize SMIL.
A viewport's `device` names a Playwright device descriptor, including its UA,
touch support and mobile mode. Width alone does not exercise mobile device
detection. These are Chromium device emulations, not native iOS/WebKit runs.

`waitForFunction` expressions must synchronously return a condition; function
expressions are invoked and Promise results are rejected. Run
`node tests/visual/readiness-check.mjs --storybook http://127.0.0.1:6127` against
a fixed build to verify that false gates prevent captures, true gates allow them,
and async conditions fail explicitly. Earlier captures retain real PNGs but cannot
establish that JSON arrow-function gates ran before this runner correction.

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

| Profile                                                                                                                                                                                  | Coverage                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `continuation-targets.json`                                                                                                                                                              | Auth/workspace pages, mentions, mobile files and annotation stories at 390/768/1280px in both themes.                                                                                                                        |
| `files-targets.json`                                                                                                                                                                     | Real desktop file browser, folder/text/binary/error states and 767/768px boundaries.                                                                                                                                         |
| `draft-targets.json`                                                                                                                                                                     | Empty, ready and submitting drafts, typing, hover, keyboard focus and disabled controls.                                                                                                                                     |
| `interaction-targets.json`                                                                                                                                                               | Mobile drill/Markdown/HTML, annotation collapse/hover/independent keyboard peek, textarea focus and disabled state.                                                                                                          |
| `session-leaf-targets.json`                                                                                                                                                              | Usage variants, relation trees/confirmation and the delayed notification prompt.                                                                                                                                             |
| `usage-portal-targets.json`                                                                                                                                                              | Actually opened usage portals across seven variants.                                                                                                                                                                         |
| `regression-targets.json`                                                                                                                                                                | Additional information-bar and onboarding checks; historical missing baselines remain explicit.                                                                                                                              |
| `status-targets.json`                                                                                                                                                                    | Working grids, unread/collapse states and spinner callers in both themes, including reduced motion.                                                                                                                          |
| `project-edit-targets.json`                                                                                                                                                              | Actual project-editor entry, translations, truncation, keyboard/pointer activation and responsive boundaries.                                                                                                                |
| `rename-targets.json`                                                                                                                                                                    | Actual rename dialog, title wrapping, disabled/pending save, failure/retry, focus and 639/640/641px boundaries.                                                                                                              |
| `schedule-style-targets.json`                                                                                                                                                            | Wide schedule rows, child-width precedence, issue tooltips, caller overrides and 639/640px boundaries.                                                                                                                       |
| `bub-style-targets.json`                                                                                                                                                                 | Install guide copy success/failure, long translation, code overflow and keyboard/pointer states.                                                                                                                             |
| `info-chip-style-targets.json`                                                                                                                                                           | Production action/cluster/stage chips, context actions, CI portals and 419/420/421px container boundaries.                                                                                                                   |
| `usage-skeleton-targets.json`, `usage-skeleton-narrow-targets.json`                                                                                                                      | Actual day/week/year placeholders, root/subtree spacing, 671/672/673px heatmap containers and 320px layouts.                                                                                                                 |
| `leaves3-info-bar-targets.json`                                                                                                                                                          | Actual privacy/preview actions, compact and empty states, palette scopes and nested light/dark exclusions.                                                                                                                   |
| `outline-rail-targets.json`                                                                                                                                                              | Actual rail, overflow, portal and caller precedence at 927/928/929px container widths.                                                                                                                                       |
| `skeleton-sizing-targets.json`                                                                                                                                                           | Optional width/height, explicit zero and actual sizing changes on the shared Skeleton primitive.                                                                                                                             |
| `acp-select-targets.json`                                                                                                                                                                | Actual ACP selection variants, disabled/empty options, menus, caller overrides and local scale variables.                                                                                                                    |
| `leaves4-stuck-banner-targets.json`                                                                                                                                                      | Recovery/dismiss callbacks, long translated copy and narrow connection banners.                                                                                                                                              |
| `leaves4-queue-display-targets.json`                                                                                                                                                     | Real queue disclosure, utility/opaque callers, folding and root/subtree theme observations.                                                                                                                                  |
| `leaves5-skills-targets.json`, `leaves5-skills-detail-targets.json`                                                                                                                      | Production skills Body states, runtime spacing, long/absent descriptions, refresh callbacks and detail/back; the story shell is not the product Drawer.                                                                      |
| `leaves6-mention-targets.json`, `leaves6-queue-row-targets.json`, `leaves6-filter-pill-targets.json`                                                                                     | Mention selection/scroll readiness, owned row hover/focus and filter theme scopes/visible open/close states.                                                                                                                 |
| `leaves7-home-targets.json`, `leaves7-project-screen-targets.json`, `leaves7-recurrence-targets.json`                                                                                    | Actual home/project headers and recurrence controls, search/filter/archive feedback, disabled days and scoped theme values.                                                                                                  |
| `leaves8-editor-terminal-targets.json`, `leaves8-warning-targets.json`, `leaves8-merge-targets.json`                                                                                     | Production message editor, command divider, warning palette and compact merge control states, including local variable scopes and callbacks.                                                                                 |
| `leaves9-composer-status-targets.json`, `leaves9-composer-fallback-targets.json`                                                                                                         | Production composer warning/error/info/absent status, actual render-failure fallback, preserved draft editing/retry and element-local palette scopes.                                                                        |
| `leaves9-sidebar-targets.json`                                                                                                                                                           | Exported legacy Sidebar adapter, mobile opening, desktop collapse, floating/inset layout, 767/768px boundary and local theme variables; no active app consumer is claimed.                                                   |
| `leaves10-composer-surface-targets.json`                                                                                                                                                 | Real Composer frames and mention covers, local palettes, file drag enter/leave/drop, disabled/dialog ignore paths and actual selected chips.                                                                                 |
| `leaves10-share-card-targets.json`                                                                                                                                                       | Fixed share-card layout across sizes, backdrops, mat, titles, empty content and local spacing; pixel equality alone does not establish selected-palette isolation.                                                           |
| `leaves11-share-palette-targets.json`                                                                                                                                                    | Actual share-card palette/spacing isolation and layout against pre-migration source, kept separate from buggy-Before repair witnesses.                                                                                       |
| `leaves12-spinner-dimensions-targets.json`                                                                                                                                               | Named and explicit Spinner dimensions, SVG attributes, local spacing, mounted zero/omit/update and real saving/merging consumers.                                                                                            |
| `leaves13-spinner-auth-targets.json`, `leaves13-spinner-mobile-targets.json`, `leaves13-spinner-misc-targets.json`                                                                       | Actual authentication/mobile/loading Spinner callers, local spacing and observable pending controls.                                                                                                                         |
| `leaves14-spinner-password-targets.json`, `leaves14-spinner-account-targets.json`                                                                                                        | Password/account pending controls and local spacing, with closing-motion and synthetic Capacitor identity probes recorded separately.                                                                                        |
| `leaves14-monaco-targets.json`                                                                                                                                                           | Actual Monaco viewer wrapper and editor, with scrollbar class/transition readiness separate from wrapper geometry.                                                                                                           |
| `leaves15-popover-layout-targets.json`                                                                                                                                                   | Actual Popup zero/default padding and gap, same-node updates, contained and forced theme, focus/ref/positioner contracts.                                                                                                    |
| `leaves15-popover-consumers-targets.json`                                                                                                                                                | Seven production popups: anchored/stage/CI, closed tabs, Share, sender profile and turn configuration; actual themes recorded separately.                                                                                    |
| `leaves16-history-spinner-targets.json`, `leaves16-spinner-session-targets.json`                                                                                                         | Real history import/resolve pending and reopen, Session/loading/settings Spinner consumers and local spacing.                                                                                                                |
| `leaves17-popover-dimensions-targets.json`                                                                                                                                               | Actual Popup dimensions, zero/default updates, local spacing, contained and forced theme; positioner ownership remains separate.                                                                                             |
| `leaves18-project-settings-spinner-targets.json`, `leaves18-spinner-about-targets.json`                                                                                                  | Actual project loading/sharing and About updater components, synthetic public CloudApi/IPC boundaries, local spacing and recovery.                                                                                           |
| `leaves19-menu-dimensions-targets.json`, `leaves19-menu-consumers-targets.json`                                                                                                          | Actual Menu popup bounds, zero/reset/container/compact, Header Copy/Fork/Owner, Side Add and local/remote file menus; Opened sessions remains uncovered.                                                                     |
| `leaves20-integrations-spinner-targets.json`, `leaves20-ceremony-targets.json`                                                                                                           | Public cloud-shaped Integrations loading/preference/auth recovery and actual paused Ceremony, scope palettes, real skip/finish controls; dark host stress differs from route light ownership.                                |
| `leaves21-context-menu-dimensions-targets.json`, `leaves21-context-consumers-targets.json`                                                                                               | Actual ContextMenu bounds/zero/reset/container and six real row menus opened with browser right-click; Gallery remains After-only.                                                                                           |
| `leaves22-button-dimensions-targets.json`                                                                                                                                                | Button box dimensions, zero/omit and same-node updates, caller contracts and local spacing; held active captures are a separate reduced-motion native probe.                                                                 |
| `leaves22-button-mobile-targets.json`, `leaves22-button-leaf-targets.json`, `leaves22-button-auth-targets.json`                                                                          | Actual mobile/leaf/auth callers, portal pairing and handoff states; unmounted login controls stay deferred.                                                                                                                  |
| `leaves22-button-private-targets.json`                                                                                                                                                   | Header trigger, reply card/dialog and Plan Copy hover/focus; audited successful Before subset covers eight migrated utilities, with failed Search/hidden Footer states retained separately.                                  |
| `leaves23-context-remaining-targets.json`, `leaves23-owned-controls-targets.json`                                                                                                        | Real Markdown/local-project/file-tree/terminal menus and visible Opened/Search/Footer controls; three original hidden xterm helper geometry records remain explicit.                                                         |
| `leaves24-message-action-button-targets.json`                                                                                                                                            | Actual message-action Button dimensions, hover/focus and scoped spacing; physical touch and controlled clipboard feedback are separate reduced-motion native captures.                                                       |
| `leaves24-button-small-callers-targets.json`                                                                                                                                             | Mermaid min/max/reset and actual portal spacing; MobileAdd directory navigation, Usage detail close and Loro empty-view recovery. Rejected gates and local navigation failures stay separate.                                |
| `leaves25-button-invariants-desktop-targets.json`, `leaves25-button-invariants-phone-targets.json`                                                                                       | Actual primitive-owned declarations: 40 PNG pairs; 44-root computed proof is separate and adds no PNGs. Original readiness failures remain diagnostic.                                                                       |
| `leaves25-private-fork-button-targets.json`                                                                                                                                              | Closed two-caller Fork helper defaults, caller overrides, real menus and legacy Spinner pending states; rejected selector/ready phases remain separate.                                                                      |
| `leaves26-spinner-invariants-targets.json`, `leaves26-spinner-sharing-targets.json`, `leaves26-spinner-project-ready-targets.json`, `leaves26-spinner-project-after-repair-targets.json` | Real Spinner invariant states; cached-avatar and Sharing readiness have separate source phases. Normal-motion supplements and original OPEN frames stay separate.                                                            |
| `leaves26-message-content-spacing-targets.json`, `leaves26-sender-avatar-targets.json`                                                                                                   | Actual message action reveal/edit/cancel and sender profile, plus retained plan/media spacing controls; rejected writer-layer candidate and native audio OPEN remain explicit.                                               |
| `leaves26-sidebar-footer-targets.json`                                                                                                                                                   | Four internal callers of the module-private Loro footer helper, actual menus/actions and scoped dimensions; desktop remains an unchanged control.                                                                            |
| `leaves27-sidebar-desktop-targets.json`, `leaves27-sidebar-phone-targets.json`                                                                                                           | Real public Sidebar adapters; desktop and explicit-phone profiles preserve caller variants. Rejected ancestor/caller prototypes and five supplemental OPEN pairs remain separate.                                            |
| `leaves27-managed-preview-spinner-targets.json`                                                                                                                                          | Actual sandbox inspector target resolution, draft Cancel/reopen/pending and element-local Spinner dimensions; four real animation samples are separate.                                                                      |
| `leaves28-collapsible-layout-targets.json`                                                                                                                                               | Three private CollapsibleCard callers, owned width/radius/padding composition, actual normal/activity media, kind=read, local variables and direct Thought search compatibility.                                             |
| `leaves29-message-action-colors-targets.json`                                                                                                                                            | Seven fixed ghost-action Button sites, both Fork callers, fine/coarse color states and scoped tokens. Accepted120 includes112 original plus8 exact-state-ready pending pairs; direct inline token negatives remain separate. |
| `leaves30-billing-container-spinner-targets.json`                                                                                                                                        | Actual Billing preview/Cancel/reopen/pending-confirmation flows with synthetic public providers. Accepted normal-motion screenshots additionally require painted dialogs; no Stripe/auth E2E claim.                          |
| `leaves31-conversation-panel-targets.json`                                                                                                                                               | Actual Terminal and Plan header/body layout, collapse/Space reopen, approval/drafting/local variables; 216 native role snapshots add no PNGs.                                                                                |
| `leaves32-managed-frame-targets.json`                                                                                                                                                    | Actual credentialless inspector iframe, transparent synthetic child paint, Cancel/reopen/pending and local white variable; v1 paint failure and scheme experiment stay diagnostic.                                           |
| `leaves33-search-action-colors-targets.json`                                                                                                                                             | Actual SearchBar typing/navigation/wrap/clear/Escape/Close and 128-result search; native fine/coarse glyph/token controls and genuine inline negatives remain separate.                                                      |
| `leaves34-no-background-colors-targets.json`                                                                                                                                             | Actual fixed Operation/Header More ink; inherited hover backgrounds, focus, disabled state and two target tokens. Four inline negatives are genuine color differences.                                                       |
| `leaves35-project-group-icons-targets.json`, `leaves35-project-group-natural-menu-targets.json`                                                                                          | Actual group resolved/fallback glyphs, caller precedence and natural 70% opacity; original six raster OPENs remain explicit.                                                                                                 |
| `leaves35-project-group-menu-painted-targets.json`, `leaves35-project-group-natural-menu-painted-targets.json`                                                                           | Genuine painted-menu readiness; final48closed+12painted source rows retain three current raster OPENs and exact source provenance.                                                                                           |
| `leaves44-modal-spacing-targets.json`, `leaves44-modal-spacing-consumers-targets.json`                                                                                                   | Actual Dialog/Alert default-none combinations, omission reset, retained value/focus, inline style callbacks and real modal host; Rename/Operation portals use actual-popup readiness.                                        |
| `leaves45-avatar-glyph-targets.json`                                                                                                                                                     | Actual User/Workspace fallback glyphs across five rungs, inherited glyph-token theme, mounted theme swap/restore and initials controls; DPR3 CSS adds no PNGs.                                                               |
| `leaves46-dialog-consumers-targets.json`                                                                                                                                                 | Actual pasted-text editing, Quick Open filtering and Operation reply reopen; real coordinate clicks pass through the mirror. Forced UI-dark/global-light retains its original Markdown contrast limitation.                  |
| `leaves47-spinner-margin-targets.json`, `leaves47-spinner-margin-rtl-targets.json`                                                                                                       | Five pending Spinner margins with root/subtree spacing and local-button RTL. Whole-app RTL failures and two normal-motion Billing pixel OPENs remain separate.                                                               |
| `leaves48-input-height-targets.json`, `leaves48-input-height-consumers-targets.json`                                                                                                     | Actual plain/leading/password well height, native attributes, style callbacks, zero/reset and four app callers. Three original one-pixel PNG OPENs remain; CSS-only probes and Gallery After-only images stay separate.      |
| `leaves49-command-dialog-targets.json`                                                                                                                                                   | Existing public CommandDialog filter/empty/keyboard/reopen at 1280/639/640/390px. Phone captures retain the original 512px overflow and explicit 30+10 Before origins; matching pixels do not establish viewport fit.        |
| `leaves50-private-spacing-targets.json`                                                                                                                                                  | Six private spacing owners, callbacks and local variables. Accepted72 retain64standard/eightnative origins; Banner UNKNOWNs and one collapsed PlanBar pixel OPEN remain.                                                     |
| `leaves51-private-input-height-targets.json`                                                                                                                                             | Actual account edit inputs and session search use controlHeight;48 exact pairs cover editing, long text, query, keyboard and Escape/reopen.                                                                                  |
| `leaves52-workspace-delete-spinner-targets.json`                                                                                                                                         | Real typing, deferred confirmation and completed/reopened deletion sheet. Three original pixel OPENs remain despite matching layout and bounded ancestor CSS.                                                                |
| `leaves54-public-browser-loading-targets.json`                                                                                                                                           | Renderer-only PublicBrowserSurface Loading/ready/error with never-forward synthetic IPC; corrected Before excludes initial fixture theme IPC errors.                                                                         |
| `leaves74-tooltip-type-width-targets.json`, `leaves77-*-targets.json`                                                                                                                    | Actual Tooltip text/width/wrapping, real archive hover and completed Monaco embedded-JavaScript rendering; original state-mismatched and raw-pixel frames remain separate.                                                   |
| `leaves75-resize-*-targets.json`                                                                                                                                                         | Opt-in edge-handle owner, default controls, actual 767/768px boundary and native drag/keyboard supplements; normal-motion captures establish settled endpoints.                                                              |
| `leaves76-button-typography-*-targets.json`                                                                                                                                              | Actual private Button consumers and owner typography fields; rejected custom-property CSS-wide semantics remain distinct from the final physical-field API.                                                                  |
| `leaves78-diff-notice-*-targets.json`                                                                                                                                                    | Actual DiffNotice header, public direct-child callers and retained dark-border precedence; native logical-axis and real 75ms motion frames are supplemental.                                                                 |
| `legacy-task-targets.json`                                                                                                                                                               | Actual legacy TaskList rows, caller/root/subtree variable overrides, loading/empty/overflow and desktop pointer states.                                                                                                      |
| `legacy-updated-task-targets.json`                                                                                                                                                       | Actual legacy flat Updated list, status/anchor rows, rename, archive, show all/less and scoped variables.                                                                                                                    |
| `owned-session-list-targets.json`                                                                                                                                                        | Active SessionList project groups, selection, caller/root/subtree overrides, menus, folding and empty/loading states.                                                                                                        |
| `owned-updated-session-targets.json`                                                                                                                                                     | Active Updated list trees, precise openers, project groups, caller overrides, read-only/overflow and archive/rename states.                                                                                                  |
| `owned-login-targets.json`                                                                                                                                                               | Login providers, email/handoff pending states, scoped spacing and actual 860/861px layout boundary.                                                                                                                          |
| `mobile-project-settings-targets.json`                                                                                                                                                   | Production project settings with multiple machines, long labels, local editors, loading and read-only states.                                                                                                                |
| `mobile-account-settings-targets.json`                                                                                                                                                   | Production account/workspace settings, editable names, deferred token/invitation actions and scoped variables.                                                                                                               |
| `leaves85-*-targets.json`                                                                                                                                                                | Actual Dialog/Vaul hidden names; original portal gates and strict replacements retain distinct origins.                                                                                                                      |
| `leaves86-card-title-targets.json`                                                                                                                                                       | Fixed auth/workspace Card titles with real theme/paint/focus/password-reveal gates.                                                                                                                                          |
| `leaves87-mobile-*-targets.json`                                                                                                                                                         | Native landing labels, keyboard focus and sidebar callback at 320/390/767/768px, with RTL/local font.                                                                                                                        |
| `leaves87-preview-title-targets.json`, `leaves87-popover-default-controls-targets.json`                                                                                                  | Actual BaseUI Popover hidden title open/Escape/reopen and default-owner controls.                                                                                                                                            |
| `leaves88-*-targets.json`                                                                                                                                                                | Actual standalone/managed annotation Textarea input, pending/cancel, theme and size gates.                                                                                                                                   |
| `mobile-workspace-sheets-targets.json`                                                                                                                                                   | Actual create/delete drawers, validation, pending deletion, long translations and 320/390/768px layouts.                                                                                                                     |
| `file-image-targets.json`                                                                                                                                                                | Actual fitted raster/SVG previews, null-source cases, constrained hosts, modal focus and close.                                                                                                                              |
| `markdown-links-targets.json`                                                                                                                                                            | Actual prose/table file links, GitHub references, clipboard outcomes, caller overrides and read-only safety.                                                                                                                 |
| `workspace-shell-targets.json`                                                                                                                                                           | Actual sidebar empty states, menus, tooltips, keyboard focus, resize and root/subtree variables.                                                                                                                             |
| `sidebar-targets.json`                                                                                                                                                                   | Sidebar layouts, row parts, loading/empty/overflow and archive/menu states; narrow widths use a desktop UA.                                                                                                                  |
| `sidebar-mobile-targets.json`                                                                                                                                                            | iPhone/Android descriptors, known-logo readiness and real touch menu/archive actions in both themes.                                                                                                                         |
| `sidebar-updated-interaction-targets.json`                                                                                                                                               | Show all/less, selection, collapse/expand and focus/hover on the production Updated list.                                                                                                                                    |
| `sidebar-archive-long-targets.json`                                                                                                                                                      | Long-title clipping and slot geometry during archive confirmation and commit.                                                                                                                                                |
| `sidebar-send-motion-targets.json`                                                                                                                                                       | Normal-motion send rings at SMIL times 0 and 0.6 seconds.                                                                                                                                                                    |
| `chat-targets.json`                                                                                                                                                                      | Composer/landing, selector menus, disabled-context hover/keyboard actions and connection-state transitions.                                                                                                                  |
| `chat-mobile-targets.json`                                                                                                                                                               | Real iPhone/Android descriptors, touch actions, keyboard tooltip control and pasted-text layouts.                                                                                                                            |
| `chat-mobile-home-targets.json`                                                                                                                                                          | Mobile home headers, workspace logos, onboarding, crowded status and reconnect/offline states.                                                                                                                               |
| `chat-boundary-targets.json`                                                                                                                                                             | 311/312, 639/640 and 671/672px widths for compact composer and disabled-context styling.                                                                                                                                     |
| `chat-context-targets.json`, `chat-mobile-context-targets.json`                                                                                                                          | Independent corrected context-action/tooltip captures; retain invalid initial selector diagnostics.                                                                                                                          |

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

Composer fallback readiness requires the production failure text, preserved draft
and fallback textarea marker, rather than a hand-rendered substitute. A changing
reset key must leave the captured failure visible; only the actual retry action
restores the normal composer with the edited draft. Palette probes assert resolved
status ink, including an element-local writer and nested light-scope exclusion.

Composer surface checks distinguish the frame's translucent oklab fill from the
mention cover's opaque sRGB mix. Compare both actual backgrounds and the raw
custom property, after local variables and mirror selection/scroll have committed.
File-event controls use real browser DataTransfer/File objects with production
handlers; record their synthetic dispatch boundary. For normal-motion session
colours, pause the actual CSS transitions and screenshot with animations allowed;
record pre/post current times rather than treating disabled animation as a midpoint.

Popover readiness measures the actual `role=dialog` popup after its finite
transition, fonts/images and complete content have committed. Keep its layout
props distinct from positioner `style` and ref ownership. Story globals can force
a theme despite the requested URL: the sender profile is light and the desktop
turn-configuration story is dark. Record actual palette observations rather than
counting each requested theme as distinct rendered coverage. A story play action
may leave a popup closed; establish the required state with explicit user input
and retain the rejected capture.
Dimension gates must resolve CSS units at the element instead of parsing `.25rem`
as a pixel step. A computed `min-width` can be `0px` when the authored default is
`auto`; assert actual layout and keep failed assumptions as diagnostics. History
confirmation can close its parent Drawer while a callback remains pending; use
real reopen controls for that state rather than assuming it remains on screen.
Submenu keyboard focus can open a tooltip over other rows. Preserve that feedback
frame, then focus an actual non-tooltip row for an additional complete-content
state. Check requested IDs against the built Storybook index: a misspelled ID can
otherwise leave a smaller successful selection. Synthetic IPC fixtures must
implement the existing theme subscription boundary before their component renders;
keep unsupported-event failures separate from product style acceptance.
A route that owns light theme can still have a dark-host stress fixture, but label
that boundary. Paused/reduced-motion frames do not establish the full motion or
audio timeline. Keep above-threshold paints OPEN even when inherited CSS, image
bytes, hit stacks and animation records match. Original capture harnesses remain
hash-identified when later batches extend optional interaction arguments.

For managed iframe backgrounds, computed color does not establish child-composited
paint. Decode original full screenshots at declared points and keep source-document
scheme, transparency and security attributes. A same-frame child-scheme mutation
can diagnose a white/cyan mismatch, but accepted product comparisons must use
independently built matching fixture documents without that runtime mutation.

`leaves31-33-acceptance.html` separates 168 exact formal pairs/12,024 records from
20 supplemental pairs and four original failed-calibration images. Eight supported
search native pairs agree in ordinary CSS, pseudos and actual SVG descendants;
four manual inline original-token pairs genuinely differ by 392 raw/392 threshold
pixels each. The reviewed SearchBar has fixed children and no style/visual props;
its three production callers supply only height-only rootFill. The local theme
is not an arbitrary Button/ancestor API. Preserve raw token inputs, disabled `/40`
and artificial ancestor counterexamples; identical default screenshots cannot
justify expanding that contract. Prototype computed ink and screenshot changes
are reported independently, without inferring unproved paint causes. Saved native
screenshots and complete checkpoints do not establish successful cleanup if the
process subsequently stalls. Frozen older reports and non-exhaustive OPEN indices
remain unchanged; current report QA covers full payload decode and two continuous
1280/390 Chrome interaction cycles.

`leaves34-35-acceptance.html` remains **partial visual acceptance**: 105/108
formal PNG pairs exact, three current focus-ring OPENs/14raw pixels, with all
5,264 standard node records equal. Six original pairs/24raw pixels stay separate.
Zero threshold pixels does not close these differences. Its selector matrix is
an explicit reference assembly of48original closed-state pairs plus12real
painted-menu captures, not a fabricated capture manifest. Actual popup paint
requires opacity1, identity transform and no pending lifecycle/finite transition;
mounted geometry alone previously accepted opacity0. Natural menu controls keep
real70% glyph opacity without caller masks. Bound ring CSS/repeat diagnostics do
not prove exact raster causes. Fixed no-background color themes target only two
tokens and retain all51others, including ghostHover; four manual same-element
inline token cases truly change colors and stay negative contracts. Native data
completion and stalled cleanup are separately reported. Original image/source
hashes, all payload decode and two continuous1280/390 report UI cycles qualify
this batch without changing prior frozen reports or inventory-method baselines.

The 36–39 control-dimension report separates 248 formal pairs (246 exact, two
OPEN, 13,210 equal standard records), twenty exact selected native pairs and
51 broader browser-story pairs (44 exact, seven OPEN). Keep the original invalid
viewport frames and four cross-method native differences diagnostic; a same-method
comparison does not retroactively close them. Width/height checks must include
both `innerWidth`/`innerHeight` and the actual PNG dimensions. Full CSS and actual
pointer/focus/animation records constrain a diagnosis without proving its raster
cause. The solo share-title continuation separately records 28 exact pairs and
4,102 records, including scoped dimensions and actual long-title clipping.

The 41 continuation uses 60 real pairs/1,900 standard records; each side is an
explicit 52+8 capture-origin assembly. Keep the original eight timeout screenshots,
wrong square-size assumption and bounded diagnostic follow-up separate. A body
portal subtree can shrink a 17.5px share glyph to 16px wide: preserve that actual
flex contract. The mobile-account/encrypted-mark continuation contributes another
64 exact pairs/4,536 records and eight normal-motion closing pairs; pausing a real
closing animation at its start does not validate its whole timeline. An empty or
opaque caller class still replaces the encrypted mark's default rather than
merging with it. CSS-only samples never add screenshot pairs.

The modal-spacing/avatar-glyph report has 108 exact formal PNG pairs/7,536 equal
standard records. The modal fixture's Before uses real legacy classes and its
After swaps only that local adapter to the new Content props; retain both fixture
hashes instead of claiming identical source bytes. Twelve modal CSS scenes and
four DPR3 avatar CSS scenes add no screenshot pairs. Gallery and Electron images
are After-only, with actual pixel dimensions retained.

A portal-only Rename story leaves its decorated story root blank even when its
body-mounted dialog is painted. Its target may use the existing `allowBlankIds`
exception only with strict actual-popup spacing/paint/theme/focus/animation gates.
Retain the initial five error PNGs, interrupted checkpoint and count correction;
the original four-failure log summary does not enumerate that final interrupted
image. The public Avatar root and original UserAvatar parameter-format hunk stay
unchanged; use the actual d22e Before source rather than a HEAD format variant.
No new matching matrix closes historical pixel OPENs or inline negative contracts.

The existing Browser Preview sweep inherits its configured base URL in every
fresh context. Static builds use production React, so story input helpers must
not call `React.act`; dispatch the native input boundary, allow the controlled
value to commit, submit and await each scenario's actual result. Keep original
failed story runs distinct from corrected Before/After acceptance.

A repair's immediate Before may already contain a migration bug. Keep that
Before→Final witness, but establish restoration against a separately built,
hash-identified original-source reference. A matching buggy layout screenshot
cannot certify an isolated card's selected palette. Compare actual element
colours, local spacing and unchanged outer-root values with the reference.

Spinner motion probes pause the actual infinite wrapper animation at 400ms of
its 900ms cycle with screenshots allowing animations. Reduced-motion profiles
assert the app's actual shortened duration; they do not require the normal-motion
value. Record DPR, SVG attributes, computed dimensions and same-instance updates. Newly introduced dynamic inline
variables are expected source differences; preserve them separately from exact
ordinary CSS/pseudo fields and PNG comparisons. Read-only saving textareas and
disabled action buttons are different states and need their actual contracts.
Long-label reconnect fixtures can clip the loading mark outside their narrow
column. Record that limit and use the separate visible production-controls branch
for coverage. Monaco readiness must account for scrollbar visibility classes and
actual transitions: an opacity snapshot alone can precede the screenshot's
animation endpoint. Preserve failed gates and original changed frames when
collecting a matrix with corrected readiness.

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

Literal class arrays joined with one space are supported, optionally through an
exact `.filter(Boolean)`. Other join separators, arbitrary filters and array
variables remain unresolved. Verify this boundary with
`node --test scripts/tailwind-usage.test.mjs` from this package; it runs the actual
scanner and locked Tailwind compiler on synthetic JSX. Compare both sources with
the same scanner when correcting an earlier undercount.

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
move the pointer, or assert visible/hidden/enabled/disabled state. `clickPoint` reads
the actual target box and sends a real pointer click at its centre. It covers a
pointer-transparent mirror over a textarea without dispatching a synthetic event
or forcing the mirror to accept input. States execute
in sequence after a fresh story load. Move the pointer away before a keyboard
peek so a hovering pointer cannot satisfy the intended keyboard condition.

`create-targets.json`, `notification-targets.json` and `join-targets.json` are
supplemental profiles used to replace invalid legacy captures with verified
original-component frames. Before-source copies and per-frame origins stay in
the local evidence; no recreated or generated image serves as a baseline.

To combine independent profiles, give each its own capture phase and assemble
them. A later capture may become part of the accepted matrix after its actual
source, readiness and interaction are verified. It does not automatically close
the original failure or difference; source manifests retain both origins and
the remaining uncertainty:

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

## Frozen continuation reports

Run each shipped UI output in its real browser entry point. Storybook success does
not establish that a generated single-file viewer contains its extracted styles.
The helper's offline browser run exposed missing StyleX CSS despite a successful
build. Compare complete target records even when the PNG is identical: navigation
can move the incorrect target outside the viewport. The implementation and build
ordering belong to [the helper build guide](../../../code-review-helper/standalone-build.md).

| Local report                                   | Accepted source scope                                                                                                                                         | Formal visual result                                                                          | Separate boundaries                                                                                                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `artifacts/visual/leaves55-59-acceptance.html` | 18 utilities in six product files: private margin/offsets, native dark options, pinned-message layout and usage-share Header                                  | 164/164 original PNG pairs exact; 26,232 full recorded layout records equal                   | 58: deferred, 0 accepted; 60: rejected, 0 accepted; 16 retained candidate pairs and 4 original batch 59 failed images outside formal acceptance                                                                                |
| `artifacts/visual/leaves60-63-acceptance.html` | Eight utilities in six files: notification ink, popup dimensions/overflow and native dark maps                                                                | 132/134 PNG pairs exact; two OPEN, 43 raw pixels; 14 hidden-helper height records retained    | Partial acceptance; 60 rejected, six phone Role failures, inline-token negative controls and all historical OPENs remain                                                                                                       |
| `artifacts/visual/leaves64-67-acceptance.html` | 22 utilities in eight files: redundant Select widths, private archive fill and fixed control layout                                                           | 191/192 PNG pairs exact; 48,356 full standard records equal                                   | One 11-pixel OPEN, a separate four-node y−4px native OPEN, rejected theme-reset candidates and inline-token negatives retained                                                                                                 |
| `artifacts/visual/leaves68-71-acceptance.html` | 18 utilities in eight product files: modal/popup geometry, opt-in full-width Drawer and Tooltip padding                                                       | 200/208 product PNG pairs exact; 10,248 full standard records equal; fixture20 pairs separate | Eight corner OPENs, two original normal-motion OPENs, three proven wrong-pose captures and all known negative controls retained                                                                                                |
| `artifacts/visual/leaves72-73-acceptance.html` | 12 utilities in six files: exact local title typography and closed command backdrop/layout                                                                    | 111/112 PNG pairs exact; 9,748 full standard records equal                                    | Original429raw/0thresholdOPEN retained; rejected fallback/descendant-token candidates, known negatives and legacy-label correction explicit                                                                                    |
| `artifacts/visual/leaves74-78-acceptance.html` | 35 utilities in 16 sources plus the Button typography API owner: Tooltip values, edge handles and DiffNotice header                                           | 305/310 PNG pairs exact; 30,303 full standard records equal                                   | Five formal OPENs/13 raw pixels, two supplemental sidebar OPENs/882 raw pixels, rejected CSS-wide semantics, original failures and four Electron After-only images retained                                                    |
| `artifacts/visual/leaves79-81-acceptance.html` | 18 utilities in five sources: composer resize/hint, private DiffViewer header and fixed Field labels                                                          | 292/296 PNG pairs exact; 14,056 full standard records equal                                   | Four formal OPENs/1,075 raw pixels, one native OPEN/22 raw pixels, same-element negatives, unpainted calibration and unknown final native process closure retained                                                             |
| `artifacts/visual/leaves82-84-acceptance.html` | 15 utilities in seven sources: opt-in solid Button, fixed tab/menu typography and actual Stack Drawer width                                                   | 305/306 PNG pairs exact; 12,854 full standard records equal                                   | One original formal OPEN/10 raw/7 threshold pixels, inline-token/width negatives, wrong-theme and keyboard failures, partial native recovery and four Electron After-only images retained                                      |
| `artifacts/visual/leaves85-88-acceptance.html` | 23 utilities in 19 sources: actual hidden-name owners, fixed Card title type and annotation Textareas                                                         | 284/284 PNG pairs exact; 12,554 full standard records equal                                   | 76 supplemental pairs including 16 known token negatives; 87 retained unpaired images; original Stack missing-description relation remains OPEN; 89 audit earns zero migration credit                                          |
| `artifacts/visual/leaves90-93-acceptance.html` | Eight source utilities removed in eight product files; six runtime helper applications migrate separately; shared Header owner and type export are additional | 164/164 formal PNG pairs exact; 8,068 full standard records equal                             | Original 92 three OPENs/5,602 raw/5,534 threshold pixels and 93 native OPEN/473 raw/402 threshold pixels remain; font writer rejection, token negatives, 91 unpaired images and four actual Electron After-only pages retained |
| `artifacts/visual/leaves94-95-acceptance.html` | Fifteen utilities in four app consumers, one app xs owner and two shared ring-owner sources: Skeleton ring and exact Avatar sizes                             | 152/152 formal PNG pairs exact; 27,218 complete standard records equal                        | 60 supplementary pairs include ten known token-priority negatives; twelve Gallery After-only states and two original calibration checkpoints remain separate; full regression remains through93 only                           |
| `artifacts/visual/leaves97-acceptance.html`    | Two private MobileHome sheets adopt the existing legacy Drawer safe-area padding owner                                                                        | 60/64 formal PNG pairs exact; 5,704 standard records equal                                    | Four original Header OPENs/78 raw/2 threshold pixels remain; 48 supplementary pairs include caller negatives and bounded diagnostics; 94 original Before-only images remain separate                                           |
| `artifacts/visual/leaves96-98-acceptance.html` | Independent code-review-helper pipeline: 59 utilities in one Renderer across findings and reference chips                                                     | 125/128 formal PNG pairs exact; 66,536 standard records equal                                 | Seven original raster OPENs/187 raw/0 threshold remain. Eight fixed real offline single-file pairs match complete PNG/style/geometry; the original missing-CSS outputs and twelve original run images are retained             |
| `artifacts/visual/leaves99-acceptance.html`    | Four fixed Rename Textarea utilities adopt existing owner tokens, resize and layout APIs; ref-owned height/overflow remain                                    | 109/110 formal PNG pairs exact; 2,848 standard records equal                                  | Original pending/Escape OPEN/5,932 raw/0 threshold remains; 24 native and eight normal-motion pairs match; token negatives, browser controls, 17 failed frames and 44 existing 320px clipped states are retained               |

| `artifacts/visual/leaves100-acceptance.html` | Twenty private helper severity-map color utilities across actual badges and inline markers | 80/80 formal PNG pairs exact; 44,560 full standard records equal | Six standalone pairs match; four original native OPENs/130 raw/0 threshold pixels remain; matching normal/coarse/full-panel controls do not establish their cause |

| `artifacts/visual/leaves101-102-acceptance.html` | 49 private GroupSection utilities and 27 local Alert owner utilities; actual monospace, local colors and CVA selector preserved | 76/92 formal PNG pairs exact; 24,255 standard records equal | 16 formal OPENs/75 raw plus five native OPENs/22 raw; initial ten record mismatches and compiler/fallback/theme failures retained. No 101 standalone pair was captured; two final file images are After-only |

| `artifacts/visual/leaves103-105-acceptance.html` | 114 Renderer utility migrations; 54 additional occurrences removed only as unused-module cleanup | 153/156 formal PNG pairs exact; 73,555 complete standard records equal | Three formal OPENs/17 raw plus one native OPEN/17 raw/one threshold; font fallback rejection and caret/readiness failures retained. The same old 104 environment proves only the cleanup delta |
| `artifacts/visual/leaves104-106-acceptance.html` | 86 ordinary-runtime mappings in four local control owners; zero source deletion; original Slot and exported class selectors retained | 194 current PNG pairs and complete records exact, including 98 formal/1,476 standard records | Two rejected Slot candidates and four failed images retained; actual phone CommitRow Tooltip remains NOT_ACCEPTED. Fourteen old positive pairs are historical only |

| `artifacts/visual/leaves107-acceptance.html` | 182 FileTree/commit utilities migrate; 27 unreachable EmptyThread occurrences are cleanup only | 108/136 formal PNG pairs exact; 66,456 standard records equal; native30 and file10 exact | 28 formal OPENs/7,795 raw plus one normal-motion raw pixel remain. Actual body-absence readiness replaces two rejected cells; phone offline tooltip remains offscreen |

| `artifacts/visual/leaves108-109-acceptance.html` | 78 private diff/context utilities; six normal Separator mappings/source removal0, legal Slot retained | 84/128 formal PNG pairs exact; 40,078 standard records equal; 204 pairs total/158exact | 46 OPENs/347raw/135 informational threshold; nativeAfter and file109 finalization unknown. Four transition gates and six selector failures retained; Sidebar context images are After-only |

| `artifacts/visual/leaves110-acceptance.html` | Eleven normal SidebarMenuButton layout mappings; source303 retained for legal Slot/nonempty className callers, single CVA graph | 64/64 formal PNG pairs /3,836 records and24/24 native /600 nodes exact;240 actual component-output cases | Two original hover-occlusion failures retained; task-only Git blob excludes the protected Tooltip whitespace. Isolated visual module evidence does not validate the25 unrelated user paths omitted from that tree |

| `artifacts/visual/leaves111-112-acceptance.html` | 164 private shell/navigation and element-local literal-font utilities | 201 accepted pairs/185 exact; 133 formal/44,522 equal records; two whole-renderer font pairs separate | 16 OPENs/119 raw/24 informational threshold; two new-private-writer negatives and original UNKNOWN closure remain separate |
| `artifacts/visual/leaves113-acceptance.html` | 25 ordinary Sidebar layout mappings; source removal0, original caller/Slot paths retained | 114 PNG pairs and full records exact:76 formal/3,480 records+38 native/912 nodes | Six original pointer-occlusion paths remain NOT_ACCEPTED; keyboard success does not close them |
| `artifacts/visual/leaves114-115-acceptance.html` | 44 guarded SidebarMenu mappings and27 private Markdown/diagnostic utilities; exact reverse registration/fallback preserved | 258 current pairs/247 exact;184 formal/31,884 records equal | 11 OPENs/254 raw/12 informational threshold; six rejected pruning pairs and all old variants separate |

The self-contained report keeps the original images and per-frame immutable build
origins. Computed-only 55/56/57/59 probes add no PNG pairs. Keep SessionPin's actual
flex-shrink counterexample, exact dark/light-exclusion and coarse/focus conditions,
local spacing/border writers, RTL physical-right padding and the opaque border-color
fallback visible to reviewers. Calendar's protected user formatting is outside the
task-only patch. Local selector scopes do not establish a whole application palette;
phone initial-preview visibility and native/backend/export behavior remain bounded.

The current scanner-v2 three-root timeline covers
`packages/components/src/{components,ui,routes}` through batch 99:
1,424 occurrences /157 files /725 unresolved expressions: 990 component, 429 legacy
UI and five route occurrences. The source snapshot and method are recorded in
`inventory-source-through99-proof.json`. Through 95 remains frozen at
1,430/157/725; batches 97 and 99 account for the six source utilities removed
within these roots. The exact-root through110 snapshot differs only at Sidebar:
1,424 occurrences/157used files/726 unresolved expressions. Its extra unresolved
entry is a known StyleX class-map alias lookup. The isolated visual tree's25
pre-existing user-file differences are listed in
`leaves110-build-root-boundary-audit.json`; see
`inventory-source-through110-proof.json` for the separate static-root boundary.
Batches 94–95 remove fifteen source utilities. Through 93 remains frozen at
1,445/157/725: that group removes eight source utilities while exposing two existing
margin literals inside runtime helper calls, a net decrease of six. Its six
runtime utility applications earn no extra source-deletion credit. Through 88
remains 1,451/159/726, through 84 is 1,474/163/726, through 81 is 1,489/163/724,
and through 78 is 1,507/163/718.

The broader package-src scan is historical through 93, not refreshed through 99:
`packages/components/src`, excluding `stories`, has 1,454 occurrences /159 files
/729 unresolved expressions across 1,396 scanned files. Its additional lib/hooks
boundary is nine occurrences in two files and four unresolved expressions.
Compare it with the earlier full scan of the same package path, 1,460/161/730;
it does not cover every package or Tailwind host. Keep this separate from the
three-root timeline. The through93 manual audit separately retains sixteen
unconsumed skip-link literals, three touch-helper literals and four opaque caller
arguments after batch 92; its older six-argument audit is unchanged. The independent
helper batches 96, 98, 100, 101 and 102 remove 155 selected-source utilities without
reducing this component inventory. Its separate through102 source snapshot validates
32 production JS/TS files against the successful build and uses its actual CSS entry
with the same v2 AST rules: 1,075 occurrences/ten files/26 unresolved expressions.
The historical through102 snapshot excludes stories, tests and later work; see
`inventory-helper-source-through102-proof.json`. The exact successful-build snapshot
through107 separately validates thirty production files: 698 occurrences/eight
used files/18 unresolved expressions, including 519 in ReviewRenderer. See
`inventory-helper-source-through107-proof.json`. Its decrease of 377 separates
296 migrations from 81 unused/unreachable cleanup occurrences; 104/106's 86 normal
runtime mappings delete no source literals. The exact successful-build snapshot
through 109 has 620 occurrences/eight used files/18 unresolved expressions across
thirty production files, including 441 in ReviewRenderer. Its 78-source decrease is
migration; 108's six normal-runtime mappings delete no literals. See
`inventory-helper-source-through109-proof.json`. The exact through115 snapshot
freezes thirty production hashes and the successful final stylesheet:434 occurrences/
eight files/21 unresolved, including255 in ReviewRenderer. Through112 remains456/8/18;
115 removes22 scanner occurrences plus five manually audited default-parameter
utilities outside the v2 lower bound. Three new unresolved entries are private StyleX
blockClassName references. See `inventory-helper-source-through115-proof.json`;
later117/119 and all stories/tests are excluded. The historical through100 bound
remains 1,151/ten/26; the two units remove exactly 76. Any later application
batch requires a fresh source-frozen inventory before advancing the through99
timeline. These static lower
bounds are not completion percentages.

The 94–95 report embeds every original screenshot and ten labelled masks derived
from real raw RGBA differences. Its 152 formal pairs all match; known Avatar
same-element token-input negatives are separate. An original Gallery gate failure
and a rejected report phone layout remain reviewable. Two actual Chrome QA cycles
verify 203 unique original payloads, their previews, filtering, original-size
keyboard/pointer zoom and 1280/390px layouts. The index now links 67 frozen reports through131 and explicitly withdraws the
111 unsafe Sidebar runtime mappings in110/113/114/116/120. Correction127 restores
32 original PNG/full-record pairs; old reports keep their original hashes. New
successful subsets do not close historical OPENs. Two real Chrome cycles verify
index search, relative links and 1280/390px layouts.

The 60–63 report keeps the explicit 48+16 notification Before assembly and its
distinct harness identities. Retain raw xterm helper records and original corner
pixels; later matching controls establish no historical raster cause. CSS-only
checks, wheel PNG supplements and terminal After-only inspection have separate
counters. The scope table scrolls locally on narrow screens; offline QA verifies
original payloads, previews, filtering, zoom and keyboard access at 1280/390px.

The 64–67 report separates default-theme success from parent-token acceptance.
Actual Before / Rejected / Final images retain the repaired material contract.
Inspect emitted full-build rules and non-target tokens: direct public-token atoms
avoid a default group, while an existing same-element theme needs one complete
compiler-local map. See [`MIGRATION.md`](../../src/style/MIGRATION.md). Ordinary
imported maps in fixtures need this audit too; source completeness proves no
emitted inheritance. The private Button fixture correction separately verifies
20 unchanged real pairs and all 27 emitted declarations (18 inherited); two older
message-action fixture helpers remain pending. Supplementary geometry, negative
controls and original pixel OPENs remain separate from formal counts. The later
through71 source-stable full suite and four actual Electron After-only screenshots
are recorded in `artifacts/visual/leaves71-stable-full-regression-verification.json`;
they do not replace any report's original source or application Before baseline.

The 74–78 report separates formal acceptance from 140 supplemental/rejected pairs
and 27 actual diagnostic/After-only images. The initial Button candidate has sixty
matching ordinary screenshot pairs but fails real CSS-wide and variable-fallback
semantics; it remains rejected. The final owner uses two bounded physical font
fields and preserves defaults. The four corrected batch 77 cells require real
trigger hover/hit state or completed Monaco registry/model/rendered tokens; their
new origins do not replace the five original corner OPENs. Batch 78 retains its
dark border utility because the complete compiler proves a public direct-child
winner would otherwise change. Native timeouts and actual module-fetch failures
retain separate evidence and unresolved causes. The through 78 source-stable
components/UI suites, desktop rebuild and four actual Electron After-only images
are recorded in `artifacts/visual/leaves78-stable-full-regression-verification.json`;
they do not close historical pixel differences or establish a full-app Before.

The 79–81 report separates 296 formal pairs from 91 supplemental/negative/calibration
pairs and nine actual diagnostic images. Composer ancestor conditions preserve
both matching and complete-build specificity; the private same-element opacity
utility negative still exposes a layer boundary. DiffViewer keeps the original
shrinking glyph and dark border winner. Field labels use existing atoms only at
fixed plain-text sites, with six real inline-token negatives retained. Original
offscreen native label frames are calibration; the focused recovery states have
explicit new origins and paint/hit checks. Batch 81 saves all 24 per-side focused
frame checkpoints, but the final label-click assertion and process closure remain
unknown after a verified self-owned process stop. A completed image matrix does
not prove that complete behavioral run. The report's original pixel differences
remain open despite matching bounded controls. Batch 80's old `UI84` aggregate
key is corrected by a separate count proof: its manifests contain 85 source entries,
and the original source locks are unchanged.

The 82–84 report separates 306 formal pairs from 69 supplemental pairs and 41
unpaired real images. The opt-in solid Button changes only existing pigments;
legacy shadow/transition/active classes remain on actual Send/Stop templates.
Fixed Tabs preserve logical padding-inline; four separate vertical-rl pairs verify
the nonzero logical axis without claiming whole-product vertical layout support.
The actual Stack fixture renders real SessionDetail loading and ChatLanding; it
bypasses workspace-ready admission and does not cover the four inner drawers.
Original theme and keyboard-gate failures remain alongside corrected captures.
Batch 84 preserves two healthy native Before checkpoints and a distinct missing-only
recovery; its original Escape timeout has no contemporaneous target/error image,
so the bounded focus-delivery control does not establish its exact cause. The single
original batch 82 pixel OPEN remains open despite five matching later controls.
The source-stable through 84 components/UI suites, desktop build and four real
Electron After-only images are in
`artifacts/visual/leaves84-stable-full-regression-verification.json`; they do not
supply an original Tailwind full-app baseline or prove agent/backend dispatch.

The 85–88 report separates hidden-name ownership from context and accessibility
validity. UIDialog, actual Vaul and Popover retain their original contexts; the
Dialog title clears its logical close-control inset as well as physical padding.
The Stack's pre-existing dangling description relation remains open on both sides.
Card titles use existing local size/leading tokens at fixed plain-text sites;
Textarea fonts use the existing physical style fields. Actual local values,
placeholder fields and same-element token negatives stay separate. Original
portal-root/span/global-heading gates, native screenshot caret effects and the
rejected import-shadow source remain reviewable without fabricated images.
The earlier native Textarea matrix lacks placeholder fields and contributes only
its sixteen actual Before-only PNGs. Gallery samples are After-only. Through84's
full suite/Electron evidence is historical, not a through88 full-regression claim.

The 90–93 report preserves all 40 earlier report hashes and keeps their history
table collapsed by default. Its 136 supplementary pairs include 118 byte-exact
pairs and 18 non-exact pairs; this is not an OPEN-issue count because it includes
known negatives, rejected candidates and controls using unchanged source. The 91
unpaired images include readiness failures, invalid premature captures and four
actual Electron pages. The original 92 hover trigger and 93 Header raster trigger
remain unproven. Through 93, the stable full run passes 620 component files /6,208
tests, 25 UI files /312 tests and the actual Electron build/smoke. The 78 existing
styleq warnings remain, and root `pnpm check` is not claimed PASS because of the
existing ACP SDK prerequisite failure. Batch 94 and other Tailwind hosts are
outside that validation boundary.

## Current corrected boundary

The public Sidebar's empty-caller guard did not isolate ancestor utility precedence.
Batch127 restores the actual Before110 cascade; no source-removal credit is claimed.
The earlier bounded reports remain historical evidence, with their runtime migration
credit withdrawn. The exact fixed core inventory at132 is1,399 occurrences /157 used files /
726 unresolved expressions across790 production sources. It includes130/131 and
DEV125, excludes133/134, and matches the stable full-suite and actual renderer
build graphs. See `artifacts/visual/inventory-source-through132-proof.json`;
this is not a percentage or a claim of production visual coverage. Helper's
independent through129 cut is392/8/21 from30 sources matched to its successful
293-input build;14 migrated utilities and one cleanup explain the15 decrease.

| Report                          | Accepted scope                                                                                | Remaining limits                                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `leaves117-119-acceptance.html` | 27 annotation utilities;54 positive pairs                                                     | 15 raster OPENs;119 Checkbox rejected                                                                                              |
| `leaves118-acceptance.html`     | 10 fixed Input/Tooltip utilities;56 exact positive pairs                                      | Two radius utilities retained; six direct token negatives; old12 candidate rejected                                                |
| `leaves123-acceptance.html`     | No accepted migration                                                                         | Offscreen color/partial capture failure; source restored                                                                           |
| `leaves124-acceptance.html`     | Two dimensions in real Electron navigation;18 complete records match                          | Two target PNG OPENs; context is supplemental, not extra pairs                                                                     |
| `leaves125-acceptance.html`     | Two dimensions in actual DEV email branch;22 exact pairs                                      | No production branch coverage                                                                                                      |
| `leaves126-acceptance.html`     | No accepted migration                                                                         | Inherited typography/scroll geometry failure; source restored                                                                      |
| `leaves127-acceptance.html`     | 32 exact restoration pairs/752 full nodes                                                     | Withdraws111 runtime mappings; old OPENs remain                                                                                    |
| `leaves128-acceptance.html`     | Six private glyph ink utilities;68 exact pairs including4 normal                              | Two intentional token carriers differ; four direct token negatives                                                                 |
| `leaves129-acceptance.html`     | 14 real error-fallback utilities;26 exact primary pairs                                       | One recovery OPEN; caught React errors expected; one redundant cleanup separate                                                    |
| `leaves130-acceptance.html`     | Three private identity-button gap/align utilities;66 complete record pairs                    | One target crop OPEN/10 raw;two direct gap-token negatives;two backgrounds retained                                                |
| `leaves131-acceptance.html`     | Two fixed plain-text ink utilities;76 exact positive pairs                                    | Four token negatives; four normal frames have interrupted cleanup                                                                  |
| `leaves132-acceptance.html`     | Six real Sidebar ancestor regressions;12 positive image comparisons/click paths               | Historical unsafe6 rejected;no exhaustive CSS claim;locked runtime/setup failures retained                                         |
| `leaves133-acceptance.html`     | Two private Description/QR label utilities;32 cells/64 target views and32 context views exact | Four direct token negatives;original leading writer retained;physical font-normal remains                                          |
| `leaves134-acceptance.html`     | 19 private commit focus/transition utilities;44 formal/43 exact;final closed-portal8 exact    | Original native8 geometry failures and warm8 portal-state mismatches remain;three pixel OPENs;raw comma-space differences explicit |
| `leaves135-acceptance.html`     | Zero migration;one retained p-0 compatibility class                                           | Eight DOM diagnostics,including four legal zero-ancestor counterexamples;not a built After migration                               |
| `leaves136-acceptance.html`     | 13 native tree controls;36 formal/35 exact and34 native/15 exact;file10 exact                 | 20 target OPENs197raw;navigation OPEN11423raw/157threshold;bounded sidebar diagnostic does not close it                            |
| `leaves137-acceptance.html`     | Three private summary/Spinner colors;30 positive target/context pairs exact                   | Four direct-token negatives;sharing is an existing capability fixture,not OSS cloud coverage                                       |
| `leaves138-acceptance.html`     | Nine native helper utilities; formal48/47 exact                                               | Group-hover candidates restored; native/file raster OPENs retained                                                                 |
| `leaves139-acceptance.html`     | Three fixed primary label utilities;180 completed positive pairs exact                        | Secondary six restored after coarse-hover background failure; normal cleanup incomplete                                            |
| `leaves140-acceptance.html`     | Two private merge-button spacing utilities;60 exact positive pairs                            | Static background/ink compatibility retained;self-dark counterexample and held-touch gaps                                          |
| `leaves141-acceptance.html`     | Six secondary ink utilities;284 pairs282 exact,216 API After-only frames                      | Default-owner two OPENs347raw/82threshold;360 inline carriers explicitly differ                                                    |
| `leaves142-acceptance.html`     | Eight helper utilities;55 formal exact,134 total108 exact                                     | Exact fractional-rem predicate required;26 OPENs262raw/52threshold;cleanup separate                                                |
| `leaves143-acceptance.html`     | Thirteen helper Button caller utilities;210 pairs204 exact                                    | Six OPENs387raw/143threshold;raw selector and Slot contract separate;invalid prior menu captures retained                          |
| `leaves144-acceptance.html`     | One private Drawer gap;24 positive cells/24 target+24 context views/580 full records exact    | Real safe-area and vertical-writing failures retain three compatibility classes;body portal scope                                  |
| `leaves145-acceptance.html`     | Two source ink utilities/five runtime uses;144 pairs143 exact                                 | One SVG OPEN4raw;rejected touch captures and persistence gaps remain                                                               |
| `leaves146-acceptance.html`     | One real Electron navigation ink;24 positive cells/336 captured records                       | Three target and three context raster OPENs;576 boot-variable raw differences;original wide build gate FAIL retained               |
| `leaves147-acceptance.html`     | Seven Goal/CI occurrences;162 PNG pairs exact,24 callbacks equal                              | Portal-container CSS capture gap;precise1008carriers;newlint warning;oldclassassertion failure retained                            |
| `leaves148-acceptance.html`     | Four shadow/outline occurrences;86 pairs78exact                                               | Eight forced-color OPENs356/52;shadow lexical carriers;no-probe registration check                                                 |
| `leaves149-acceptance.html`     | Zero migration;6 classes retained                                                             | 12 actual Icon/Stream caller counterexamples;8controls;DOM-only calibration,coarse failure retained                                |
| `leaves150-acceptance.html`     | Zero migration;9 layouts retained                                                             | 18 controls and20 caller counterexamples;6 equal PNGs still fail CSS fields                                                        |
| `leaves151-acceptance.html`     | Four rotate occurrences;112 pairs103exact,448 full records same                               | Nine OPENs874/2;settled screenshots and56events,not animation-frame equality                                                       |
| `leaves152-acceptance.html`     | Five occurrences+two separate cleanups;126 pairs117exact                                      | Nine OPENs69/15;unpainted zero-size boundaries and original partial/failure evidence                                               |
| `leaves153-acceptance.html`     | One Cancel ink occurrence;90 positive/reference pairs77exact                                  | Thirteen OPENs58/0;translate restored after writer counterexample;private-var negatives separate                                   |
| `leaves154-acceptance.html`     | Zero migration;Progress2classes retained                                                      | Four real public Sidebar regressions;38 matching pairs do not accept them                                                          |
| `leaves155-acceptance.html`     | One physical margin+one separate cleanup;128 pairs115exact                                    | Thirteen OPENs44/15;explicit idle-ready replacements,originalCopied frames preserved                                               |
| `leaves156-acceptance.html`     | Zero migration;isolated proposed extraction research                                          | Native thirteen pass under early flat routing;Slot/query/collision counterexamples prevent universal adoption                      |
| `leaves157-acceptance.html`     | Zero migration;Outline p3 retained                                                            | Three named-host caller regressions and one12pixel context OPEN;320suppressed Rail is not a missed popup                           |

Root independently reopens original compressed records and decodes PNG RGBA.
Named carrier exceptions retain both raw values; they never establish whole-object
equality. The fixed146 regression passes620 files/6,209 tests with3,200 recorded
inputs unchanged. Its790 scanner source hashes match the actual renderer and yield
1,379/156/727; visual OPENs remain separate. The original wide build gate stays FAIL
because the guide changed between builds. The qualified product gate excludes only
that proven unconsumed Markdown file; emitted external and inline CSS equality is
measured directly. New UI owner141 independently passes25 files/313 tests and types
with its four owner files hash-locked, without a fresh whole-UI-graph stability claim.

Earlier132 renderer inputs first hit the default4GB heap limit and then built
successfully with8GB; retain both attempts. Its four real Electron pages are
After-only, separate from the actual124/146 paired target captures. All335 verified
main/CLI/lock artifacts remain unchanged. The root check remains blocked at the
existing ACP SDK prerequisite; no backend/submodule workaround is included.

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
