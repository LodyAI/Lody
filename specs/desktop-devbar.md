# Desktop performance bar

Status: draft
Translation: pending

## Scenario

A developer investigating Desktop responsiveness can keep performance measurements
visible in a compact bar at the bottom of the window, including in a packaged
build. The content area reserves the bar's height so the composer remains usable.

## Behavior

`LODY_DEVBAR=true` enables the bar at runtime for Dev, Staging, and Prod builds.
Unset or other values disable it. The switch does not select a cloud deployment
or change the platform composition.

The right side displays renderer animation-callback FPS and maximum session-window
CLS excluding recent input, plus aggregate Electron process CPU and resident
working-set memory. `Heap xxxM` shows Chromium's current renderer JS heap estimate
(M = MiB), excluding other worker/renderer heaps. Devbar enables precise memory
readings at launch so Chromium's coarse memory cache does not mask changes.
GPU-process CPU and resident memory share a compact
`GPU xx% xxxM` field; its hover text explains CPU/RSS and that M means MiB,
not hardware utilization or VRAM. Electron totals exclude
external CLI/agent processes and may double-count shared memory pages.

Metrics refresh approximately once a second while visible. Disabled diagnostics
perform no sampling; hidden windows pause animation callbacks and process polling.
Unavailable metrics and CPU warm-up show a dash. Measurements remain in memory,
with no telemetry, persistence, or new native dependency.

## Evidence

- [Renderer](../apps/electron/src/renderer/src/desktop-devbar.tsx)
- [Main service](../apps/electron/src/main/services/devbar-service.ts)
- [Deterministic tests](../apps/electron/src/devbar.test.mjs)
- [Electron metrics](https://www.electronjs.org/docs/latest/api/structures/process-metric)
- [CLS definition](https://web.dev/articles/cls)
