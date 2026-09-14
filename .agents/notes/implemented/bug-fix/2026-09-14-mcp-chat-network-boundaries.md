# MCP chat network and acceptance boundaries

Status: implemented
Translation: current

[中文](2026-09-14-mcp-chat-network-boundaries.zh.md)

## Abstract

Cloud MCP chat resolves workspace access and remote metadata before it reads or accepts an Operation, even for a same-machine target. Previously, workspace fetch failure and post-accept materialization failure could both become non-retryable internal errors despite different durable outcomes. The command now uses Effect for bounded read retries, cancellation, scoped manager cleanup and acceptance-aware recovery using the fixed Operation identity. This implementation does not introduce a local route or an offline authorization grant; no deployed-client acceptance is claimed.

## Evidence and recommendation

At `b73c365a7d9afc2e7e10ccd4881130787b3a80e3`, `startSessionChatOperation` calls `resolveWorkspaceOrThrow`, `withWorkspaceManager`, metadata synchronization, and active invocation lookup before `findMatchingRetry`. Workspace enumeration uses a real Convex query without the bounded machine-access wrapper. Unknown errors are mapped to `INTERNAL_ERROR` with `retryable: false`. `operation_get` reads the machine-local store directly and is already useful after an uncertain response.

Only idempotent workspace reads extend the finite retry policy from the [existing access note](2026-09-08-session-access-retry-diagnostics.md): at most four attempts, delays of 250/1000/2000 ms, 5 seconds per attempt and 10 seconds overall. `WorkspaceAccessError` distinguishes unavailable, denied, invalid response and missing configuration. The custom Convex fetch preserves HTTP status and response-body transport failures before SDK conversion; business/schema errors do not enter transport retries. Definitive HTTP rejection wins over message heuristics. Failure diagnostics record stage, acceptance state, Operation identity, safe endpoint category and allowlisted nested cause codes, without raw messages, URLs, prompts or credentials. The Promise adapter unwraps typed failures instead of leaking Effect's FiberFailure wrapper.

```text
workspace read [Effect retry + timeout + AbortSignal]
  → manager scope [acquire / use / release]
  → identity and permission checks
  → SQLite accept [fixed Operation and target Turn]
  → materialize [no command-level replay on failure]
  → stored receipt, or OPERATION_RESULT_UNAVAILABLE
```

Only workspace I/O supports end-to-end cancellation here. Legacy manager acquisition and dispatch Promises are joined before release, so cancellation cannot close the manager during an outstanding write. This can delay cancellation until those ports settle; it is not a whole-command deadline. MCP context is captured and rebound at legacy Promise boundaries to keep concurrent Effect scheduling from mixing requester identities. Effect is already a dependency; no package or storage/wire format changes are needed.

After acceptance, return or recover the stored fixed target. A failure to read the receipt means uncertainty, not rejection or permission to allocate a new Operation. Same-ID chat retries require the same command, requester and source Turn; a later driving Turn must use the existing snapshot/recovery contract. Preserve materialization claims, remote catch-up before replay, and existing best-effort post-dispatch synchronization.

`session-access-policy.ts` already permits only a matching current owner with an active workspace and a previously verified owner snapshot to dispatch locally. `remote_missing` denies; a foreign requester, account mismatch, missing snapshot or unreadable catalog requires remote verification. `verifiedAt` is not a TTL and does not prove current token validity. A future local MCP route must be bound to the exact runtime machine/workspace and active invoking identity, reuse the daemon-owned policy and revocation lifecycle, and never extend its owner grant to remote targets or other workspace members. No new offline grant or cache lifetime is adopted here.

## Validation and limits

The refactor starts from `99e63b0694d5f67eab62bd1dc7df7d548f074b27`. `workspace.test.ts` exercises real Convex parsing, transport/body faults, definitive denial, attempt and total deadlines, and concurrent cancellation. `session-chat-network-boundary.test.ts` exercises the actual MCP handler and SQLite Operation store with injected fetch failures, explicit Promise gates and fake time, including cancellation during acquisition/materialization, lost receipts and same-ID retries. It replaces the mock-call-only chat-sync suite while retaining its single/batch sync and inactive-runtime coverage. The target materializer is a synthetic SQLite sink, not a real target daemon or HistoryWriter; it proves behavior at that port only. Existing coordinator, store and access suites supply adjacent coverage. These tests do not identify the historical DNS/proxy/TLS failure or prove whole-device offline behavior. The [Spec](../../../../specs/session-access-verification.md) remains draft.
