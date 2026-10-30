# MCP HTTP request initialization memory

Status: proposed
Type: architecture
Translation: current

[中文](2026-10-30-mcp-request-allocation.zh.md)

## Abstract

The shared MCP HTTP host has both substantial idle loading cost and repeated
request initialization cost. In an isolated production build, 2,000 sequential
read-only tool-list requests increased host RSS from about 315 to 626 MiB while
post-GC live JS heap stayed near 96 MiB. Allocation sampling attributes about 66%
of allocated bytes to JSON-schema conversion. A temporary prebuilt catalog with
fresh servers/transports reduced final RSS to 349 MiB. This is still an experiment
using private SDK fields to extract definitions; the proposed change shares only
immutable tool definitions/schema work and keeps per-request protocol, transport,
cancellation and calling context independent.

## Conditions and scope

The source is `fc385258174e577aafcf7ce4c43511574e9de987` (main
`39c252437a9b265d43df364baa5752ba657cac19` plus
[message primitive reuse](../../implemented/architecture/2026-10-30-desktop-schema-initialization.md)).
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
to stdio; permanently disabling HTTP is not the proposed product change.

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

`mcp/lody-mcp-http-host.ts` builds a new tool server for every legacy HTTP request;
the modern protocol path likewise constructs a request-scoped handler around the
factory. `buildSessionToolServer` recreates the tool configuration/schema graph
and registers all tools. The SDK converts schemas during registration and again
when listing tools.

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

## Proposed implementation boundary

Construct immutable input/output schemas and static tool definitions once at
process scope, before requests. Create a fresh SDK server/transport and bind the
existing request context for each request. Keep handlers bound to their actual
request/transport where needed; cached closures must not pin the first server.
Pure JSON conversion can be memoized by explicit conversion target and input/output
mode, but JSON caching alone did not establish a memory reduction here.

Preserve bearer/peer authorization, ALS session/workspace/machine scope, active-turn
checks, tool argument validation and the separate raw-work owners. SDK close or
request cancellation does not prove a delegated tool's raw work has finished.
A process-lifetime catalog must not capture user data, credentials or the first
caller's capabilities. Do not copy the prototype's private SDK field access or
prototype overrides into product code. The candidate concerns pure construction;
it does not require rewriting the Effect/stdio lifecycle.

## Required validation and limits

Production acceptance must compare all tool definitions and invalid-input behavior,
exercise both supported HTTP protocol paths, concurrent requests from distinct
sessions/workspaces, cancellation/response close, and independent handler/transport
state. Repeat the allocation workload against the supported implementation with fresh
servers and prove the resident
cost improves without sharing protocol state. SDK tool updates or conditional
catalog variants need explicit invalidation/ownership rather than a hidden
name-only cache. Packaged builds, other operating systems, real-provider request
rates, idle recovery over long periods and a bound on memory growth are unverified.

No product implementation of this proposal has been applied. This note supersedes
no active decision: startup command loading and message primitive reuse have
different ownership and temporal boundaries.
