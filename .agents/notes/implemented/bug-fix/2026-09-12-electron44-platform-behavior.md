# Electron 44 platform behavior

Status: implemented
Translation: pending
PR: pending

## Abstract

The second Electron 44 stack layer makes changed desktop behavior explicit:
native notification results follow Electron events, local-project selection
starts at the user's home directory, and packaged macOS artifacts require macOS
13 or later.

## Pressure

Electron 42 reports unsigned macOS notification failures asynchronously, while
the existing service returned success immediately after calling `show()`.
Electron 43 also changed directory dialogs without `defaultPath` to start in
Downloads. Electron 44 no longer supports macOS 12, but the package metadata did
not encode a corresponding minimum version.

## Decision

Settle notification IPC from the native notification's `show` and `failed`
events, including synchronous `show()` failures, and remove listeners after the
first terminal event. Give the project directory dialog an explicit home path.
Declare macOS 13 in electron-builder and public desktop documentation. Keep these
user-visible and packaging decisions above the separate Electron runtime layer
in the PR stack.

## Validation

- Desktop typecheck passed in a standalone checkout with Electron 44.3.0.
- Desktop tests passed: 107 tests, including notification success, asynchronous
  failure, and synchronous failure behavior.
- Main, preload, and renderer production builds passed.
- An arm64 directory package passed embedded CLI and native-binding probes,
  codesign verification, and declared `LSMinimumSystemVersion` as `13.0`.

## Limits

The local macOS package verification uses an unsigned arm64 directory build. It
does not establish notarization, cross-architecture runtime behavior, or updater
eligibility from macOS 12.
