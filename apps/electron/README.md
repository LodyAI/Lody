# Lody Electron

Lody desktop application built with Electron, React, and TypeScript.

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

### Install

```bash
$ pnpm install
```

### Open-source desktop development

From the repository root, build the embedded CLI and OSS renderer, then launch
Electron with the bundled CLI:

```bash
pnpm start:local
```

This is the normal OSS development entrypoint. Fully quit an existing Lody
desktop process before running it because Electron enforces a single running
instance.

`pnpm --dir apps/electron preview:local` is a lower-level smoke/e2e command for
an OSS build that has already been prepared. It deliberately skips rebuilding
and should not be used as the normal development command.

### Desktop performance bar

Set `LODY_DEVBAR=true` when launching Desktop to show the bottom performance bar.
The same runtime switch works for Dev, Staging, and Prod builds; it is off by
default:

```bash
LODY_DEVBAR=true pnpm start:local
LODY_DEVBAR=true /path/to/Lody.AppImage
LODY_DEVBAR=true /Applications/Lody.app/Contents/MacOS/Lody
```

On Windows PowerShell, use `$env:LODY_DEVBAR='true'` before launching the `.exe`.
Fully quit the existing app first. Unset the variable or set it to `false` to
disable the bar. This switch does not select a deployment; the public build
remains local-only. The same packaged artifact can be inspected without rebuilding.

The right side shows renderer animation-callback FPS, session-window CLS,
aggregate Electron RSS/CPU, current renderer `Heap xxxM`, and GPU-process CPU/RSS
in one `GPU xx% xxxM` field
(M = MiB, explained on hover). GPU CPU is **not** hardware
utilization, and GPU RSS is **not** VRAM. RSS sums resident working sets (shared
pages may be counted more than once); CLI/agent descendants outside Electron's
metrics are excluded. Missing/warming-up measurements show `—`. Sampling pauses
while the window is hidden. Values stay in memory and are never uploaded.
Heap uses Chromium's JS heap estimate for the current renderer, not other
worker/renderer heaps or total app memory. Enabling devbar at launch also enables
precise Chromium memory readings; unavailable readings display `Heap —`.

### Build

Every build command below uses the local OSS renderer, embeds the local-only
CLI, and has no update publishing target or notarization identity.

```bash
# For Windows
$ pnpm build:win

# For macOS
$ pnpm build:mac

# For Linux
$ pnpm build:linux
```
