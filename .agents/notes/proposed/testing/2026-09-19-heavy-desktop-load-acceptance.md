# Heavy desktop load acceptance suite

Status: proposed
Translation: current
Language: [中文](2026-09-19-heavy-desktop-load-acceptance.zh.md)
PR: https://github.com/LodyAI/Lody/pull/827

## Abstract

PR #811 was primarily checked with an empty workspace, which could not expose the cost of real persisted sessions and long message lists. This proposal adds a deterministic synthetic-load lane that seeds sessions through the real local Electron/CLI/ACP path, reopens them in an isolated profile, and records user-visible readiness together with frame and resource evidence. The first bounded `pnpm e2e:load` slice is implemented, while concurrency matrices, soak runs, and contractual thresholds remain unverified.

## Decision

Keep load generation and user-surface evidence separate:

- `e2e/src/support/fixtures/load-scripted-acp.mjs` supplies deterministic local ACP responses sized by the test prompt.
- `e2e/src/support/fixtures/load-session-fixture.ts` owns synthetic persisted-session setup without user or agent transcripts.
- `e2e/src/load/load-runner.ts` seeds a unique profile, closes it, relaunches the same profile, and reopens every seeded session through the real route.
- `apps/electron/src/preload/boot-profiler.ts` starts before the route bundle and samples boot milestones, visible text, background color, and blank frames only when `LODY_E2E_BOOT_PROFILE=1` is set.
- `e2e/src/support/electron-harness.ts` writes boot, runtime, logs, screenshots, and Playwright trace evidence under the ignored artifact directory.

The lane is bounded by default (`24` sessions and `1/8/64 KiB` synthetic bodies); larger runs are explicit opt-in. Each run uses a temporary Electron user-data directory, Lody data directory, local CLI endpoint, and artifact round. `LODY_E2E=1` keeps the PR #811 warm pool disabled, so this lane measures the heavy workspace baseline independently of the warm-window experiment documented in [the implementation note](../../implemented/feature/2026-09-18-desktop-window-prewarming.md).

## Baseline evidence

The first macOS baseline reopened all 24/24 persisted sessions. The workspace shell appeared at 465 ms, the composer became editable at 491 ms, and representative message text appeared at 1,139 ms. The seed phase observed about 697 MB renderer RSS and 166 MB JavaScript heap; the reopen sample observed about 618 MB RSS and 181 MB heap. The preload trace recorded about 360 ms of continuous textless frames during reopen. These are observations for comparison, not acceptance thresholds.

## Limits and next work

The first slice proves persisted-session load, frame/blank-surface sampling, resource snapshots, screenshot capture, and replayable JSON output. It does not yet provide concurrent-window lanes, 30/60-minute soak runs, process-replacement fault injection, or a cross-platform threshold contract. Those additions should reuse the same isolated fixture and require an independent user-visible oracle before thresholds are made blocking.

## References

- [LobeHub acceptance process](https://github.com/lobehub/lobehub/blob/canary/.agents/acceptance/PROCESS.md)
- [LobeHub desktop boot profiler](https://github.com/lobehub/lobehub/blob/canary/apps/desktop/src/preload/bootProfiler.ts)
- [LobeHub chaos contracts](https://github.com/lobehub/lobehub/tree/canary/packages/achaos)
