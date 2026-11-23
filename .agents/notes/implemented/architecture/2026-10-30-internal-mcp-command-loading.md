# Internal MCP command loading

Status: implemented
Type: architecture
PR: [#2099](https://github.com/LodyAI/Lody/pull/2099)
Translation: current

[中文](2026-10-30-internal-mcp-command-loading.zh.md)

## Abstract

Every internal MCP process previously loaded the complete CLI command registry,
including daemon and interactive command implementations, before parsing its
arguments. The CLI now registers only the existing MCP helper commands when its
first argument is `__internal`, while ordinary invocations retain the complete
registry. The application runtime, cleanup, MCP transports and subprocess isolation
are shared as before. A local production-bundle probe reduced HTTP MCP RSS after
initialization and tool discovery from about 310 MiB to 236 MiB; this changes fixed
loading cost rather than cache limits, retained history or concurrency.

## Decision

`apps/cli/src/index.ts` keeps the runtime guard as its first import and retains
instrumentation, application Layers, environment setup, error handling and disposal.
It imports `commands/register.ts` only for invocations whose first argument is not
`__internal`. That module registers the same Command objects in the same order,
including the cloud-only migration command and hidden E2EE command. Public help,
version, aliases and options continue through the complete Commander tree; no
second command-description table is maintained.

Both internal MCP commands use their existing implementations. The HTTP host
remains a daemon-owned subprocess with its existing token, fd 3 handshake and stdin
shutdown. The stdio fallback retains its existing Effect connection lifecycle.
This is a module-loading boundary; native lifecycle ownership and the migration
ledger are unchanged.

The first development build exposed an important packaging constraint: splitting
the registry moves shared application code into chunks, but worker and adapter
owners resolve siblings relative to `import.meta.url`. Application chunks therefore
remain at the output root in both esbuild and Vite builds. Vite dependency and
CommonJS-helper chunks can remain under `chunks/`; the existing development
no-hoisting assertion is retained. Sourcemaps and flat worker entries remain.

## Alternatives and related decisions

- Moving the HTTP host into the daemon would remove a process but put synchronous
  SQLite and tool work onto the daemon event loop. The existing process boundary
  is retained; [daemon-hosted workspace commands](2026-10-16-daemon-hosted-mcp-workspace-commands.md)
  explains the separate ownership of workspace replicas and authorization.
- Deferring every public command would require preserving Commander discovery,
  help and parsing while implementations are absent. The narrower internal route
  removes measured duplicate loading without introducing that wider compatibility
  surface. Public help and version still load the full public registry.
- Keeping application chunks under `chunks/` broke the existing worker-layout
  check. Moving those chunks beside the entries preserves current filename-based
  lookups without refactoring worker owners across unrelated modules.

## Measurements

The base is `dddbe5873444941f60623569931d2ba9413ba3e8`. The comparison uses its
unchanged production CLI and this change on one Apple Silicon Mac, under the
pinned Electron 44.9.3 Node runtime. Each standalone sample starts a fresh process
with an isolated short `LODY_DATA_DIR`, blocks outgoing network access, waits for
the HTTP listening handshake and forces GC. Synthetic loopback requests perform
initialization, list all tools, reject a wrong bearer token and reject invalid tool
arguments; no Agent, user workspace or hosted service participates. Each variant
has two fresh processes.

| Standalone HTTP MCP metric | Base | Changed |
| --- | ---: | ---: |
| RSS after requests and GC | 309.59–309.88 MiB | 235.38–236.36 MiB |
| Used JS heap after requests and GC | 96.59–96.61 MiB | 69.61–69.62 MiB |
| Initialize request | 35.1–35.5 ms | 26.8–27.9 ms |
| First tool-list request | 16.3–18.7 ms | 12.3–13.1 ms |

All 36 tool definitions and full schemas, initialization results, invalid-tool
responses, authentication rejection, GET rejection and EOF exit codes compare
equal. Timing samples are exploratory local observations, not a latency budget.

A separate desktop probe builds the OSS application, completes onboarding, closes
it and launches the same isolated profile again. It waits for local bootstrap,
the prompt and HTTP MCP listening before sampling, with no configured Agent or
workspace content. Three samples follow main/renderer GC in each launch.

| Desktop startup metric | Base | Changed |
| --- | ---: | ---: |
| Sum of process RSS | 1533.38–1534.30 MiB | 1441.94–1442.58 MiB |
| HTTP MCP process RSS | 305.31 MiB | 228.56 MiB |
| HTTP MCP physical footprint (`vmmap`) | 211.5M | 152.6M |
| Renderer used JS heap | 76.22 MiB | 76.18–76.22 MiB |

RSS sums count shared pages repeatedly and do not establish unique application
memory. Physical footprint is per-process OS accounting and must not be added
across processes as unique memory. `vmmap` could not inspect Electron's
PartitionAlloc zone, so allocator breakdown is incomplete. The desktop pair is a
startup observation, not a sustained real-workload benchmark or a comparison with
the installed cloud product.

## Verification and limits

The [published-bundle smoke](../../../../apps/cli/scripts/check-published-bundle-imports.js)
compares internal help through the complete and internal-only routes, checks the
missing-token exit and stdio EOF, and retains native dependency and worker probes.
The [HTTP host suite](../../../../apps/cli/src/mcp/lody-mcp-http-host.test.ts)
pins wire versions, authentication and terminated responses;
[stdio lifecycle tests](../../../../apps/cli/src/mcp/stdio-lifecycle.test.ts)
pin connection shutdown. Existing daemon startup, MCP resolver, telemetry and
[daemon Session-tool tests](../../../../apps/cli/src/mcp/daemon-session-tools.test.ts)
cover their unchanged boundaries.

An external diagnostic additionally compared stdout, stderr and exit codes for
28 ordinary and internal CLI invocations against the base. Real Agent execution,
long-running session workloads, other operating systems, signed installers and
the private cloud composition remain separate acceptance work.
