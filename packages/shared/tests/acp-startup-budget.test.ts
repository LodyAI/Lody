import { describe, expect, it } from 'vitest';

import {
  ACP_CAPABILITIES_REFRESH_CLIENT_BACKSTOP_MS,
  ACP_CAPABILITIES_REFRESH_MACHINE_BUDGET_MS,
  ACP_COLD_NPX_INIT_TIMEOUT_MS,
  ACP_INIT_TIMEOUT_MS,
  ACP_NEW_SESSION_TIMEOUT_MS,
  ACP_NPX_STARTUP_MAX_ATTEMPTS,
  ACP_STARTUP_ATTEMPT_MACHINE_BUDGET_MS,
  ACP_STARTUP_QUEUE_WAIT_TIMEOUT_MS,
} from '../src/acp-startup-budget';

describe('acp startup budget', () => {
  it('covers the slowest initialize followed by session/new in one attempt', () => {
    expect(ACP_COLD_NPX_INIT_TIMEOUT_MS).toBeGreaterThanOrEqual(ACP_INIT_TIMEOUT_MS);
    expect(ACP_STARTUP_ATTEMPT_MACHINE_BUDGET_MS).toBe(
      ACP_COLD_NPX_INIT_TIMEOUT_MS + ACP_NEW_SESSION_TIMEOUT_MS
    );
  });

  it('covers every attempt the npx recovery policy may make, not just the first', () => {
    // A cold `initialize` timeout is a reason for the machine to purge and try
    // again, and each retry gets the full per-attempt timeouts. Budgeting one
    // attempt lets the client expire during attempt two or three — while the
    // machine is still executing the recovery it intended — and report a
    // client timeout instead of the machine's own final reason.
    expect(ACP_NPX_STARTUP_MAX_ATTEMPTS).toBeGreaterThan(1);
    expect(ACP_CAPABILITIES_REFRESH_MACHINE_BUDGET_MS).toBeGreaterThan(
      ACP_NPX_STARTUP_MAX_ATTEMPTS * ACP_STARTUP_ATTEMPT_MACHINE_BUDGET_MS
    );
  });

  it('covers the wait for a start slot, which happens before any attempt', () => {
    // The session-start gate queues outside `runNpxStartupWithRecovery` and
    // emits no progress frame, so queue time is silence the client counts. A
    // budget that starts at the first attempt expires requests whose work had
    // not begun — and the machine has no reason to report for them.
    expect(ACP_STARTUP_QUEUE_WAIT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(ACP_CAPABILITIES_REFRESH_MACHINE_BUDGET_MS).toBeGreaterThanOrEqual(
      ACP_STARTUP_QUEUE_WAIT_TIMEOUT_MS +
        ACP_NPX_STARTUP_MAX_ATTEMPTS * ACP_STARTUP_ATTEMPT_MACHINE_BUDGET_MS
    );
  });

  it('keeps the client backstop strictly above the machine budget', () => {
    // A client deadline at or below the machine budget expires requests the
    // machine is still working on, and reports a transport timeout instead of
    // the machine's own failure reason.
    expect(ACP_CAPABILITIES_REFRESH_CLIENT_BACKSTOP_MS).toBeGreaterThan(
      ACP_CAPABILITIES_REFRESH_MACHINE_BUDGET_MS
    );
  });
});
