# Daemon commands resolve their workspace without discovery

Status: implemented
Translation: current

[中文](2026-10-27-daemon-command-workspace-access.zh.md)

## Abstract

Daemon-hosted MCP Session tools already ran against their bound workspace replica,
but each one first fetched the login's full cloud workspace list. As a result, an
outage or incompatibility in that discovery endpoint failed local list, archive and
create operations. Cloud daemon commands now take their workspace description from
the access verdict the Fleet already maintains: the live access subscription, or the
cached entry the runtime booted from before that subscription first answers. Only a
confirmed revocation or token rejection denies a command. A subscription that cannot
be reached keeps the last authorized verdict, the same rule that keeps the runtime
itself running. Standalone `--offline` session reads and export resolve from this
login's local workspace catalog.

## Problem and evidence

`resolveWorkspaceOrThrow` honored only the local-platform `SessionCommandEnvironment`.
On a cloud daemon, `withDaemonCommandScope` installs only the `DaemonWorkspace`
context, so every tool that resolved its workspace called `listWorkspacesForToken`
before `withWorkspaceManager` borrowed the daemon replica. The October 2026 failure
was caused by a client sending `includeEncrypted` to a backend that rejected the
field. The production backend now accepts it, but the extra round trip remained:
offline networks, slow networks and later discovery failures would cause the same
blocking. `session.ts` had a separate resolver that queried the same list even for
`--offline`.

## Decision

- `DaemonWorkspace.readAccess()` returns `authorized` (with the summary), `revoked`,
  `unauthorized` or `unknown`. `LodyFleet.readWorkspaceAccess` answers synchronously:
  - a token rejection is reported as `unauthorized`;
  - the latest remote snapshot answers next, with absence meaning `revoked`;
  - before any remote snapshot, the cached bootstrap entry is used;
  - if no source covers the workspace, the answer is `unknown`.
- In daemon scope, the account and machine must match the daemon. The selector may
  name only the daemon's workspace. An explicit other workspace is rejected, never
  replaced by the current one. `unknown` falls back to the original discovery path
  and keeps its error.
- Role, content mode and genesis hash come only from the server snapshot, or from
  the catalog the daemon wrote from one. They are never synthesized.
  `createLocalSessionCommandEnvironment` stays local-only.
- Each operation keeps its own authorization checks: Machine access, project
  sharing, delegated access and E2EE paths. They are not folded into list
  enumeration, and no per-call cloud check was added in its place.
- Standalone CLI keeps online discovery for unknown, ambiguous and all-workspace
  selection. `--offline` reads active catalog entries only when the catalog
  identity matches the login. A different login or no entries gives an explicit
  error, never an empty list.

## Alternatives rejected

- Making the local environment serve cloud too: it would assign an `owner` role
  and local machine rules, a privilege escalation.
- Adding a per-command cloud access query instead of enumeration: the same
  availability dependency under a different name.
- Requiring a connected subscription: a network fault would block local work
  without improving revocation, because the old per-call query fails in the same
  conditions.

## Verification and limits

`daemon-session-tools.test.ts` runs real `lody_session_list` and
`lody_session_archive` handlers with discovery rejected. It covers:

- zero list calls;
- refusal after revocation;
- recovery without a restart;
- the `unknown` fallback keeping the discovery error;
- account, machine, selector and summary mismatches;
- a token rejection;
- borrowed-replica failure paths.

A Fleet test feeds the real subscription callbacks in this order: bootstrap, an
authorized snapshot, a subscription error, removal, restoration, then token
rejection. `command-runtime.test.ts` covers online ambiguity and error propagation,
plus offline catalog identity and `remote_missing` handling. No live MCP run
against production was performed. While the subscription is disconnected, a
revocation is enforced once the subscription reconnects. Standalone `--offline` E2EE
opening and other standalone commands still need their own network paths.

Related: [daemon-hosted MCP workspace commands](../architecture/2026-10-16-daemon-hosted-mcp-workspace-commands.md).
