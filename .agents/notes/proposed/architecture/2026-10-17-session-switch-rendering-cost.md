# Session switching costs and initial history readiness

Status: proposed
Translation: current

[中文](2026-10-17-session-switch-rendering-cost.zh.md)

## Abstract

Real browser measurements separate synchronous session-switch work from waiting for readable history: 24 switches include 104–314 ms click-to-paint durations, while separate visual sampling shows one first-observed conversation remaining a skeleton until about four seconds. The implemented correction removes an unnecessary owner round trip when an initial Roost page advances its own observation epoch. Deterministic production-reader regressions and a controlled browser comparison verify that dependency; normal cold/cache-hit controls show little change. Broader rendering changes remain proposed, and neither the correction nor the recorded 10.84-second content candidate establishes the cause or elimination of the hosted page's multi-second wait.

## Scope and responsibilities

The user requested a session-switch audit followed by a small optimization of the largest demonstrated cost. Synthetic measurements and the first implementation use checkout `4cc74cae8` with its existing unrelated working-tree changes. Browser recordings use already-open hosted pages in Chrome 155; their deployed revisions are unknown. The PR ports only the initial-page correction to main `450595e07`, retaining its incremental history and cold-open supersession recovery.

The renderer bridge owns owner reads, a read-only IndexedDB projection and notification ordering. ConversationView owns the directory and leased bodies; React and the scroll engine own the displayed window. Owner acceptance, durable checkpoint coverage and commands remain separate responsibilities. Intent: [history display reads](../../../../specs/session-history-writes.md#backend-selection-and-display-reads). The later main-line [incremental recovery decision](../../implemented/bug-fix/2026-10-16-roost-incremental-history.md) supersedes the earlier full-refresh investigation; the old audit must not be used to report those already-fixed mechanisms as new bugs.

Only anonymized aggregate measurements belong here. Private transcripts, original traces and screenshots stay outside the repository; all regression and browser-lab history is synthetic.

## Evidence that determines priority

Four native-controlled Chrome Performance recordings cover 24 actual sidebar clicks across two hosted workloads, without reload, storage clearing or artificial CPU/network throttling. DevTools is undocked to preserve page width; JavaScript sampling and screenshots are enabled. Recording overhead and the small sample prevent percentile or device-wide claims.

| Workload / endpoint                         | Observed result                                                                        | Interpretation                                                      |
| ------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| First workload, formula-heavy repeat visits | 191–262 ms click to next paint; handlers 167–214 ms                                    | Synchronous work is visible even with warm data.                    |
| Slower workload, ten repeat visits          | 184–314 ms click to next paint                                                         | Repeat switching has a separate responsiveness cost.                |
| Three first-observed targets                | Last soft-navigation content candidates at 1.36–1.57 s                                 | First paint is not complete readable-content readiness.             |
| One other first-observed target             | Last content candidate 10.84 s; handler about 124 ms                                   | The late metric alone does not locate the first readable frame.     |
| Independent continuous visual sample        | Skeleton at 3.866–4.105 s; readable messages in the next 4.106–4.320 s capture bracket | One observed open has a real user-visible wait around four seconds. |

The 10.84-second case has about 8.5 seconds sampled as main-thread idle in an 8.9-second interval after bootstrap. Late history-cache callbacks precede a 168.6 ms main-thread task. Eighty `readTurn` success callbacks concentrate near the end; they do not span the preceding idle gap. Neither ten seconds of Markdown CPU nor eighty serial slow IndexedDB reads is established. Owner execution, transport and readiness waits need correlated operation evidence.

The recording's screenshot budget was exhausted before that interaction, so it cannot reconstruct its first readable frame. A later return already has readable content in the first screenshot bracket ending at 2.073 s; that is an upper bound for a different warm visit. Another visual run has an accessibility-snapshot sampling gap and cannot narrow its first-readable time. These observations must not be combined into one latency estimate.

One 214 ms handler contains about 168 ms of inclusive React sync-flush samples, about 21 ms through Markdown/KaTeX parsing, and about 32 ms through scroll `afterCommit`. These paths overlap and cannot be added or assigned to one component. Its real outline contains 13 ticks. A different first open samples about 102 ms in SDK `loadDoc`, including import/export CPU; that is not an I/O latency measurement.

An isolated production Storybook ablation demonstrates another workload-specific cost: two warm 3,000-entry transcripts have 1,500 outline ticks each. Removing the rail changes median subtree-remount readiness from 71.1 to 14.9 ms, and 281.5 to 58.9 ms at CPU ×4; DOM nodes fall from 5,437 to 932. This excludes route/store/document preparation and does not explain the hosted formula case or asynchronous wait.

Production-hook probes open 40 bodies for the stream, while complete fact consumers eventually cover all 3,000 bodies through 75 reverse pages. Warm remounts read no new bodies but still perform history-sized index walks. These are scaling candidates, not proof that every hidden consumer blocks first paint.

## Implemented initial-page correction

The legacy/non-checkpoint initializer records `observedDirectoryEpoch`, reads a latest page, drains notifications and retries if the epoch changed. A validated owner response can itself advance that epoch through `notifyChanged` or first-owner discovery. When a stale coherent disk snapshot cannot serve the newer observation, treating that self-generated notification as invalidation requests the owner again before returning the already-validated page.

The correction returns the page with its appropriate epoch fence:

```text
cached page -> retain the epoch from before reading
ordinary owner page -> use the post-read epoch only while its revision is current
coherent incremental checkpoint -> retain main's ability to progress behind newer hints
drain notifications -> return if the captured directory epoch still matches
```

Later structural notifications still require retry, and ordinary superseded responses keep main's existing retry path. A page with a negotiated coherent checkpoint is not forced to catch up to every newer control hint before becoming readable. Cursor compatibility, cache acceptance and atomic replacement are retained; no partial replacement is published as complete and no command gains another acceptance path.

Tests use the real bridge/cache and composed ConversationView with fake IndexedDB and explicit Promise gates. A revision-1 tail cache remains while an uncached read observes owner revision 3 and the first latest page reports revision 5. Before the correction, holding the duplicate latest request prevents initial readiness; afterward, both reader and production view expose the validated page and current tail without that wait. Concurrent control advancement covers legacy retry to fresh content and coherent incremental progress behind newer hints.

Lifecycle assessment: an observation starts the initial waiter; the bridge retains ownership of shared requests, cache and notification queue. Releasing one observer does not cancel another consumer's raw work; disposal retains its existing publication fence. Handoff is a validated page plus its directory epoch, and genuine read failures keep existing recovery. The patch adds result metadata, not a new resource, retry owner or confirmation wait. A native Effect migration is deferred because the transport, cache and notification orchestration remain unfinished Promise dependencies; wrapping this waiter alone would not complete their lifecycle unit. No migration-ledger fact changes.

## Controlled browser comparison

One temporary production Storybook build includes the baseline and corrected bridges from the `4cc74cae8` audit checkout, sharing the remaining build. Each side has an isolated cache/session and 120 synthetic turns. The in-app browser's default 1280 × 720 viewport runs actual IndexedDB, ConversationView, stream hooks, Markdown and scroll engine. Only the owner response and its per-request wait are simulated; this is not a transport or owner-storage benchmark.

Both lanes start after synthetic cache/owner setup completes. A requestAnimationFrame probe observes the expected real Markdown paragraph intersecting the message viewport after initial layout readiness. This is a DOM/layout endpoint before paint. One warm-up pair is excluded; sixteen paired comparisons run without screenshot sampling:

| Initial state           | Injected wait per request | Pairs | Before median first-readable frame | After median first-readable frame |
| ----------------------- | ------------------------: | ----: | ---------------------------------: | --------------------------------: |
| Old cache / newer owner |                    800 ms |     5 |                         1,640.9 ms |                          835.4 ms |
| Old cache / newer owner |                    300 ms |     5 |                           654.5 ms |                          329.2 ms |
| Normal open, no cache   |                    800 ms |     3 |                           858.4 ms |                          844.3 ms |
| Current readable cache  |                    800 ms |     3 |                            31.3 ms |                           36.0 ms |

Affected trials have two latest-page replies before readable text on the baseline and one after the correction. Cold controls have one reply on each side; current-cache controls have none. This supports saving one avoidable round trip in the affected path, not a universal 50% speedup or a meaningful improvement in the controls.

A separate 1,500 ms-delay visual pair records 67 unmodified screenshots. Its DOM/layout endpoints are 3,049.7 and 1,540.4 ms. A screenshot within 2.157–2.255 seconds of the automation click shows the old skeleton beside the corrected readable answer/table. Screenshot brackets include input/preparation overhead; their automation clock does not share the probe's start origin.

The browser build predates the port to current main. It excludes route/runtime/store startup, control-document bootstrap, full SessionChatInterface consumers, real RPC/owner delays and the private hosted workload. The port's deterministic coverage is separate; these results do not measure a new main-line build or establish how much of the hosted four-second wait is removed.

## Deferred work and retained contracts

Prioritize one correlated foreground history operation before adding broad rendering machinery. The source already prefers a coherent local page; the skeleton is an empty-stream fallback and its status timers do not gate an existing message list. Another generic cache-first layer or shorter skeleton timers is not the demonstrated remedy.

For measured long-outline workloads, window the fixed-pitch ticks while preserving navigation, focus, hover previews and jumps. Consider unvisited child-transcript lazy mounting and incremental projections only as independent measured slices, preserving pending-fork readiness and complete business facts. Do not defer SessionDetail's identity boundary: URL, composer and send/archive/rename targets must switch together. Do not uniformly remove `flushSync` or geometry reads; saved anchors, coverage corrections and hidden-to-visible restoration still need correct measurements. Markdown AST caching, worker migration and scroll-engine rewrites remain proposed, not part of this patch.

## Verification and limits

The audit checkout passes the 16-case bridge suite and 102 existing reader/adapter/hook/switch/scroller cases, component type-checking and the narrow production Storybook build. Against main `450595e07`, the focused bridge suite passes 38 cases and the full component suite passes 5,593 tests; root type-checking, lint, Effect lint, non-Electron package tests, i18n and all boundary guards pass. The first `pnpm check` run was stopped while an untouched Electron test imported the missing binary and waited for its download. Re-running the complete Electron suite with `ELECTRON_OVERRIDE_DIST_PATH` pointing to the existing local Electron 44.7.0 installation passes 222 main tests plus 16 custody tests. Root formatting and `git diff --check` pass. `pnpm run docs check` reports six existing links to the uninitialized Kimi/Pi submodules in the older subagent-events note; it reports no protected-topic hash changes. Earlier audit results do not substitute for these current-main checks. Correctness tests use explicit gates and fake clocks rather than wall-clock performance assertions.

Audit artifacts remain outside Git under `/private/tmp/lody-session-switch-audit-20261017-*`, `/private/tmp/lody-live-switch-20261018/`, `/private/tmp/lody-slow-workspace-20261018/`, `/private/tmp/lody-visual-switch-20261018/` and `/private/tmp/lody-initial-page-browser-20261018/`. Private captures must never become fixtures. The last directory's fixture, hashes, aggregate JSON and raw frames are synthetic; local artifacts are supplemental evidence, not remotely accessible review links.

Native Electron, a matching deployed workload, typing readiness, memory retention and exact owner/transport attribution remain unverified for this correction. A later [native Nightly trace investigation](../../implemented/bug-fix/2026-10-20-nightly-session-switch-blocking.md) separately attributes synchronous switching costs to React updates, scroll measurements and semantic routing; it does not benchmark this correction. The broader audit stays proposed even though this bounded correction is implemented.
