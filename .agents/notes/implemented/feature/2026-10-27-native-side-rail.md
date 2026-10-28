# Native side navigation for available system-bar space

Status: implemented
Translation: current

[中文](2026-10-27-native-side-rail.zh.md)

## Abstract

On Duo's outer display the system status region left an unused side strip while
the mobile navigation consumed content height. The native host can now place
workspace tabs and selected chat actions in the available part of that strip.
The web controls remain the fallback when the host cannot safely display all
actions, and open dialogs or menus suspend the native rail.

## Decision and evidence

The shared UI registers translated labels, existing callbacks and selection state
through an optional host capability; it does not infer the device model or region
geometry. The current surface wins over the mounted background. The host accepts
only known symbols and uses UIKit occlusion regions, independent safe-area edges,
the current keyboard and minimum touch target size to decide whether all actions
fit. It reports actual visibility before the web surface hides its controls.

The separate [fold resize fix](../bug-fix/2026-10-27-ios-fold-layout-width.md)
ensures the layout family follows the resized viewport. On the Duo simulator,
the side tabs switched between chat and schedules, the chat menu opened, and its
rail disappeared while the sheet was open. The docked keyboard left the composer
visible. The host has an older-SDK fallback; real devices, Split View, dynamic
island expansion, VoiceOver and all sheet/menu variants still need acceptance.

The October 28 review corrected menu suspension to observe Base UI's `data-open`
state as well as legacy `data-state` surfaces. The regression uses the real Menu
component: opening it clears native actions and rejects events from the old owner;
closing it restores registration and waits for fresh native visibility confirmation.
