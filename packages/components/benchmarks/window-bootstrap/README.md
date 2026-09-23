# Local window bootstrap benchmark

Run from `packages/components`:

```sh
node benchmarks/window-bootstrap/run.mjs 30 > /tmp/window-bootstrap.json
node benchmarks/window-bootstrap/run.mjs 1 --native > /tmp/window-presentation.json
# Requires a built desktop and resources/cli, all from a known revision:
node benchmarks/window-bootstrap/run-app.mjs 5 current > /tmp/window-app.log 2>&1
# Optional fourth argument: conversation rounds (two entries each).
node benchmarks/window-bootstrap/run-app.mjs 5 short 50 > /tmp/window-app-short.log 2>&1
```

Requires components dependencies and Electron. The runner uses two isolated
renderers and a temporary profile, deletes its build/profile afterward, and never
reads product user data. Histories use the existing synthetic conversation fixture.

## Boundaries

The source owns a real Repo and Session document. The receiver exercises production
BroadcastChannel, Web Locks, IndexedDB, CRDT import and the conversation reader
through a lease for its last 30 entries. `before` reproduces cache-only acquisition;
`fixed` uses the current disk-first, live-peer-aware bootstrap. Both use the same
reader. This is a data-path comparison, not two full application builds.

Acquisition starts immediately before cache access. `readableMs` includes import
and history projection; `syncReadyMs` ends once the foreground store can start
normal synchronization. No daemon is contacted. Repo creation, route initialization,
authoritative synchronization, React rendering/layout and paint are excluded. Peer
metadata exchange is concurrent and not separately timed. Both native windows are
hidden with background throttling disabled. Each scenario discards three warmups,
alternates variant order and records the requested sample count without injected
delays. Source hashes accompany results.

`--native` runs the production main presentation and renderer readiness helpers.
It requests a 3,000-entry peer snapshot, projects the last 30 rows into a synthetic
DOM surface, signals readiness after two frames, and checks/captures the first
native `show`. Its `claimToShowMs` begins at `presentWindowTarget`, not at a user
click. The screenshot path is returned in JSON. This verifies hidden preparation
and presentation ordering; it does not validate the full Lody React interface.

## Corrected measurement — 2026-09-23

[Corrected results](results-fixed-2026-09-23.json): 30 samples per variant/scenario/size,
Apple M4 Max, macOS arm64, Electron 39.5.1 / Chromium 142.

| Entries | Disk hit: before / fixed median | Peer only: fixed median | Disk hit: before / fixed P95 |
| --- | --- | --- | --- |
| 100 | 4.20 / 4.50 ms | 4.40 ms | 4.70 / 8.40 ms |
| 1,000 | 16.15 / 16.40 ms | 17.50 ms | 29.00 / 32.60 ms |
| 3,000 | 39.55 / 39.50 ms | 41.80 ms | 71.60 / 60.70 ms |

The table ends at readable history. In the peer-only scenario the baseline has no
history and needs unmeasured daemon synchronization; no overall speedup percentage
is claimed. Disk-hit medians remain approximately equal, without unnecessary peer
exports. Samples are too small to establish a stable tail distribution.

With neither data source available, corrected acquisition takes 0.20 ms median and
the store is ready to synchronize in 0.20–0.30 ms. There is no unconditional peer
response deadline on that path. Live peers explicitly replying that a document is
absent are separately covered by deterministic tests. An inventoried peer that
subsequently stalls or exits still has a 150 ms bounded timeout.

The native probe recorded 152.39 ms from claim to first show. The window was hidden
before content, and its first shown capture contained all 30 projected rows. This
single synthetic sample is not an application opening-time distribution.

## Real desktop verification — 2026-09-23

`run-app.mjs` runs the built desktop with fresh, isolated user data and a short
Unix-socket data directory. It imports the synthetic fixture into the source Repo,
opens it in the real conversation UI, enables the production warm pool, and claims
successive spares through `app.openWindow`. Each spare has at least 1.5 seconds of
preparation before measurement; this lead time is outside the timed interval.
The probe captures each native `show`, checks the matching marker, actual stream
visibility and final synthetic answer, and closes the window normally. Three
warmups are discarded. Logs, screenshots, results and build hashes remain under
the printed `/tmp/lody-app-bench-*` directory; no product profile is used.
Set `PROBE_CPU_PROFILE=1` to retain a Chromium CPU profile for each claim.
The timer starts at `app.windowTarget` dispatch, so it excludes physical input and
source-window IPC dispatch. It includes target React rendering and initial scroll.

