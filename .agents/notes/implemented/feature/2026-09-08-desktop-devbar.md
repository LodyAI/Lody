# Runtime Desktop performance bar

Status: implemented
Translation: pending

PR: [#525](https://github.com/LodyAI/Lody/pull/525)

## Abstract

Desktop performance investigations need visible measurements in both development
and packaged builds. A runtime environment switch enables a bottom bar, with
renderer frame/shift measurements and Electron process CPU/resident-memory samples.
This keeps diagnostics available without rebuilding or enabling telemetry. GPU
process metrics are explicitly distinguished from hardware utilization and VRAM;
external CLI/agent processes are outside the totals.

## Decision

Use `LODY_DEVBAR=true` in main and expose configuration/snapshots through the existing
typed app IPC service. A build-time renderer flag would require a new artifact for
production investigations and interact with the public build's audited environment
constants. The boolean switch is identical across build environments, defaults off,
and preserves the local composition.
No existing active note owns this feature; the related platform boundary remains
in [platform contracts](../../../../packages/platform/AGENTS.md).

The renderer reserves 28 pixels before initial mount and keeps the bar outside the
router. It measures animation callbacks and buffered CLS session windows. Main
shares a rate-limited on-demand Electron metrics sample across windows; it starts
no timer. The renderer pauses polling while hidden and disconnects observers on
unmount. Initial CPU samples and samples after a long pause are unavailable until
the next measurement interval. Native GPU hardware monitoring was not added because
Electron's portable metrics report GPU-process CPU/RSS, not GPU utilization/VRAM.
The GPU measurements share one compact `GPU xx% xxxM` field, with process CPU/RSS
and the MiB unit explained on hover. This reduces repeated labels without changing
the sampling cadence or measurement scope; programmer-facing abbreviations remain.

Heap is sampled from a fresh Chromium `performance.memory.usedJSHeapSize` object
on each visible polling cycle and shown as `Heap xxxM`. Main enables
`enable-precise-memory-info` before readiness only when devbar is enabled, avoiding
Chromium's bucketization and long-lived cache. This is the current renderer's heap
estimate, not other worker heaps or total app memory; missing/invalid readings show
a dash. No additional polling loop, IPC surface, or heap snapshot is introduced.
The precision choice follows [Chromium's implementation](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/timing/memory_info.cc).

## Outcome and verification

The [Spec](../../../../specs/desktop-devbar.md) remains draft. All 104 Electron
tests pass, including environment defaults/overrides, aggregation, missing data,
and CLS gap/duration boundaries. Repository typechecking, lint, and document checks pass.
A headless Chromium component smoke with synthetic IPC measurements and a fake
clock verifies values, 28-pixel reservation, 1280/640-pixel viewport layouts, and
hidden-window placeholders without renderer errors. This is component validation,
not a packaged Desktop launch; cross-platform hardware measurements remain unverified.
The Heap component smoke also verifies 64M → 128M updates, unavailable readings,
recovery, and clearing the reading when hidden using injected values and a fake clock.

Full-suite validation requires `NODE_ENV=test` in this environment: the inherited
`production` value disables React's test `act` API. With that override, all 441
shared UI test files (3275 tests) pass. The full CI test command still reports
failures in the unmodified CLI `gh-shim-script.test.ts` subprocess exit-code
assertions. Import, platform, public-boundary, and i18n checks pass separately.
