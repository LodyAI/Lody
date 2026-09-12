# Continue accepted lifecycle work after ACK delivery failure

Status: implemented
Translation: pending
PR: https://github.com/LodyAI/Lody/pull/488

## Abstract

The CLI previously prepared a restart or upgrade but never triggered its exit when
the accepted response could not be appended. Its pending flag then rejected later
requests indefinitely. A shared RPC helper now attempts ACK delivery for at most
five seconds and proceeds with accepted work on success, failure, or timeout.
This narrow fix retains existing process ownership and retry limitations: a client
may time out while the machine still executes the accepted operation.

## Decision and limits

Acceptance is decided by the existing CLI preparation path. Delivery errors are
logged locally; denied requests keep the ordinary response path and never trigger
the lifecycle callback. Rename the internal hook to `onMachineLifecycleResponseSettled`
to reflect its new meaning. Preserve the existing `start.ts` one-time exit guard.

Clearing pending after an ACK error was rejected because the remote append may
already have committed before its response was lost. The deadline bounds waiting;
the underlying append may finish later, but cannot trigger another lifecycle action.
Process-wide serialization, cross-restart deduplication, and completion UI remain
separate work. This is the scoped follow-up to the
[Windows launcher fix](2026-09-08-windows-daemon-upgrade.md) in the same PR.
The [acceptance contract](../../../../specs/machine-lifecycle-ack.md) remains draft.

## Verification

Fake-clock transport tests cover restart and upgrade with ACK success, exhausted
retries, stalled delivery followed by late success or rejection, and denied
operations with successful or failed response delivery. They assert accepted work
advances once without a contradictory error response and denied work never advances.
No real daemon restart, remote network, or wall-clock sleep is used by these tests.

The RPC package passed 110 tests (three optional integration tests skipped), and
the full `pnpm check` passed on macOS. Existing local IPC tests ran outside the
sandbox to allow socket creation. Windows execution remains unverified locally.