[Recorded comparison](results-app-2026-09-23.json) used the same bundled CLI 0.93.3
with current desktop source. Only the runtime-provider change was removed for the
baseline. Runs were sequential with separate fresh profiles, not alternating trials.

| Renderer | Samples | Median claim to show | Range |
| --- | --- | --- | --- |
| Before workspace preinitialization | 5 | 820.30 ms | 812.81–848.28 ms |
| With workspace preinitialization | 10 | 1,057.22 ms | 1,038.96–1,356.23 ms |
| With preinitialization and visible-stream readiness | 5 | 1,140.84 ms | 1,102.16–2,708.94 ms |
| Repeated with committed real-app runner | 5 | 1,139.32 ms | 1,118.41–1,162.37 ms |
| Seed cold storage before Repo adoption | 5 | 700.14 ms | 689.76–719.29 ms |
| Also preload workspace layout code | 5 | 430.77 ms | 424.24–463.15 ms |
| Same optimized path, 100 entries | 5 | 256.56 ms | 248.05–261.43 ms |

Preinitialization worked: every sampled spare already had its Repo and target
metadata before claim, and claim did not recreate its runtime. It alone did not
improve latency. It also exposed a readiness bug: the
[preinitialization-only capture](app-first-show-hidden.png) contained chrome but no
visible conversation despite the old ready marker. The virtual list hid its
viewport until initial scroll restoration. The corrected gate waits for the stream;
the [corrected first-show capture](app-first-show-visible.png) contains the answer.

CPU profiles then identified expensive bulk import into an already subscribed Repo
document. Seeding and durably saving a cold replica before Repo adoption reduced
the median to 700.14 ms. Preloading workspace layout code and rendering the resolved
component directly removed an initial lazy/Suspense wait, reducing it to 430.77 ms:
62% below the 1,139.32 ms visible-stream baseline. Existing live documents still merge
in place; preload does not mount workspace UI. These changes retain the same visible
stream gate. All eight captures per optimized run passed readiness, answer visibility,
and absence of Loading/Session Not Found, including three discarded warmups.

This is measurable improvement, not instantaneous opening. The short-history run
still takes 256.56 ms; target-specific history/rendering and native presentation
remain after claim. The earlier 152.39 ms synthetic-DOM probe did not exercise this
React lifecycle. One earlier baseline process crashed before completion and was
excluded; its replacement run completed. These small sequential samples and the
earlier outlier cannot establish a stable tail distribution.


## macOS prepared-content prototype

This is an isolated experiment, not a product feature. The probe opens the target
in advance through the real desktop path, intercepts presentation while it prepares,
then presents that same live window through probe-only IPC. A source-window sender
check restricts this IPC to the isolated harness. Target preparation is measured
separately and excluded from presentation timing: the experiment deliberately has a
100% prepared-target hit rate, with no prediction or cache-miss model.

Run from components with the same built desktop/CLI prerequisites:

```sh
PROBE_INPUT=1 node benchmarks/window-bootstrap/run-app.mjs 5 current-input
PROBE_PREPARED=1 PROBE_INPUT=1 node benchmarks/window-bootstrap/run-app.mjs 5 prepared
PROBE_PREPARED=1 PROBE_INPUT=1 PROBE_MAC_NATIVE=1 node benchmarks/window-bootstrap/run-app.mjs 10 prepared-native
```

The last command compiles the probe-only N-API addon with Xcode command-line tools.
Headers default to `~/Library/Caches/node-gyp/<electron-version>/include/node`;
set `PROBE_NODE_HEADERS` to an existing compatible header directory if needed.
The addon takes Electron's NSView handle and sets its NSWindow's
`animationBehavior` to `NSWindowAnimationBehaviorNone`. It runs on the main thread,
uses public AppKit APIs, and is neither packaged nor loaded by the product.
Prepared/native modes refuse non-macOS hosts. The experiment does not use IOSurface.

Input validation focuses the real composer and inserts a unique token via
`webContents.insertText`, then verifies its retention after an animation frame.
It neither assigns the textarea value nor submits a message. Each token must be
absent before insertion; persistent drafts cannot produce a false pass. This
measures Chromium text insertion with focus/verification IPC overhead, not physical
keyboard latency or IME correctness. Capture begins at native show, concurrently
with validation; native show is not proof of display scanout.


