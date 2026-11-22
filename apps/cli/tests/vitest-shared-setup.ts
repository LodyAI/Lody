import { afterEach, beforeEach, vi } from 'vitest';

let environment: NodeJS.ProcessEnv;
beforeEach(() => {
  // Capture after suite-level setup, so beforeAll-owned environment stays valid
  // across that suite while direct per-test assignments cannot leak.
  environment = { ...process.env };
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const key of Object.keys(process.env)) {
    if (!(key in environment)) delete process.env[key];
  }
  Object.assign(process.env, environment);
});
