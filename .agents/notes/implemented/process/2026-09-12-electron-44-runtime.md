# Electron 44 runtime migration

Status: implemented
Translation: pending
PR: pending

## Abstract

The desktop runtime now targets Electron 44.3. The migration explicitly installs
the runtime binary for cold workspaces, aligns build targets with Electron's
embedded Node and Chromium versions, and adopts the asynchronous clipboard API.
Platform policy and user-visible behavioral changes remain in later stack layers.

## Pressure

Electron 44 no longer downloads its binary from the package postinstall hook,
removes the synchronous image clipboard API, and makes clipboard writes
asynchronous. In addition, electron-vite 5 has no target-table entries after
Electron 39 and silently falls back to Node 16 and Chrome 108 for unknown majors.
A manifest-only upgrade therefore produces a desktop that cannot cold-start and
is compiled against the wrong runtime generations.

## Decision

Run Electron's shipped installer from the desktop workspace postinstall before
native dependency rebuilding, preserving the existing opt-out for non-desktop
installs. Target Node 24.20 for main/preload and Chrome 152 for the renderer.
Write PNG clipboard data as an Electron `ClipboardItem`, await image and text
writes before IPC settles, and preserve the existing invalid-image and error
result contracts. Keep Electron Vite on version 5 and Vite 7 in this stack; their
major upgrades require a stable peer-compatible release.