[Recorded macOS prototype results](results-macos-prepared-2026-09-23.json), 3,000
entries on the reference M4 Max, with the same built desktop and CLI:

| Path | Samples | Native show median | Unique input confirmed median |
| --- | --- | --- | --- |
| Current production opening path | 5 | 443.82 ms | 490.78 ms |
| Target prepared before request | 5 | 38.31 ms | 84.64 ms |
| Prepared target, native animation disabled | 10 | 40.76 ms | 90.15 ms |

All 29 first-show/input checks passed, including warmups. The ten native samples
ranged from 32.85–75.72 ms for show and 80.73–144.70 ms for input confirmation.
About 409 ms of target preparation moved before the request. These are small,
sequential samples: disabling native animation alone has no established stable
benefit, and input tails exceed the proposed 100 ms target.

Earlier exploratory runs reused one input token, making draft persistence a source
of false passes; one repetition also failed its exact-value assertion for an
undetermined reason. Those runs are excluded from this table. The revised unique
token and next-frame check avoids the repeated-token ambiguity without retrying
insertion. A five-sample exploratory 22.43 ms show median was not sustained in the
ten-sample repeat and is not the headline result.

## macOS production preparation

The existing opt-in warmup setting now supports one target-specific hidden window
on macOS local mode. The product probe dispatches hover to a real Session row,
then Command-clicks that row. It uses production preparation and claim IPC, with
no held presentation or native animation override. Each run checks hidden state
and unchanged read receipts before the click, visible content at native show, and
unique text insertion. `PROBE_INTENT_LEAD_MS` selects a fixed lead time; omitting it
waits for readiness and deliberately measures a ready hit.

```sh
PROBE_PRODUCT_PREPARED=1 PROBE_INPUT=1 node benchmarks/window-bootstrap/run-app.mjs 10 macos-product-prepared
PROBE_PRODUCT_PREPARED=1 PROBE_INTENT_LEAD_MS=0 PROBE_INPUT=1 node benchmarks/window-bootstrap/run-app.mjs 5 macos-zero-lead
PROBE_PRODUCT_PREPARED=1 PROBE_INTENT_LEAD_MS=200 PROBE_INPUT=1 node benchmarks/window-bootstrap/run-app.mjs 5 macos-early-claim
```

[Recorded production-path results](results-macos-product-2026-09-23.json), same
M4 Max, 3,000 synthetic entries and existing CLI 0.93.3:

| Intent timing | Ready hits | Samples | Show median | Input confirmed median |
| --- | --- | --- | --- | --- |
| Wait for prepared content | 100% | 10 | 32.50 ms | 82.46 ms |
| Click immediately | 0% | 5 | 451.13 ms | 492.84 ms |
| Click 200 ms after hover | 0% | 5 | 346.94 ms | 421.82 ms |

All 29 completed checks including warmups passed content, input and unchanged
pre-click read-receipt checks. Ready-hit preparation costs 404.42 ms median before
the click, in addition to the 150 ms row-intent debounce. Ready-hit show ranges
24.26–68.57 ms and input confirmation 67.42–116.42 ms. Timing starts before the
source row event dispatch, including renderer/main IPC; the earlier prototype
started at its presentation IPC and is not an identical timing boundary.

An earlier ten-sample attempt completed ten checks including warmups, then timed
out after native show was requested. The exact stalled screenshot/input stage was
not recorded; stage diagnostics were added and the full rerun passed. The cause
remains unestablished. These small sequential runs do not establish real-world hit
rate, physical input latency, display scanout, IME, multi-display/Spaces behavior
or an RSS budget. The source window retains its own view. First-show screenshots
were inspected; the input probe explicitly focuses the composer.

The [implementation note](../../../../.agents/notes/implemented/bug-fix/2026-09-22-warm-window-content-readiness.md)
owns cancellation, expiry and speculative-effect suppression. Shared data ownership
and GPU preview remain in the linked architecture proposal.

## Earlier regression

[Original results](results-2026-09-23.json) retain the 50-sample measurement of the
previous parallel peer/cache race. Its missing-cache path waited 151.50–151.60 ms
before fallback, versus 0.50–0.65 ms for cache-only acquisition. Large-history P95
also regressed in that run. The correction checks live peers, accepts negative
replies, and reads disk before requesting exports. Snapshots still import before
constructing the reader: moving bulk import after reader initialization caused
expensive projection replay in an exploratory run and was rejected.
