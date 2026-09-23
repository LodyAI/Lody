# Cancel ScrollArea thumb polling on cleanup

Status: implemented
Translation: current

[中文](2026-09-15-scroll-area-frame-cleanup.zh.md)

## Abstract

Radix ScrollArea 1.2.10 can retain a recursive animation-frame loop when its thumb unmounts during the scroll-end debounce. The loop keeps reading a detached viewport. A pnpm patch cancels this loop in the owning effect cleanup for both ESM and CommonJS, preserving normal scroll polling. Real-component regression tests reproduce the defect without the patch and pass with it; the running desktop app's energy reduction has not been measured.

## Decision

Apply the [dependency patch](../../../../patches/@radix-ui__react-scroll-area@1.2.10.patch) through pnpm's version-scoped patchedDependencies. Cleanup removes the scroll handler, cancels the thumb's active polling loop, and clears its cancellation reference. This also handles effect dependency changes. The scroll-end debounce already cancels polling during normal operation, but its timer is cleared on unmount, so it cannot own unmount cleanup.

Keep the existing Radix UI and scrolling behavior. Replacing it with native scrollbars or Base UI would expand the change and require interaction and styling validation. Remove this patch only after an upstream release provides equivalent cleanup and passes the [lifecycle tests](../../../../packages/components/tests/scroll-area-lifecycle.test.tsx); the upgrade rule lives in [UI instructions](../../../../packages/components/src/ui/AGENTS.md#scroll-area).

## Verification and limits

- Actual React 19.2.0 and Radix 1.2.10 components run in jsdom with manual animation frames and fake timers; no real sleeps or timing races.
- Both module entries stop polling at scroll end and restart on the next scroll.
- Ten mount/scroll/unmount cycles leave no subsequent detached-viewport reads or queued frames after cleanup, including 120 simulated frames.
- Removing the patch makes both unmount cases fail while both normal-scroll cases pass. Restoring it passes all four tests.
- pnpm 10.20.0 applied the patch in an isolated install and generated its lockfile hash. The repository's full dependency setup is blocked by missing ACP workspace submodules, so the full project suite was not run.
- No running app was rebuilt or restarted. This proves a lifecycle leak and its repair, not its share of renderer CPU or Energy Impact.
