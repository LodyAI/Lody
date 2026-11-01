# Message schema initialization memory

Status: implemented
Type: architecture
PR: [#2100](https://github.com/LodyAI/Lody/pull/2100)
Translation: current

[中文](2026-10-30-desktop-schema-initialization.zh.md)

## Abstract

Repeated primitive Zod construction contributes to desktop startup memory. Message
contracts now share three private string rules while preserving separately exported
ID schemas, field constraints and nullable image preprocessing. Two production-build
comparisons reduced main/renderer post-GC live JS heap by 5.26–5.45 MiB. A broader
20 MiB sharing experiment informed the choice but is not this implementation;
whole-application physical-memory savings and long-running behavior remain unproven.

## Decision

`packages/shared/src/message-schemas.ts` reuses plain strings, optional strings and
trimmed nonempty strings at 344 equivalent initialization sites. The rules are
private constants, with no runtime memoizer or build transform. Other string rules,
callbacks, refinements, schemas in other modules and exported ID instances remain
independent. Field-specific constraints and metadata derive schemas from the rule;
Zod's `.register` mutates identity-bound registry state and must not decorate the
shared primitive itself. Parsing still receives each field's own issue path.

A temporary cross-module factory cache shared 629 closed primitive/wrapper
expressions across 2,393 source occurrences in 57 modules. Its larger benefit did
not justify introducing automatic interning: shared identity affects metadata and
reference factoring, and the mechanical scope would obscure a small first change.
The selected implementation covers one owning module with explicit declarations.

## Measurements

All observations use macOS 27.2 arm64, Electron 44.9.3, Zod 4.3.6 and a Node 24.22.1
driver. Every run owns a fresh OSS local profile and endpoint, completes onboarding
and explicitly collects garbage. Main argv and renderer URL identify the actual
build. The production comparison uses main `39c252437a9b265d43df364baa5752ba657cac19`,
substituting its original message module for the baseline. Both runs use the same
bundled CLI; these numbers measure main and renderer only. Playwright tracing is
never started in this comparison.

| Post-GC live JS heap, MiB | Original message rules | Shared message rules |
| --- | --- | --- |
| Main | 50.17–50.19 | 48.33–48.34 |
| Renderer | 80.28–80.33 | 76.73–76.86 |
| Paired combined reduction | — | 5.26–5.45 |

The earlier broader experiment used `54b3f19e570c6b001e3f98ce825f85df2b38e739`,
including the separate [MCP entry change](https://github.com/LodyAI/Lody/pull/2099).
It stopped Playwright tracing before measurement. Reusing primitives across modules
reduced main heap from 50.14–50.22 to 43.35–43.44 MiB and renderer heap from
80.19–80.47 to 66.88 MiB: 20.19–20.29 MiB combined. Instance counts in its first
pair fell from 3,657 to 2,386 in main and 6,290 to 3,601 in renderer. A distinct
pure-initializer experiment over 237 message declarations produced main heap
50.77–50.78 and renderer heap 80.39–80.40 MiB, providing no live-heap reduction.

[Samples and conditions](assets/2026-10-30-schema-memory.json) keep these experiments
separate. Broader-experiment main footprint was 213.6–216.3M versus 174.7–176.1M;
renderer ranges overlapped at 275.1–315.8M versus 274.1–278.9M. RSS includes shared
mappings; compression, allocator state and graphics ownership prevent converting
these samples into a unique-memory total. `vmmap` could not inspect PartitionAlloc.

A separate synthetic four-conversation run found 6,720 reachable renderer Zod
instances and 3,657 in main. Nonoverlapping dominator subgraphs rooted at Zod
instances, excluding weak edges, owned about 32.0 and 18.2 MiB. This identifies
ownership, not an entirely recoverable budget. After eight approximately 128 KiB
code replies, returning home changed warmed renderer heap from 90.9 to 101.0 MiB,
with DOM nodes falling from about 43,000 to 4,000 and a bounded token cache owning
9.47 MiB. Closing the idle highlight worker changed footprint by only about 3M.
The filesystem watcher used 61.6–61.8 MiB RSS and 13.1M footprint across empty,
20,000-file and real-checkout cases on this Mac. Neither observation supports a
residency-policy change; the withdrawn historical implementation in the separate
[residency proposal](../../proposed/architecture/2026-10-17-session-residency.md)
remains unrelated.

## Compatibility boundary

The owning [message suite](../../../../packages/shared/tests/message-schemas.test.ts)
pins independent trimming, ordinary optional strings versus nullable image metadata,
issue paths and inline JSON schema output. Existing RPC/history suites cover the
consuming boundaries. A baseline comparison of 178 exported schemas found identical
default draft-7 input JSON schemas and 3,382 valid/invalid parsing outcomes. The
locked MCP SDK uses the same default inline conversion. Opt-in `reused: 'ref'`
changes reference factoring under sharing; byte equality for that option is not a
guarantee of this change.

The broader temporary build also completed synthetic ACP setup, long replies,
return-home/reopen and rejection of malformed real `machineRpc.send` IPC. That
experiment is not a substitute for production-scope validation. No claim is made
about packaged builds, other platforms, real model runtimes, startup latency or
CLI/daemon/MCP memory savings. This decision supersedes no active note: the MCP
entry and test-module-graph decisions concern different loading boundaries.
