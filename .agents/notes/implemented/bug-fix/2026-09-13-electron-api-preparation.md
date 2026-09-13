# Electron API preparation

Status: implemented
Translation: pending
PR: https://github.com/LodyAI/Lody/pull/659

## Abstract

Electron 42 through 44 make native notification, dialog, and clipboard behavior
more explicit or asynchronous. The desktop now waits for text clipboard writes,
settles notification IPC from Electron's delivery events, and gives the project
picker an explicit home-directory start while remaining on Electron 39. Image
clipboard migration is deliberately excluded because Electron 39 and 44 expose
incompatible write contracts with no unconditional shared call shape.

## Pressure

The existing notification service returned success immediately after calling
`show()`, so an asynchronous native failure could not reach the renderer.
Electron 43 also changed the default directory for dialogs without `defaultPath`,
and Electron 44 makes text clipboard writes asynchronous. These independent
behavior changes can be prepared before the runtime and packaging toolchain move.

## Decision

Await text clipboard writes even though Electron 39 returns `void`; JavaScript
permits awaiting that value, and the same call will wait for Electron 44's
Promise. Resolve native notification delivery only from `show`, `failed`, or a
synchronous exception, cleaning both listeners at settlement. Set the local
project directory dialog's default path to Electron's home path.

Do not migrate image writes in this layer. Electron 39 accepts
`clipboard.write(Data): void`, while Electron 44 accepts
`clipboard.write(ClipboardItem[]): Promise<void>` and removes `writeImage`.
Supporting both would require version detection or an adapter, which is outside
the clean pre-migration policy for this dependency stack.

## Validation

- Electron 39 main and renderer typechecks pass.
- The desktop suite passes 107 tests, including native notification success,
  asynchronous failure, synchronous failure, and listener cleanup.
- Main, preload, and renderer production builds pass on macOS ARM.

## Limits

This change does not upgrade Electron, electron-vite, Vite, packaging targets, or
the minimum supported operating system. Native notification display and clipboard
integration still require platform smoke coverage when the Electron runtime moves.
