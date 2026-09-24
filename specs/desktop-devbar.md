# Desktop performance bar

Status: draft
Translation: current

[中文](desktop-devbar.zh.md)

## Scenario

A developer investigating Desktop responsiveness can keep performance measurements
visible in a compact bar at the bottom of the window, including in a packaged
build. They can open Devframe's official Hub overlay for main-thread stalls,
access inspection, accessibility, and terminal tools, read the same diagnostics
from a coding agent, or open the performance view with a deep link. The content
area reserves the bar's height so the composer remains usable.

## Behavior

Devbar ships in Dev, Staging, and Prod builds but is off at each process launch.
On Desktop, the hidden Developer Mode in Settings > About reveals an `Open Devbar`
control. Selecting it starts the local Hub and reloads the primary window through
the Devbar renderer entry while preserving its route. `Stop Devbar` closes the Hub
and returns that window to the normal renderer entry. Auxiliary windows never load
the Devbar entry. `LODY_DEVBAR=true` remains an automation override that enables
Devbar before launch; it is not required for product use and does not select a
cloud deployment or change platform composition.

The right side displays renderer animation-callback FPS and maximum session-window
CLS excluding recent input, Long Task duration for the latest interval, plus
aggregate Electron process CPU and resident working-set memory. `Heap xxxM` shows
Chromium's current renderer JS heap estimate (M = MiB), excluding other
worker/renderer heaps. A Devbar enabled after launch prefixes this value with `~`
because Chromium's precise-memory switch can only be set before app readiness.
The automation override enables precise readings.
GPU-process CPU and resident memory share a compact `GPU xx% xxxM` field; its hover
text explains CPU/RSS and that M means MiB, not hardware utilization or VRAM.
Electron totals exclude external CLI/agent processes and may double-count shared
memory pages.

Selecting `DEVBAR` activates Main Thread in the official Devframe Hub UI loaded
inside the user app. The Hub's loopback root serves the same reference UI as a
standalone viewer and includes Main Thread, Devframe Inspector, Accessibility
Inspector, Terminals, command palette, settings, and dock controls. The Main Thread
view uses Devframe's official JSON-render renderer and `@antfu/design` components;
Lody does not own a parallel detailed UI stylesheet.

The performance view leads with current FPS, CPU, heap, and blocked-time cards,
followed by collapsible current-metric and blocking summaries and the bounded
recent Long Tasks reported by Chromium's Performance Timeline. Devframe 1.0's
official JSON-render catalog has no chart primitive, so the Main thread dock is
a `custom-render` entry: a small Lody-owned module served from the loopback
server mounts the official JSON-render view and appends a canvas trends card
inside the same dock, polling a snapshot JSON route once a second to draw live
line charts for FPS, CPU, heap, resident memory, and blocked time. This is a
narrow exception to the no-Lody-owned-detailed-UI boundary: it adds a chart
surface inside the stock view, not a parallel view stylesheet. A Long Task proves
that the renderer main thread was blocked for at least 50 ms, but does not include
a JavaScript stack; function attribution requires a later CPU-profile capture.
`lody://devbar?view=main-thread` (or the installation profile's equivalent
protocol) focuses Desktop and opens this overlay when Devbar is already enabled;
a deep link never grants the capability by itself.

Metrics refresh approximately once a second while visible. Disabled diagnostics
perform no sampling or network listening; hidden windows pause animation callbacks
and process polling. Unavailable metrics and CPU warm-up show a dash. Measurements
remain in memory, with no telemetry or persistence. A Devbar failure degrades to
no diagnostics rather than affecting the application: Hub request errors answer
HTTP errors, and a renderer failure removes only the bar.

## Conversation capture

The enabled footer offers **Capture chat** before navigating into a session. It
starts synchronously in the current renderer, displays an active recording state,
and offers **Stop capture** and then **Copy capture**. This does not restart the
app, require a debugging port, clear caches, or claim that the entry is cold.
For a cold-entry investigation, enable Devbar before opening the target session
and start capture before selecting it; enabling Devbar reloads the primary renderer.

This opt-in recorder observes the conversation viewport once per animation frame
and retains changed samples. It distinguishes initial reveal from later hiding,
viewport removal/replacement, loss of visible rows, and displacement of a retained
reading row at an unchanged scroll offset. Long Task intervals, input kinds and
maximum callback gap share the same relative clock. These are observations, not
proof of the cause of a flash: it captures neither presented pixels, JavaScript
stacks, nor internal source/projection identity. Legitimate layout changes can
also displace a row.

