# iPhone Duo viewport adaptation

Status: implemented

[中文](2026-10-27-iphone-duo.zh.md)

## Implementation

- A native WebView container applies the current window's left and right safe-area insets independently.
- `UIKeyboardLayoutGuide` publishes the docked keyboard's overlap to the shared UI.
- UIKit division regions provide the shared UI with horizontal and vertical fold geometry.
- A native side rail presents navigation and chat actions when UIKit reports a vertical bar and reserved regions leave enough side space.
- The [native viewport fixture](../tests/fixtures/viewport.html) exercises the WebView without an account.

The shared UI adaptation is in [PR #2005](https://github.com/LodyAI/Lody/pull/2005).

## Build

Full-display builds use Xcode/iOS SDK 27.1 or later and target iOS/iPadOS 16.4.
The Duo build commands are in [BUILDING.md](../BUILDING.md#iphone-duo). The iOS
publishing toolchain is updated in [PR #3888](https://github.com/loro-dev/lody/pull/3888).
