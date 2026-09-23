# Remote daemon lifecycle acknowledgements

Status: draft
Translation: pending

## Accepted work and response delivery

An authorized restart or upgrade that the CLI has accepted must proceed even when
its acknowledgement cannot be delivered. Upgrade acceptance still requires the
existing upgrade intent to be written successfully. Rejected operations never
trigger a lifecycle exit.

The RPC server first attempts to deliver the accepted response, with a total
five-second budget. Success, exhausted delivery retries, or deadline expiry then
invoke the existing CLI lifecycle callback. An ACK delivery error is diagnostic;
it must not produce a contradictory operation-failed response. Late completion of
that attempt must not invoke the callback again.

The existing process boundary retains its one-time exit guard. This contract does
not add process-wide preparation serialization or cross-restart request deduplication.
The deadline bounds waiting, not cancellation of the underlying HTTP request.
A client timeout means the outcome is unconfirmed; it does not cancel accepted work
or prove that the daemon failed to restart or upgrade. Completion reporting is separate.

## Implementation evidence

- [RPC acknowledgement handling](../packages/loro-streams-rpc/src/machine-rpc-server.ts)
- [CLI callback wiring](../apps/cli/src/lib/message-handler.ts)
- [Process exit boundary](../apps/cli/src/commands/start.ts)
- [Synthetic transport tests](../packages/loro-streams-rpc/tests/machine-rpc-server.test.ts)
