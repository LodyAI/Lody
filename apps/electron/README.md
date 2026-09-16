# Lody Electron

Lody desktop application built with Electron, React, and TypeScript.

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Oxc](https://marketplace.visualstudio.com/items?itemName=oxc.oxc-vscode)

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

The right side shows renderer animation-callback FPS, Long Task duration for the
latest interval, session-window CLS,
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

Select `DEVBAR` to activate Main Thread in Devframe's official floating Hub UI.
The same Hub is available from its loopback URL as a standalone viewer. It also
includes the Devframe Inspector, Accessibility Inspector, and Terminals panels;
the latter provides an interactive local shell. The performance view shows live
metric cards, 60-sample sparklines for FPS/CPU/memory/blocking, and a bounded
recent Long Task list. Chromium reports the blocking
interval but not a JavaScript stack, so exact function attribution still needs a
CPU profile. The
installation-profile deep link `<protocol>://devbar?view=main-thread` opens the
same view (`lody://...` in the public build).

While enabled, Desktop starts a loopback-only Devframe Hub on the first free port
from 9765 through 9785. It serves the official viewer and dock, live RPC streams,
shared state, and one aggregate HTTP MCP endpoint. Coding agents can read the
performance snapshot and Inspector resources and can use the Terminals tools to
start local subprocesses. Arbitrary command requests are disabled, but the
interactive shell remains a privileged process-control capability. The Hub is
unavailable when `LODY_DEVBAR` is off; startup failure leaves the local metrics
bar running. See the [current behavior and security boundary](../../specs/desktop-devbar.md#devframe-hub).

Configure a coding-agent host once with the stdio command
`apps/electron/node_modules/.bin/devframe connect`. The connector discovers the
runtime-selected port and supplies the endpoint's loopback Origin header; a direct
generic HTTP entry usually does neither. In Lody, review and select the resulting
MCP catalog entry in trusted UI/CLI before starting a later agent session.

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
