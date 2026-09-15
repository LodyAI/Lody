# Session machine access verification

Status: draft
Translation: current

[中文](session-access-verification.zh.md)

Creating a Session or sending a message may need the Lody control plane to verify that the
requester can use the target Machine. A definitive allow continues and a definitive denial stops
immediately. A transport failure is not a denial: command validation retries it for a short,
bounded window, then returns a retryable `MACHINE_ACCESS_UNAVAILABLE` result without creating or
dispatching work.

Machine presence and access verification answer different questions. A fresh Loro Streams
presence heartbeat means the Machine was recently reachable through the presence channel; it does
not prove that the control-plane access query is reachable. The UI and agents must not use an
`online` label as evidence that access verification succeeded.

When retries are exhausted, diagnostics preserve the nested transport cause and error code when
the runtime provides them, such as `ECONNRESET`, `ENOTFOUND`, or `ETIMEDOUT`. Retryable failures
remain fail-closed: callers may retry the same command, but the CLI never treats an unavailable
authorization service as permission.

## Workspace reads and Operation acceptance

Cloud commands may first enumerate workspaces with the CLI credential, including when the target
is on the same machine. This read retries only transient transport failures, with at most four
attempts, a five-second attempt limit and a ten-second overall limit. Exhaustion returns
`WORKSPACE_ACCESS_UNAVAILABLE`; explicit credential rejection returns `WORKSPACE_ACCESS_DENIED`.
Malformed responses and missing configuration are non-retryable `WORKSPACE_RESOLUTION_FAILED`.
Cancellation aborts the pending workspace fetch. None of these failures grants access or extends
cached authorization. Workspace exclusion and machine permission checks still fail closed.
This does not change the OSS local-only composition or add an offline cloud-desktop contract.

For single MCP `session_chat`, acceptance in the local Operation store is the durable boundary.
Before acceptance, a failed read creates no new work. After acceptance, a materialization failure
returns the stored active Operation for existing coordinator recovery, not a rejected send.
A missing receipt after acceptance may have happened returns `OPERATION_RESULT_UNAVAILABLE`:
query the original Operation ID, never allocate a new ID to compensate. Same-ID chat replay still
requires the same command, requester and source Turn. Best-effort synchronization cannot invert
a durable success. Request cancellation does not revoke an already accepted Operation.
If cancellation overlaps possible acceptance, the first handler result must be the stored receipt
or retryable `OPERATION_RESULT_UNAVAILABLE`, never a generic non-retryable internal error.
Before acceptance starts, cancellation does not require an Operation receipt. A disconnected
transport may not deliver any handler result; callers still recover using the original ID.

The manager is released after its outstanding non-cancelable legacy calls settle, including if
cancellation occurs during acquisition. This is not a whole-command timeout. Failure diagnostics
contain stage, acceptance state, Operation ID, a safe endpoint label and bounded allowlisted cause
codes/statuses, not prompts, credentials, raw error messages or sensitive URLs.

## Evidence

The bounded command retry and diagnostics are implemented in
`apps/cli/src/session/session-access-retry.ts`. Command access checks enter it through
`apps/cli/src/commands/session.ts`; MCP single and batch results preserve retryability through
`apps/cli/src/mcp/machine-access-error.ts`. Deterministic coverage is in
`apps/cli/tests/session-access-retry.test.ts` and
`apps/cli/src/mcp/machine-access-error.test.ts`.

This draft records the requested behavior. Tests do not establish deployed-client recovery.

Workspace Effect boundaries are in `apps/cli/src/lib/workspace.ts` and `command-runtime.ts`;
single-chat orchestration is in `apps/cli/src/mcp/lody-mcp-server.ts`. Deterministic coverage is in
`apps/cli/src/lib/workspace.test.ts` and `apps/cli/src/mcp/session-chat-network-boundary.test.ts`.
The latter uses a synthetic target sink, not a full target daemon.
