# Desktop windows keep the desktop layout below the mobile breakpoint

Status: implemented
Translation: current

English | [中文](2026-09-25-compact-desktop-layout.zh.md)

## Abstract

The Electron window could not be resized below 768px because
`useIsMobile()` treated every viewport under `MOBILE_LAYOUT_BREAKPOINT` as a
phone, and the main process enforced `minWidth = 768` to hide that. The
breakpoint now applies only to non-desktop devices: desktop-class windows —
the Electron shell or a desktop browser — keep the desktop renderer at every
width and take a compact presentation below the breakpoint, while phones,
tablets and unrecognized devices keep the width switch (a phone rotated wide
enough earns the real desktop renderer instead of a stretched mobile stack).
In compact presentation the navigation sidebar and the Session side panel
stop taking columns and become overlays, synced into
`compactDesktopLayoutAtom` so non-hook consumers see the same state. The one
trade-off: crossing the compact boundary remounts the sidebar and an open
side panel once, so their transient in-component state (e.g. scroll position)
resets — persisted atoms survive.

## Root cause

Two coupled assumptions: `checkIsMobileDevice()` returned true for any
`innerWidth < 768` regardless of platform, and `MAIN_WINDOW_MIN_WIDTH` was set
to `MOBILE_LAYOUT_BREAKPOINT` so the renderer never actually observed
`isMobile === true` inside Electron. Removing the minimum alone would have
exposed a desktop layout that still cannot fit: the nav sidebar wants ~280px,
the conversation column has a 280px floor, and Session side panels want
280–500px. The codebase already knew width ≠ layout — `agent-config-dialog`
deliberately watches the viewport instead of `useIsMobile()` for exactly this
narrow-window adaptation, and the settings `AGENTS.md` forbids sizing a column
from a viewport breakpoint.

## Decision

- **Desktop class pins the family; everything else keeps the breakpoint.**
  `checkIsMobileDevice()`: `'desktop'` class or `isDesktopLayoutShell()` →
  desktop at every width, so a desktop browser window resized narrow behaves
  exactly like the Electron window; every other class follows the viewport
  breakpoint — a narrow phone/tablet gets the touch-first renderer and a
  phone rotated past it gets the real desktop one. The old
  `deviceClass === 'mobile'` pin is gone: it existed to keep a landscape
  phone on mobile UI, but product intent is the symmetric rule — mobile
  becomes desktop when wide enough, desktop never becomes mobile.
  Zero-regression inside Electron: with `minWidth = 768` the renderer never
  saw `isMobile === true` there anyway.
- **`useIsCompactDesktop()`** = desktop family AND viewport below the
  breakpoint. Reached by any desktop-class window; a `ForceDesktop` context
  can reach it too.
- **One global state, bridged once.** `MainLayout` syncs the hook result into
  `compactDesktopLayoutAtom` in a layout effect. Commands and atom consumers
  that cannot call hooks read `navigationSidebarVisibleAtom` — effective
  on-screen visibility — instead of `navigationSidebarHiddenAtom`
  (persisted preference + Zen), which stays for app-visibility consumers like
  `create-workspace-runtime`.
- **Suppressed, not collapsed.** Entering compact sets
  `compactSidebarSuppressedAtom` when a sidebar is on screen, so widening
  restores it; an explicit toggle/show or a scrim click clears the flag, and a
  scrim close writes a real persisted collapse. The persisted preference is
  never rewritten for presentation reasons.
- **Overlays, not splits.** The compact nav sidebar is a dismissible sheet
  (`min(18rem, 85vw)`, desktop chrome, no sash). The Session side panel takes
  over the region below the top bar while the resizable split parks collapsed
  with `sidebarOpen` and its remembered width intact; a closed panel stays
  mounted in the collapsed split per the side-panel contract.
- **`DESKTOP_WINDOW_MIN_WIDTH = 400`** replaces the breakpoint as the window
  floor — it protects window chrome (traffic lights, caption buttons), not a
  layout contract. Persisted bounds clamp and constructor options share it.

## Alternatives considered

- **Just lower `minWidth`.** Rejected: <768px then produced a real mobile
  remount mid-resize, or a desktop layout with overflowing mandatory columns.
- **Container queries everywhere.** Right for column sizing and already used
  inside surfaces, but the renderer swap in `MainLayout` is global — a window
  cannot half-mount the mobile stack. Identity for the family + local queries
  for adaptation keeps each concern at the right level.
- **Keep `useIsMobile` width-driven, special-case Electron at each consumer.**
  50+ call sites; the hook's own precedent comments already separate "layout
  family" from "narrow adaptation", so fixing the primitive fixed them all.

## Evidence

- `tests/mobile-layout-selection.test.tsx`: a phone rotates from
  `mobile:full` into `desktop:full` past the breakpoint, client-hints wide
  phone gets desktop, wide tablet stays desktop, narrow tablet flips to
  mobile, and a desktop window — Electron or desktop browser — stays
  `desktop:compact` ↔ `desktop:full` across resizes.
- `tests/compact-desktop-layout.test.ts`: compact entry suppresses a visible
  sidebar without touching the persisted preference, exit restores it, toggle
  reveals the overlay, a compact-mode collapse persists across the boundary.
- Existing `desktop-session-detail-layout` (11) and `layout-state` (12) suites
  pass unchanged; `tsgo` clean on components/shared/electron.

## Limits

- Compact presentation is verified at the atom/hook boundary and in
  typecheck; the overlay visuals were not exercised in a real Electron window
  in this change.
- A desktop UA that fails to parse to `'desktop'` on a narrow screen falls
  back to the breakpoint (mobile below it) — UA detection stays heuristic.
- Rotating a phone now remounts the renderer mid-gesture (mobile → desktop
  past the breakpoint). That was the original reason for the identity pin;
  the remount is accepted because a wide viewport genuinely changes which UI
  is usable.

Spec: [desktop multi-window](../../../../specs/desktop-windows.md).
