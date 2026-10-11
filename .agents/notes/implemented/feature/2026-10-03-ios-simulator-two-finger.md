# Two-finger simulator input

Status: implemented
Translation: current

[中文](2026-10-03-ios-simulator-two-finger.zh.md)

## Abstract

The viewer ignored a second finger and the gateway accepted only single-touch messages. Touchscreens now forward two stable, paired coordinates through the existing WS/RTC input path for native pinch, rotation and pan. The pinned Baguette already implements touch2, so no runtime upgrade is required. Switching from one to two fingers ends the original touch; this is deliberately not a continuous native finger-identity transition.

## Boundaries and trade-offs

The viewer maps both pointers through the same inverse rotation and batches move events per animation frame. Down/up are immediate. A second pointer releases single-touch before starting the pair; either pointer ending releases both, and the survivor must lift before another gesture. Third pointers are ignored. Mouse/wheel behavior is unchanged; desktop modifier gestures and three-or-more fingers remain deferred.

The gateway validates both coordinates and gesture kind, preserves lease checks and releases the matching paired up event before closing the native socket. No commands are replayed. Native touch2 and touch1 use different HID paths, so a fake seamless transition was rejected. UI changes reuse the fixed viewer instead of introducing a second touch layer.

## Evidence and limits

62 targeted viewer, gateway and RTC tests passed, covering paired positions, coalescing, ignored extra pointers, survivor blocking, cancellation, malformed coordinates and disconnect cleanup. Independent adversarial review found no P0/P1. On a disposable iPhone 17 Pro / iOS 26.5 simulator, a UIKit probe received two touches and UIPinchGestureRecognizer began, changed and ended at scale 1.22 after single-up → dual-down/move/up. All seven native input messages returned ok=true; the test device was shut down and deleted. Actual phone-browser-to-remote-device rotation and pan acceptance remain unverified.

Spec: [iOS Simulator preview](../../../../specs/ios-simulator-preview.md). PR: https://github.com/LodyAI/Lody/pull/1227.
