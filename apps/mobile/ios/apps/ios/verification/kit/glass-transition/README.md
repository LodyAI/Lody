# UIKit glass transitions

The comparison window is an isolated Debug-only API experiment.
`--ui-verify --glass-spike` opens a native comparison window; relaunch resets it.
It uses no account, network fixture, or React screen. Normal launches do not open it.

## Run

From the repository root, choose a fresh output directory:

```sh
pnpm verify:simulator --name 'Glass Material Spike' -- zsh -euc '
  spike_app=$(pnpm --silent verify:build)
  python3 apps/ios/verification/ui/glass-spike.py "$spike_app" .artifacts/glass-material-spike
'
```

The runner captures screenshots, video and `observations.json` in both appearances.
Rows compare `isHidden`, whole-view alpha, direct `effect = nil`, and the
production `CKGlassSurface` inside `UIGlassContainerEffect`. Content fades
separately in the last two rows. Row three deliberately remains mounted after
dematerialization; row four hides only after its material has gone.

The direct animation uses one-second and 0.35-second transitions; the production
surface uses 0.3 seconds. Both reverse an exit after 150 ms. Assertions check nil effects,
disabled interaction during exit, and restored effects/content after reversal.

## Observed on iOS 26.5 Simulator

- Direct hiding snaps off. Alpha fades the whole existing surface.
- Animating the effect to nil removes the glass in both standalone and container
  cases, with intermediate material frames and no visible glass left at rest.
- Restoring the effect materializes it again. The interrupted exit ends visible
  with its effect, content and interaction restored in both appearances.
- The initial container experiment using `.beginFromCurrentState` briefly nearly
  disappeared during reversal. The production surface reverses the same property
  animator. UIKit restores its reversed effect after invoking completion, so final
  state normalization runs on the next main-queue turn.

Baseline evidence: `.artifacts/glass-material-spike-final/{light,dark}/`.
Reversible surface evidence: `.artifacts/glass-reversible/{light,dark}/`.
This does not establish parity with SwiftUI's materialize transition, physical
device performance, earlier iOS versions, Reduce Motion behavior, or safe removal
by a React parent. UIButton.Configuration.glass() is outside this experiment.

## Product checks

`pnpm verify:native --case glass-transition` checks interruption, detach and
disabled animations. The existing `chat-chrome` and `composer` native checks
cover the real controls, reserved queue/attachment height and surviving pill
identity. `pnpm verify:ui --suite glass-transitions --app <Debug.app>` records
chat chrome, Mention in chat/sheet, queue draining, and attachment removal/send
in chat/sheet, in both appearances, without credentials. The shared native
composer owns both hosts. Manual removal animates; send consumption uses the
existing attachment handoff and removes source pills immediately.
