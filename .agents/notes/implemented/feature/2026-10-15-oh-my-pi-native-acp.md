# Oh My Pi through the local ACP registry

Status: implemented
Translation: current
PR: [#1586](https://github.com/LodyAI/Lody/pull/1586)

[中文](2026-10-15-oh-my-pi-native-acp.zh.md)

## Abstract

Users with an installed Oh My Pi could only configure its ACP command manually.
The registry now exposes Oh My Pi as `oh-my-pi`, launching the user's `omp acp`
through the existing provider lifecycle. It also recognizes OMP's default skill
directories. Windows shutdown also verifies that taskkill status 128 actually
means the process exited, allowing forceful cleanup when a console process refuses.
The integration depends on OMP's advertised standard ACP capabilities;
it does not supply terminal widgets or the separate Lody Core RPC adapter.

## Decision and scope

Use a local registry launcher, as for OpenCode, with `--version` in its version metadata.
The generator retains this launcher even when a remote registry supplies metadata
for the same id. No OMP download, managed-runtime manifest, protocol bridge, or
Pi migration is introduced. Credentials and custom profiles remain OMP-owned.
Provider search includes the local executable name, so `OMP` remains searchable
when remote metadata replaces the fallback description.

The upstream [native ACP request](https://github.com/LodyAI/Lody/issues/1264)
also proposes slash-command transport and interactive components; those remain
separate work. The [RPC adapter request](https://github.com/LodyAI/Lody/issues/930)
targets additional Core semantics and an independently released adapter. Neither
issue is closed by this focused registry entry.

The [OMP v18.11.0 ACP implementation](https://github.com/can1357/oh-my-pi/blob/v18.11.0/packages/coding-agent/src/modes/acp/acp-agent.ts)
defines the native protocol. Its configuration and skill discovery use OMP's own
profile, not Pi's. The static Skills catalog adds only the default `.omp/skills`
and `~/.omp/agent/skills`; it does not infer named-profile directories. Bump the
Skills cache version so existing installations refresh the expanded directory list.

## Windows process cleanup

Testing OMP through Lody's actual ACP launcher exposed an existing process-owner
bug: `taskkill /T` returns 128 both for an absent PID and when a console process
requires `/F`. Treating either result as success left OMP and its MCP child alive.
The shared Windows process boundary now accepts 128 as gone only after Node has
observed the root exit. A live root follows the existing graceful-to-force path;
a refused forceful termination surfaces `TerminationFailed` to the owning scope.
ACP shutdown remains the trigger, the existing process lease owns cleanup and
failure recovery, and prompt cancellation remains an ACP request. No caller-side
kill loop or new ownership boundary is introduced. An already-exited root is
never signaled by PID; tracking descendants after their root exits remains outside
this change. The module already uses native Effect v4, so no migration is needed.

## Verification

Generator tests cover fallback discovery and remote metadata without launcher
replacement or duplicates. CLI tests exercise launch resolution and cache identity.
Dialog tests exercise provider search, save, edit, and removal of Pi-only overrides
when switching provider. Skills tests cover the default OMP directories.
Windows regressions reproduce status 128 with a live descendant, require both
processes to exit after escalation, and require an explicit failure if force fails.

Official OMP v18.11.0 on Windows x64 passed 11 native ACP checks and eight checks
through Lody's actual launcher and client, using an isolated profile, a loopback
synthetic model and a stdio MCP fixture. The latter verified model selection,
streaming, cancellation, exact session restoration and MCP execution, with both
shutdowns escalating from status 128 to `/F` and leaving no OMP or MCP process.
No stdin fallback was used. Real authentication, Electron UI, permission UI,
images, HTTP/SSE MCP and other platforms remain unverified. Full check results
and reproduced pre-existing Windows test failures are reported in the pull request.
