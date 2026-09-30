# Correct the macOS traffic-light baseline

Status: implemented
Translation: current

[中文](2026-09-30-macos-traffic-light-baseline.zh.md)

## Abstract

The macOS traffic lights still appeared left-shifted after the earlier sidebar-column fix because that change treated `trafficLightPosition.x` as a circle-centre coordinate. A native Retina screenshot instead shows that Electron uses the point as the first button frame's top-left inset. The main window now uses equal 16px horizontal and vertical insets, putting the first light's centre at `(23, 23)` on the existing sidebar icon and top-row centrelines. Native verification is still required at fractional display scales.

## Correction and baseline contract

This corrects the coordinate conclusion in the [earlier alignment decision](2026-09-29-macos-sidebar-traffic-light-column.md) without reversing its sidebar-row work. In the supplied 2x screenshot, the window begins at image `(118, 86)` and the first light frame begins at `(146, 118)`: offsets of `(28, 32)` image pixels, or `(14, 16)` layout pixels. Its centre is therefore `(21, 23)`, visibly 2px left of the navigation icon centre at x=23. The configured `{x: 14, y: 16}` matches those frame offsets exactly; x and y are not circle-centre coordinates.

The corrected window position is `{x: 16, y: 16}`. A 14px native button then has its centre at `(23, 23)`. The existing desktop sidebar geometry remains unchanged: its outer 6px gutter plus row padding/border puts 16px navigation, project and repository icon boxes at x=15 and their centres at x=23; ordinary labels begin at x=37. Flat Session rows have no resting leading icon, but retain the same x=37 title baseline. Nested Sessions and owner/pin content keep their intentional additional indentation.

## Dependent chrome and verification

The three-button cluster now ends at x=76. The landing expand control remains at x=96, leaving 20px, while the collapsed-session top bar and full-screen image viewer retain their 80px or greater reserved insets. The vertical centre stays y=23, so the existing 44px rows with 2px top padding and h-7 controls need no change.

Source geometry, the native screenshot, and every desktop sidebar row type were audited. This nested checkout has no installed frontend dependencies, so the full application could not be launched. A controlled Electron 39.5.1 fixture instead rendered the same sidebar geometry before and after the change; browser automation measured the unchanged icon centre at x=23 and the traffic-light frame moving from x=14 to x=16. macOS ScreenCaptureKit denied native window capture under the current TCC permissions, so the acceptance image combines the real Electron renderer capture with an exact overlay of the two native frame positions. A full native application run should still confirm the result at fractional display scales.
