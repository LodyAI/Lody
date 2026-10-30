# MCP HTTP request initialization memory

Status: implemented
Type: architecture
Translation: current

[中文](2026-10-30-mcp-request-allocation.zh.md)

## Abstract

Repeated HTTP MCP initialization rebuilt input schemas for eight tools on every
request, allocating a new schema graph before SDK conversion. The schemas now
live at module scope; each request still creates its own server, transport and
handlers. Two independent production comparisons reduce final host RSS from about
640 MiB to 355–401 MiB after 2,000 requests (37–45%), with live heap unchanged near
99 MiB. This targets repeated allocation and resident high-water cost; it does not remove the host's cold import cost or prove a live-object leak.

## Conditions and scope

The initial attribution source is `fc385258174e577aafcf7ce4c43511574e9de987` (main
`39c252437a9b265d43df364baa5752ba657cac19` plus
[message primitive reuse](https://github.com/LodyAI/Lody/pull/2100)).
Tests use macOS 27.2 arm64, Electron 44.9.3 / Node 24.22.0 / V8
15.2.124.43-electron.0, MCP server SDK 2.0.0 and Zod 4.3.6. The Python/Node drivers
use disposable data directories, ephemeral loopback ports and synthetic context
headers; no real model or conversation is involved. Playwright tracing is never
started for the idle desktop comparison. [Numeric samples](assets/2026-10-30-mcp-request-memory.json)
exclude request payloads, logs, traces and heap contents.

The request probe uses MCP `2025-06-18`: initialize and discover the 36 tools,
then issue 2,000 sequential `tools/list` requests from one synthetic client.
Counters follow explicit responses and a forced GC at each checkpoint. The
catalog remains identical to the published baseline and every host exits cleanly
on stdin EOF. This is a burst resource scout, not a production-rate estimate or
blocking performance assertion.

## Idle ownership

The latest local desktop, without any Agent configured, reaches about 1,750 MiB
of summed process RSS after startup settles. Its process group footprint, as
reported by macOS `footprint` over the owned PID set, is about 1,030.8 MiB. The
HTTP MCP host alone accounts for 303.4 MiB RSS and a `vmmap` footprint of 209.6M.
An isolated `LODY_MCP_HTTP_DISABLED=1` comparison removes that process: RSS is
about 1,462 MiB and group footprint 822.6 MiB. This diagnostic switch falls back
to stdio; permanently disabling HTTP is not the product change.

`LodyFleet` starts the host during daemon startup, even before an Agent needs it.
The subprocess boundary is intentional: the host can perform synchronous SQLite
work and one-shot workspace-manager work that must not block daemon dispatch,
heartbeats or IPC. Keep that isolation. [PR #2099](https://github.com/LodyAI/Lody/pull/2099)
addresses part of cold import cost independently; it is not included in this
study's build and joint savings have not been measured.

GPU footprint initially reached roughly 749–933M in these fresh profiles, but
fell to about 112–113M during subsequent frame/idle checkpoints without a pressure
notification or memory dump. The viewport was 1280×1409 at DPR 2. A separate
Chromium dump identifies large IOSurface/shared-image allocations, including
2560×2818 BGRA scanout buffers. Do not label this transient peak as the cause of
the remaining steady RSS or recommend forced pressure as a fix.

## Request allocation boundary

`mcp/lody-mcp-http-host.ts` still builds a new tool server for every legacy HTTP
request; the modern protocol path likewise constructs a request-scoped handler
around the factory. Before this fix, `buildSessionToolServer` also recreated the
remaining request-local input schema graphs while registering all tools. The SDK
converts schemas during registration and again when listing tools.

| 2,000-request experiment | Final RSS, MiB | Post-GC heap, MiB | Footprint label |
| --- | --- | --- | --- |
| Original, first run | 625.61 | 95.72 | Not sampled |
| Original, independent repeat | 625.86 | 95.74 | 514.0M |
| Reuse prepared schemas after registration arguments are built | 625.59 | 96.06 | 513.4M |
| Also memoize schema JSON at that late boundary | 628.03 | 95.99 | 511.7M |
| Reuse one server, sequential diagnostic only | 332.23 | 95.56 | 224.5M |
| Reuse one server plus schema JSON memoization | 357.11 | 95.81 | 230.7M |
| Prebuilt catalog with fresh server/transport per request | 348.94 | 95.73 | 242.6M |
| Fresh-server/static-catalog independent repeat | 348.08 | 95.74 | 242.4M |

Caching at registration time still evaluates the factory's schema arguments;
these negative experiments matter. The repeated factory, rather than merely its
returned schema identity, is the boundary that needs to move out of requests.
Whole-server reuse is only a counterfactual upper bound: its protocol/client and
transport state cannot be shared across independent real callers. A closer
experiment builds one catalog template, then creates a fresh server and registers
the existing definitions for each request. It preserves all 36 catalog entries
and reduces final RSS by about 277–278 MiB in two fresh-process runs versus the
production baseline.
Tool execution and callback ownership remain unverified in this prototype; it
reads private SDK fields for measurement rather than providing a supported API.

A separate 500-request sampling run at 32 KiB intervals includes objects later
collected by minor/major GC. It estimates about 1,427 MiB allocated cumulatively,
of which 936 MiB (65.6%) have `standardSchemaToJsonSchema` in their stack. These
are allocation estimates, not simultaneously retained bytes. The original host's
old space reserves about 222.5 MiB after 2,000 requests with only 69.5 MiB used;
the server-reuse counterfactual reserves 76.5 MiB with 69.9 MiB used. The evidence
supports allocation churn and resident high-water cost, not a proven unbounded
live-object leak. Allocator attribution remains incomplete because `vmmap` cannot
inspect Electron's PartitionAlloc zone.

## Decision

Construct static input schemas once at module scope. The remaining request-local
schemas belonged to four schedule tools, two discovery get tools, conversation
sharing and operation batch retrieval. They now follow the same lifetime as the
other tool schemas. Tool names, metadata, JSON output, strictness, refinements,
trimming, defaults and daemon-side validation remain unchanged. There is no
name-based cache or SDK-private access in the implementation.

Each request still creates a new SDK server/transport and binds fresh callbacks.
Schemas contain no credentials, invocation context, injected dependencies or client
capabilities. Registration and JSON conversion continue through the supported SDK
API. Bearer/peer authorization, ALS scope and active-turn checks retain their
existing owners. SDK close or request cancellation does not establish completion
of delegated raw work. This is pure construction, so no Effect or stdio lifecycle
migration is needed. Keeping the subprocess and request isolation avoids the
whole-server reuse counterfactual's protocol and callback ownership risks.

## Production measurement

The production pair uses main `d86674c6901a028e8266117af65df261374dd851`
without either earlier memory PR. Both variants are OSS production bundles, run
by the same Electron executable and probe procedure above. Two fresh before/after
process pairs run serially while the repository build/check is inactive. The
fixed build uses only module-scoped schemas and supported SDK registration.

| 2,000 requests | RSS before → after, MiB | Live heap before → after, MiB | Footprint before → after |
| --- | --- | --- | --- |
| Pair A | 641.55 → 354.64 | 99.21 → 99.23 | 529.3M → 247.2M |
| Pair B | 639.63 → 401.17 | 99.21 → 99.31 | 527.0M → 294.1M |

RSS falls by 238–287 MiB (37–45%); `vmmap` footprint falls by 233–282M
(44–53%). All 36 complete tool definitions match on every request, and every host
exits with code zero on stdin EOF. V8 old space reserves 215–217 MiB before and
88–93 MiB after, with live heap essentially unchanged. The second fixed process
still has a higher native resident cost than the first; do not replace this range
with the prototype's best result or treat it as a bound on future growth.

Earlier scouts overlapping a repository build/check varied widely: original final
RSS was 359–563 MiB and fixed RSS 371 MiB. They are retained in the numeric evidence
as disturbed conditions, not used as matched product comparisons. The original's
footprint was 398–529M versus 266M fixed. Build load, GC and native allocation make
RSS alone unsuitable for claiming an exact universal saving.

A separate compiled-wire comparison retains both complete catalogs and all 16
invalid-input responses unchanged across the two protocols. A real OSS Electron
session with a synthetic external ACP provider completes a warmup and two 128 KiB
replies, leaves/reopens the conversation, and rejects invalid IPC. This is behavior
acceptance, not an estimate of idle desktop savings.

## Verification and limits

The owning [HTTP wire suite](../../../../apps/cli/src/mcp/lody-mcp-http-host.test.ts)
drives both MCP 2025-06-18 and 2026-07-28 through real HTTP transports. Two requests
from different sessions/workspaces/machines overlap; aborting the first leaves the
second's response and ALS context intact, and a later proposal still executes with
its own context and trimmed title. Explicit readiness/completion signals retain
uncooperative raw work until it settles. Invalid input remains rejected for all
eight affected tools, including strict unknown-field rejection and bounds.
The existing daemon Session tool suite covers active-turn/access enforcement and
discovery execution against the daemon-owned replica.

Packaged builds, other operating systems, real-provider request rates, long idle
recovery and a bound on memory growth remain unverified. This note supersedes no
active decision: [startup command loading](https://github.com/LodyAI/Lody/pull/2099)
and [message primitive reuse](https://github.com/LodyAI/Lody/pull/2100) have different
ownership and temporal boundaries. Joint savings are not measured.
