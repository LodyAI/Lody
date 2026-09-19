# Pre-warm desktop windows for multi-window opens

Status: implemented
Translation: current

[中文](2026-09-18-desktop-window-prewarming.zh.md)

## Abstract

Every multi-window open previously cold-booted a full renderer, so a new window
waited for bundle parse, providers, and auth before showing content and could
flash a blank or wrong frame. Developer mode can keep one hidden auxiliary
renderer booted on a neutral route; opening a window claims that spare, binds
the target through IPC and a client-side navigation, shows it immediately, and
primes a replacement. The option is off by default, so the cold path remains
the ordinary fallback. The spare warms the application shell and shared
providers, not a specific workspace's data, and it costs one extra hidden
renderer process. It builds on the earlier desktop
multi-window decision ([note](../../proposed/feature/2026-09-10-desktop-windows.md),
[Spec](../../../../specs/desktop-windows.zh.md)).

## Decision

- The spare is a real product window (it needs product IPC to boot) but is
  marked warm: it never becomes the main-window fallback, never counts as a
  user-visible surface, is destroyed when the last real window closes, and is
  skipped by the boot-time cache-clear consumer so it cannot swallow a clear
  armed for the visible window.
- `window-warm-pool.ts` owns a single-slot state machine (`idle`/`warming`/
  `ready`). The renderer signals `app.windowReady` after its commit; main then
  promotes the spare. A 30-second timeout drops a spare that never reports
  ready, so a crashed or recovery-page window cannot occupy the slot forever.
- The spare boots at `/?window=workspace&warm=1`. The home route renders a
  neutral placeholder instead of redirecting into a workspace, so binding never
  shows another surface's content and no workspace background work starts
  before the target is known.
- On claim, main sends `app.windowTarget` and presents the window. The renderer
  reproduces the storage flags a fresh auxiliary window would derive from its
  URL, collapses the sidebar for a session target, and navigates client-side.
  The same "new window" route and focus handoff are reused, not reimplemented.
- The option is exposed only after Developer mode is revealed in Settings >
  About. Turning it off destroys any hidden spare; it is runtime-only and
  resets to off on the next process start.
- Warm-up is disabled under `LODY_E2E` (the harness counts and inspects
  windows) and by `LODY_DISABLE_WINDOW_WARMUP=1`. Any failure falls back to the
  unchanged cold window.

## Alternatives considered

- A dedicated warm HTML entry, mirroring Cradle-app's `tearoff.html`. Rejected
  for now: it adds a second renderer entry and bootstrap shell to maintain
  without changing the boot cost much beyond the neutral route this change
  already provides.
- Booting the spare directly on the default workspace route. Rejected: on claim
  the window would briefly show that workspace before navigating and would start
  its background work before a target exists.
- Reusing the window but reloading the target URL. Rejected: the reload keeps
  the exact cold-boot cost the technique exists to remove.

## Verification and limits

- `window-warm-pool.test.mjs` covers the single-slot transitions, duplicate
  signals, dead spares, and one-shot claims.
- Typechecks for `@lody/shared`, the Electron main/preload/renderer projects,
  and `@lody/components` pass.
- A fresh Electron/CDP run verified one renderer and no hidden spare before the
  developer option, then `phase=ready`, one spare, and 200,523,776 bytes of
  spare working set after enabling it; disabling the option returned
  `phase=disabled` and zero spares. The E2E suite keeps warm-up disabled, so it
  exercises only the cold path.
- The spare warms the app shell, router, i18n, and root providers. It does not
  pre-initialize a workspace runtime or its data, so the first bound window
  still loads its own route data.
