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

## Evidence

The bounded command retry and diagnostics are implemented in
`apps/cli/src/session/session-access-retry.ts`. Command access checks enter it through
`apps/cli/src/commands/session.ts`; MCP single and batch results preserve retryability through
`apps/cli/src/mcp/machine-access-error.ts`. Deterministic coverage is in
`apps/cli/tests/session-access-retry.test.ts` and
`apps/cli/src/mcp/machine-access-error.test.ts`.

This draft records the requested behavior. Tests do not establish deployed-client recovery.
