# Cache the Linux libc report used for Claude runtime archives

Status: implemented
Translation: current

[中文](2026-10-11-musl-report-cache.zh.md)

## Abstract

On Linux, every Claude managed-runtime archive lookup called `process.report.getReport()`, a synchronous snapshot of the whole process. Capability refresh still does that lookup when it decides whether a stored ACP capability entry is fresh, so a cache hit did not avoid the cost. Profiling of a sluggish daemon attributed most of the sampled CPU to that call. A local hotpatch that memoized the musl check reduced the stall on that machine, so the classification is now stored for the life of the process. The archive choice is unchanged: only Linux Claude Code appends `-musl`, and only when the report has no glibc runtime version. A thrown report is not cached. This does not address other daemon stalls.

## Problem

Discord `#feature-or-bug`, thread "Daemon Stall" (Leynos), reported a Linux Lody daemon that became sluggish and slowed machine interaction. Timer lag reached about 24.5 seconds, with sync timeouts. Logs showed heavy capability-refresh traffic and event-loop lag. Samples spent 64–100% CPU inside `process.report.getReport()`. An empty Node process spent about 9.5 ms per call; a loaded daemon spends more. A local memoization of the musl check measurably reduced the stall.

The call chain on current `main` is:

`refreshMachineAcpCapabilitiesForConfig` → `readFreshAcpCapabilityCacheEntry` → `resolveExpectedAcpCapabilitySourceVersion` (wired as `resolveAcpCapabilitySourceVersion`) → `getRuntimeStatus` → `resolveArchive` → `mapManagedRuntimePlatform` → `isMuslLibc` → `process.report.getReport()`.

`isMuslLibc` runs only for `claude-code` when the mapped platform is `linux`. That is still on the hot path: a capability-cache hit resolves the expected source version before it can answer, and that resolution asks the managed runtime for its archive. The [capability-entry cache](2026-09-16-acp-capability-refresh-cache.md) stops the ACP process probe; it does not stop this lookup.

Host libc cannot change while the process is running. Repeating the snapshot cannot change the archive name.

## Decision

`isMuslLibc` remembers the first successful classification for the process. Darwin and Windows stay non-musl and do not read the report. Linux with `header.glibcVersionRuntime` set selects the glibc Claude archive (`linux-x64`, `linux-arm64`). Linux with no report function, no header, or no glibc runtime version selects `linux-x64-musl` or `linux-arm64-musl`. Other runtime names never receive the suffix. A thrown `getReport` propagates and is retried on the next call, so a transient failure cannot stick as the wrong archive.

A cheaper libc probe was not required. The validated fix is to read this stable answer once. Skipping archive resolution on the capability path would change how a fresh entry is identified and is outside this change.

`apps/cli/src/agent/AGENTS.md` is at the documentation size gate (8190 bytes, limit 8192), so this record holds the rule: do not call `process.report.getReport()` on every Claude archive lookup.

## Verification and limits

Unit coverage presets musl and glibc and checks Claude, Codex, Grok, Kimi, darwin, and win32 archive names. On a Linux host it also checks that a successful report is read once, that a second read is not performed, and that a thrown report is not remembered. An idle call of `getReport()` in this environment took about 11 ms, which matches the reported per-call cost and is not a reproduction of the 24.5-second daemon stall. Loro document loading, history writing, usage scans, and worker-thread compression stay out of this change.

PR: https://github.com/LodyAI/Lody/pull/1436
