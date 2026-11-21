# Remote daemon lifecycle acknowledgements

Status: draft
Translation: current

[中文](machine-lifecycle-ack.zh.md)

## Managed operation proposal

The [managed daemon update draft](daemon-upgrade-installation.md) extends this
contract with a durable, machine-wide update operation. The managed implementation
uses that operation; ordinary restart retains the callback boundary below.

Accept only after owner authorization, target resolution and local operation
persistence succeed. The immutable request binds operation ID, machine generation,
action, exact release and interruption policy. An exact retry returns the same
operation; reusing its ID with different inputs is rejected. Serialize lifecycle
operations across workspaces and process restarts. A new request while one is
active returns its identity; it must not replace the target or interrupt it.

ACK loss does not cancel accepted processing. Processing can end in preparation
failure, cancellation, expiry, authority refusal, applied, rolled back or recovery
failed; acceptance never promises unconditional interruption. Recheck current
authority before the switch. Waiting for idle has a persisted expiry. A fresh
authorization for the same immutable operation may renew authority, never revive
an expired/cancelled operation or silently extend its waiting deadline.

Persist ordered progress and terminal results locally before publication. Retain
operation identity/outcome across daemon replacement, with an explicit replay
rejection floor when detailed records expire. Lost responses are resolved by
querying the same operation, never by automatically issuing another restart.
Unknown or disconnected is not a terminal failure. Result queries and cancellation
use the same owner authority; reports bind operation ID, machine generation,
actual running release and a monotonic revision so stale messages cannot win.
Local application can complete while remote publication is offline. UI confirms
success only after observing that authenticated applied result.

## Accepted work and response delivery

An authorized restart or upgrade that the CLI has accepted must proceed even when
its acknowledgement cannot be delivered. Upgrade acceptance still requires the
managed operation to be written successfully. Rejected operations never
trigger a lifecycle exit.

The RPC server first attempts to deliver the accepted response, with a total
five-second budget. Success, exhausted delivery retries, or deadline expiry then
invoke the existing CLI lifecycle callback. An ACK delivery error is diagnostic;
it must not produce a contradictory operation-failed response. Late completion of
that attempt must not invoke the callback again.

The existing process boundary retains its one-time exit guard. Managed updates add
process-wide preparation serialization and durable request-ID replay rejection;
ordinary restart does not acquire those update guarantees.
The deadline bounds waiting, not cancellation of the underlying HTTP request.
A client timeout means the outcome is unconfirmed; it does not cancel accepted work
or prove that the daemon failed to restart or upgrade. Completion reporting is separate.

## Implementation evidence

- [RPC acknowledgement handling](../packages/loro-streams-rpc/src/machine-rpc-server.ts)
- [CLI callback wiring](../apps/cli/src/lib/message-handler.ts)
- [Process exit boundary](../apps/cli/src/commands/start.ts)
- [Synthetic transport tests](../packages/loro-streams-rpc/tests/machine-rpc-server.test.ts)
