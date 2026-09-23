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

### Cloud browser login

Cloud composition uses a main-process login coordinator; the OSS composition never
starts it. System callbacks settle independently of renderer lifetime, and windows
subscribe to revisioned login snapshots. Organization hydration is separately
retryable and cannot sign the user out. See the
[login contract](../../specs/desktop-browser-login.md) and
[decision](../../.agents/notes/implemented/architecture/2026-09-17-desktop-login-coordinator.md).

### Desktop performance bar

Devbar ships in Dev, Staging, and Prod builds and is off at each launch. In the
primary Desktop window, open Settings > About, double-click `Open Source Licenses`
to reveal Developer Mode, enable it, then select `Open Devbar`. The app starts the
loopback Hub and reloads that window through the Devbar-only renderer entry. Use
`Stop Devbar` to close the Hub and return to the normal entry.

`LODY_DEVBAR=true` remains an automation override for smoke tests that need Devbar
active before the first renderer loads:

```bash
LODY_DEVBAR=true pnpm start:local
LODY_DEVBAR=true pnpm --dir apps/electron preview:local
```

The override does not select a deployment; the public build remains local-only.
Product users do not need an environment variable or a separate artifact.

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
worker/renderer heaps or total app memory. A Devbar opened after app launch prefixes
the bucketed estimate with `~`; the automation override enables precise Chromium
memory readings before app readiness. Unavailable readings display `Heap —`.

Select `DEVBAR` to activate Main Thread in Devframe's official floating Hub UI.
The same Hub is available from its loopback URL as a standalone viewer. It also
includes the Devframe Inspector and Accessibility Inspector. The performance view
shows live metric cards, a bounded recent Long Task list, and collapsible metric
and blocking summaries. A Lody-owned `custom-render` module mounts the
stock view and appends live canvas line charts inside the same Main thread
dock, covering the time-series surface the official JSON-render catalog has no
primitive for. Chromium reports the blocking interval but not a
JavaScript stack, so exact function attribution still needs a CPU profile. The
installation-profile deep link `<protocol>://devbar?view=main-thread` opens the same
view (`lody://...` in the public build).

While enabled, Desktop starts a loopback-only Devframe Hub on the first free port
from 9765 through 9785. It serves the official viewer and dock, live RPC streams,
and shared state. The Devbar renderer and embedded dock authenticate to the Hub's
RPC transport with a per-process token delivered over IPC; Hub pages on the
loopback origin and non-browser callers without an Origin header stay inside the
boundary, while opaque origins such as `null` cannot call RPC methods without it.
Developer Mode shows a separate `Agent and terminal access`
switch while Devbar runs. Enabling it restarts the Hub with the aggregate HTTP MCP
endpoint and Terminals panel. Coding agents can then read the performance snapshot
and Inspector resources, and Terminals can start local subprocesses. Arbitrary
command requests are disabled, but the interactive shell remains a privileged
process-control capability. Stopping Devbar removes both capabilities. See the
[current behavior and security boundary](../../specs/desktop-devbar.md#devframe-hub).

After enabling Agent and terminal access, configure a coding-agent host once with
the stdio command `apps/electron/node_modules/.bin/devframe connect`. The connector
discovers the runtime-selected port and connects as a local non-browser caller,
which the Hub trusts without an Origin header. In Lody, review and
select the resulting MCP catalog entry in trusted UI/CLI before starting a later
agent session.

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
