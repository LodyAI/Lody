# Local Session orchestration through daemon authority

Status: implemented
Translation: current

[中文](2026-09-29-local-session-orchestration.zh.md)

## Abstract

OSS Role mentions instructed agents to create Sessions through a cloud-only MCP
path, and recovery independently required remote workspace lookup and Streams.
Local Session tools now enter the daemon's existing repo through bounded IPC and
share validated handlers, Role resolution and Operation persistence with Cloud.
A scoped command environment supplies local identity, access checks and host
operations; recovery receives explicit authority confirmation. Cloud retains its
existing authentication and remote catch-up requirements. This avoids a second
local replica, with an additional IPC hop for local MCP callers.

## Responsibilities

```text
MCP Session/catalog registration + validation
  Cloud -> existing authenticated command runtime
  Local -> session/call-tool -> daemon scope/active-Turn check
    -> scoped SessionCommandEnvironment -> same handler + Operation store
Operation coordinator -> authority confirmation -> frozen target materialization
  Cloud: remote Streams catch-up
  Local: flush authoritative daemon repo, then recheck fixed Turn
```

`session-tool-router.ts` registers both MCP handlers and the daemon allowlist;
it parses arguments again at the IPC boundary. `daemon-session-tools.ts` binds
the invocation to the active local user, machine and workspace. AsyncLocalStorage
keeps concurrent workspace environments separate and reuses existing command
entry points without global mutation. The scope contains daemon resources, never
caller-selected credentials. Role configuration, accepted target ids, claims,
retry semantics and completion ownership keep their current representations.

Merely skipping login would strand writes in another replica and leave recovery
dependent on Streams. A separate OSS Role implementation would duplicate the
configuration freeze and retry protocol. The selected adapter keeps those shared
and leaves Cloud's path in place. This extends the existing chain-depth decision
in [session orchestration](../../../../specs/session-orchestration.md), not its limit.

## Verification and limits

Real local-repo tests cover Role discovery, prompt expansion into target history,
durable dispatch, repeated Operation acceptance and zero product-cloud traffic.
Coordinator tests cover local authority recovery alongside existing remote
catch-up/duplicate protection and Delivery tests. Packaged desktop interaction
and a real provider response are not established by these tests. Hosted repository
contexts and unrelated cloud MCP operations remain outside local support.
