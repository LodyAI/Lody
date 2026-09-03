import { describe, expect, it } from 'vitest';

import {
  ACP_CAPABILITIES_REFRESH_CLIENT_BACKSTOP_MS,
  ACP_CAPABILITIES_REFRESH_MACHINE_BUDGET_MS,
  ACP_COLD_NPX_INIT_TIMEOUT_MS,
  ACP_INIT_TIMEOUT_MS,
  ACP_NEW_SESSION_TIMEOUT_MS,
} from '../src/acp-startup-budget';

describe('acp startup budget', () => {
  it('covers the slowest initialize followed by session/new', () => {
    expect(ACP_COLD_NPX_INIT_TIMEOUT_MS).toBeGreaterThanOrEqual(ACP_INIT_TIMEOUT_MS);
    expect(ACP_CAPABILITIES_REFRESH_MACHINE_BUDGET_MS).toBe(
      ACP_COLD_NPX_INIT_TIMEOUT_MS + ACP_NEW_SESSION_TIMEOUT_MS
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