Recording stops after 60 seconds, at 1,800 changed samples, on explicit stop,
window hiding, unmount, or sampler failure. A frame inspects at most 200 mounted
rows and reports truncation; input and Long Task histories retain at most 200 and
100 entries. Listeners, observers, timers and frame callbacks are released on stop.
No sampling runs before the action or after stop. Reports remain renderer-local
in memory until replaced or unmounted; copying is an explicit clipboard action.
They use capture-local aliases for routes and row identities and contain no
message text, session titles, raw URLs, keyboard values, screenshots or DOM HTML.
They are not automatically persisted, uploaded, or exposed through the Hub/MCP.

## Devframe Hub

When the bar is enabled, Desktop starts one Devframe Hub on `127.0.0.1`, choosing
the first available port from 9765 through 9785. The Hub composes the `lody-devbar`
definition with the official Inspector and Accessibility Inspector. The React
metrics bar sends validated samples over type-safe RPC,
publishes a 120-sample replayable stream, and updates a shared snapshot and
JSON-render view. The node side retains at most 120 samples and 100 Long Tasks
while preserving aggregate Long Task totals for the current process lifetime.

The enabled Hub always includes the aggregate HTTP MCP endpoint and the official
Terminals add-on; enabling Devbar is the one consent step for both. MCP exposes
the read-only performance query, shared state, Markdown resource, Inspector
tools, and Terminals tools. Browser sample ingestion is not agent-facing.
Terminals allows an interactive local shell and subprocess sessions; arbitrary
command requests stay disabled, but shell access is still privileged, so the
Devbar control also grants that capability to trusted local callers. Stopping
Devbar removes both capabilities.

The Hub gates its RPC transport inside this single-user loopback mode instead of
showing Devframe's browser trust prompt. The packaged `file://` renderer
authenticates with a per-process token delivered over IPC; the embedded dock
script reads the same token from the page. Hub pages on the loopback origin, the
development renderer origin, and local non-browser callers that send no Origin
header remain trusted. Opaque origins such as `null` — indistinguishable between
the packaged page and a sandboxed frame in another browser — connect only with
the token, and the Lody-owned `/__lody/*` routes refuse them outright. The HTTP
host still rejects other browser origins. The normal renderer entry keeps its
existing CSP. A Devbar-only renderer entry permits loopback Hub scripts,
frames, and connections plus the Iconify endpoint used by the official UI. Because
Electron loads the host page from `file://`, Hub iframe dock URLs are published as
absolute loopback URLs instead of root-relative paths. Filesystem management,
code-server, non-loopback binding, and remote access are out of scope and require a
separate capability decision and authentication plan.

Coding-agent hosts should configure Devframe's stdio `devframe connect` connector
once instead of pinning the HTTP port. The connector discovers the running instance
registry, supplies the required loopback Origin header, and proxies the Hub's
read-only and terminal tools. Agent-authored Lody MCP entries
remain disabled until reviewed and selected in trusted UI or CLI.

Failure to start the Hub leaves the primary window on its normal renderer and
reports the error in Settings. A later embedded-client disconnect does not stop
local sampling, so the footer can reconnect without losing the bounded node-side
history. The official Hub UI and built-in plugin assets ship as version-locked
package assets and work both embedded and standalone. A portable static snapshot
still requires the build adapter; live Terminals cannot be included in a static
build. CPU profile capture remains a separate privileged phase.

## Evidence

- [Renderer](../apps/electron/src/renderer/src/devbar/index.tsx)
- [Devframe definition](../apps/electron/src/main/services/devbar/devframe.ts)
- [Main service](../apps/electron/src/main/services/devbar/service.ts)
- [Shared diagnostic contract](../packages/shared/src/devbar.ts)
- [Deterministic tests](../apps/electron/src/devbar.test.mjs)
- [Devframe bridge decision](../.agents/notes/implemented/architecture/2026-09-16-devbar-devframe-bridge.md)
- [Devframe Hub UI decision](../.agents/notes/implemented/feature/2026-09-16-devbar-hub-ui.md)
- [Merged agent-access gate](../.agents/notes/implemented/simplification/2026-09-23-devbar-agent-access-merged.md)
- [Electron metrics](https://www.electronjs.org/docs/latest/api/structures/process-metric)
- [CLS definition](https://web.dev/articles/cls)
