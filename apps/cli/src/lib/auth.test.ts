import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  AuthClient,
  isRetryableTokenValidationFailure,
  performLoginWithAuthCredential,
  saveAuthInfo,
  validateExistingToken,
} from './auth';
import { loadEnv } from '@/utils/const';
import { getConfigPath } from '@/utils';
import type { Logger } from '@/utils/logger';

const authMocks = vi.hoisted(() => {
  const spinner = {
    fail: vi.fn(),
    succeed: vi.fn(),
  };
  return {
    deviceCode: vi.fn(),
    deviceToken: vi.fn(),
    openBrowser: vi.fn(),
    ora: vi.fn(() => ({
      start: vi.fn(() => spinner),
    })),
    spinner,
  };
});

vi.mock('better-auth/client', () => ({
  createAuthClient: vi.fn(() => ({
    device: {
      code: authMocks.deviceCode,
      token: authMocks.deviceToken,
    },
  })),
}));

vi.mock('@better-auth/api-key/client', () => ({
  apiKeyClient: vi.fn(() => ({})),
}));

vi.mock('better-auth/client/plugins', () => ({
  deviceAuthorizationClient: vi.fn(() => ({})),
}));

vi.mock('@convex-dev/better-auth/client/plugins', () => ({
  convexClient: vi.fn(() => ({})),
}));

vi.mock('@/utils/open-browser', () => ({
  openBrowser: authMocks.openBrowser,
}));

vi.mock('ora', () => ({
  default: authMocks.ora,
}));

function createTestLogger(): Logger {
  let logger: Logger;
  logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    setLevel: vi.fn(),
    setDebug: vi.fn(),
    child: vi.fn(() => logger),
    close: vi.fn(async () => {}),
  };
  return logger;
}

const originalEnv = { ...process.env };
let tempHome: string | null = null;

beforeEach(() => {
  authMocks.deviceCode.mockReset();
  authMocks.deviceToken.mockReset();
  authMocks.openBrowser.mockReset();
  authMocks.ora.mockClear();
  authMocks.spinner.fail.mockClear();
  authMocks.spinner.succeed.mockClear();
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-auth-test-'));
  process.env.HOME = tempHome;
  process.env.LODY_AUTH_URL = 'https://convex.example.com';
  process.env.LODY_AUTH_SITE_URL = 'https://auth.example.com';
  loadEnv();
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (tempHome) {
    fs.rmSync(tempHome, { recursive: true, force: true });
    tempHome = null;
  }

  process.env = { ...originalEnv };
  loadEnv();
});

describe('AuthClient device login', () => {
  it('keeps the user code in the console login URL while redacting debug response codes', async () => {
    authMocks.deviceCode.mockResolvedValue({
      error: null,
      data: {
        device_code: 'device-code-should-not-be-logged',
        user_code: 'FCDVGEJM',
        verification_uri: 'https://auth.example.com/device',
        verification_uri_complete: 'https://auth.example.com/device?user_code=FCDVGEJM',
        expires_in: 600,
        interval: 0,
      },
    });
    authMocks.deviceToken.mockResolvedValue({
      error: null,
      data: {
        access_token: 'session-token',
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        const urlText =
          typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        if (urlText === 'https://auth.example.com/api/cli/api-key/create') {
          return Response.json({
            apiKey: 'lody_cli_auto_key',
            apiKeyId: 'key-1',
            apiKeyStart: 'lody_cli_',
          });
        }

        return Response.json({
          valid: true,
          userId: 'user-1',
          user: {
            id: 'user-1',
            email: 'user@example.com',
          },
        });
      })
    );

    const logger = createTestLogger();
    const authClient = new AuthClient(logger);
    const result = await authClient.login('test-machine');

    expect(result.success).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('user_code=FCDVGEJM'));

    const debugOutput = vi
      .mocked(logger.debug)
      .mock.calls.map((call) => call.join(' '))
      .join('\n');
    expect(debugOutput).not.toContain('device-code-should-not-be-logged');
    expect(debugOutput).not.toContain('FCDVGEJM');
    expect(debugOutput).toContain('"hasDeviceCode":true');
    expect(debugOutput).toContain('"hasUserCode":true');
  });
});

describe('AuthClient API key login', () => {
  it('validates the provided key and persists CLI credentials', async () => {
    const fetchMock = vi.fn(async () => {
      return Response.json({
        valid: true,
        userId: 'user-1',
        user: {
          id: 'user-1',
          email: 'user@example.com',
          name: 'User One',
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const authClient = new AuthClient(createTestLogger());
    const result = await authClient.loginWithApiKey('  lody_cli_test_key  ', 'test-machine');

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error(result.error);
    }

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.token).toBe('lody_cli_test_key');
    expect(result.user).toEqual({
      id: 'user-1',
      email: 'user@example.com',
      name: 'User One',
    });
    expect(result.machine.machineName).toBe('test-machine');

    const saved = JSON.parse(fs.readFileSync(getConfigPath(), 'utf8')) as {
      token?: unknown;
      user?: unknown;
      machine?: unknown;
    };
    expect(saved.token).toBe('lody_cli_test_key');
    expect(saved.user).toEqual(result.user);
    expect(saved.machine).toEqual(result.machine);
  });

  it('rejects invalid API keys without writing credentials', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return Response.json({ valid: false });
      })
    );
    fs.rmSync(getConfigPath(), { force: true });

    const authClient = new AuthClient(createTestLogger());
    const result = await authClient.loginWithApiKey('lody_cli_bad_key', 'test-machine');

    expect(result.success).toBe(false);
    expect(fs.existsSync(getConfigPath())).toBe(false);
  });
});

describe('AuthClient rejected credential cleanup', () => {
  it('does not delete credentials that were rotated after this process started', async () => {
    const authClient = new AuthClient(createTestLogger());
    const user = { id: 'user-1', email: 'user@example.com' };
    const machine = { machineId: 'machine-1', machineName: 'test-machine' };
    await saveAuthInfo('new-token', user, machine);

    expect(authClient.clearRejectedToken('old-token')).toBe('not_current');
    expect(fs.existsSync(getConfigPath())).toBe(true);
    expect(authClient.getAuthInfo()?.token).toBe('new-token');

    expect(authClient.clearRejectedToken('new-token')).toBe('cleared');
    expect(fs.existsSync(getConfigPath())).toBe(false);
  });
});

describe('AuthClient machine pairing login', () => {
  it('exchanges the one-time token and persists only the issued API key', async () => {
    const pairingToken = 'lody_pair_one_time_secret';
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const urlText = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      if (urlText === 'https://auth.example.com/api/cli/machine-pairing/exchange') {
        return Response.json({
          apiKey: 'lody_cli_temporary_key',
          requestId: 'request-1',
          workspaceId: 'workspace-1',
          expiresAt: Date.now() + 60_000,
          user: { id: 'user-1', email: 'user@example.com', name: 'User One' },
        });
      }
      return Response.json({
        valid: true,
        userId: 'user-1',
        user: { id: 'user-1', email: 'user@example.com', name: 'User One' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const authClient = new AuthClient(createTestLogger());
    const result = await authClient.loginWithMachinePairingToken(pairingToken, 'test-machine');

    expect(result.success).toBe(true);
    const exchangeInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(exchangeInit.body))).toMatchObject({
      token: pairingToken,
      machineName: 'test-machine',
    });
    const saved = JSON.parse(fs.readFileSync(getConfigPath(), 'utf8')) as { token?: string };
    expect(saved.token).toBe('lody_cli_temporary_key');
    expect(JSON.stringify(saved)).not.toContain(pairingToken);
  });

  it('does not persist an expired pairing token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'expired' }, { status: 401 }))
    );
    fs.rmSync(getConfigPath(), { force: true });

    const authClient = new AuthClient(createTestLogger());
    const result = await authClient.loginWithMachinePairingToken(
      'lody_pair_expired_secret',
      'test-machine'
    );

    expect(result.success).toBe(false);
    expect(fs.existsSync(getConfigPath())).toBe(false);
  });
});

describe('performLoginWithAuthCredential', () => {
  const requestedUrls = (fetchMock: ReturnType<typeof vi.fn>): string[] =>
    fetchMock.mock.calls.map(([url]) =>
      typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url
    );

  it('routes machine pairing tokens through the one-time exchange', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const urlText = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      if (urlText === 'https://auth.example.com/api/cli/machine-pairing/exchange') {
        return Response.json({
          apiKey: 'lody_cli_temporary_key',
          requestId: 'request-1',
          workspaceId: 'workspace-1',
          expiresAt: Date.now() + 60_000,
          user: { id: 'user-1', email: 'user@example.com', name: 'User One' },
        });
      }
      return Response.json({
        valid: true,
        userId: 'user-1',
        user: { id: 'user-1', email: 'user@example.com', name: 'User One' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await performLoginWithAuthCredential(
      new AuthClient(createTestLogger()),
      createTestLogger(),
      { credential: 'lody_pair_one_time_secret', machineName: 'test-machine' }
    );

    expect(result.success).toBe(true);
    expect(requestedUrls(fetchMock)[0]).toBe(
      'https://auth.example.com/api/cli/machine-pairing/exchange'
    );
    const saved = JSON.parse(fs.readFileSync(getConfigPath(), 'utf8')) as { token?: string };
    expect(saved.token).toBe('lody_cli_temporary_key');
  });

  it('routes CLI API keys through key validation without touching the pairing exchange', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        valid: true,
        userId: 'user-1',
        user: { id: 'user-1', email: 'user@example.com', name: 'User One' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await performLoginWithAuthCredential(
      new AuthClient(createTestLogger()),
      createTestLogger(),
      { credential: 'lody_cli_regular_key', machineName: 'test-machine' }
    );

    expect(result.success).toBe(true);
    expect(requestedUrls(fetchMock).some((url) => url.includes('machine-pairing'))).toBe(false);
    const saved = JSON.parse(fs.readFileSync(getConfigPath(), 'utf8')) as { token?: string };
    expect(saved.token).toBe('lody_cli_regular_key');
  });

  it('routes a pairing token with surrounding whitespace through the exchange', async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: 'expired' }, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await performLoginWithAuthCredential(
      new AuthClient(createTestLogger()),
      createTestLogger(),
      { credential: '  lody_pair_padded_secret  ', machineName: 'test-machine' }
    );

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toBe('This machine connection token is invalid or expired.');
  });
});

describe('validateExistingToken', () => {
  it('marks fetch failures as retryable instead of invalid credentials', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      })
    );

    const result = await validateExistingToken('token', 'https://auth.example.com');

    expect(result).toMatchObject({
      valid: false,
      retryable: true,
      reason: 'network_error',
      error: 'TypeError: fetch failed',
    });
    expect(isRetryableTokenValidationFailure(result)).toBe(true);
  });

  it('marks retryable HTTP failures as auth-service failures, not invalid credentials', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'unavailable' }, { status: 503 }))
    );

    const result = await validateExistingToken('token', 'https://auth.example.com');

    expect(result).toMatchObject({
      valid: false,
      retryable: true,
      reason: 'request_failed',
      status: 503,
    });
  });

  it('treats explicit valid:false responses as invalid credentials', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ valid: false }))
    );

    const result = await validateExistingToken('token', 'https://auth.example.com');

    expect(result).toEqual({
      valid: false,
      retryable: false,
      reason: 'invalid',
    });
  });

  it('does not treat invalid response payloads as invalid credentials', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: true }))
    );

    const result = await validateExistingToken('token', 'https://auth.example.com');

    expect(result).toMatchObject({
      valid: false,
      retryable: false,
      reason: 'invalid_response',
    });
  });
});

describe('AuthClient session token bootstrap', () => {
  it('creates automatic CLI API keys when bootstrapping from a session token', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const urlText = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      if (urlText === 'https://auth.example.com/api/cli/api-key/create') {
        return Response.json({
          apiKey: 'lody_cli_auto_key',
          apiKeyId: 'key-1',
          apiKeyStart: 'lody_cli_',
        });
      }

      return Response.json({
        valid: true,
        userId: 'user-1',
        user: {
          id: 'user-1',
          email: 'user@example.com',
          name: 'User One',
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const authClient = new AuthClient(createTestLogger());
    const result = await authClient.bootstrapFromSessionToken('session-token', 'test-machine');

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://auth.example.com/api/cli/api-key/create',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer session-token',
        },
        body: JSON.stringify({ source: 'auto' }),
      }
    );
  });

  it.each([
    {
      name: 'network failures',
      respond: () => {
        throw new TypeError('fetch failed');
      },
      retryable: true,
    },
    {
      name: 'retryable HTTP failures',
      respond: () => Response.json({ error: 'unavailable' }, { status: 503 }),
      retryable: true,
    },
    {
      name: 'client-side failures',
      respond: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
      retryable: false,
    },
  ])('marks api-key creation $name as retryable=$retryable', async ({ respond, retryable }) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond())
    );

    const authClient = new AuthClient(createTestLogger());
    const result = await authClient.bootstrapFromSessionToken('session-token', 'test-machine');

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error('expected bootstrap to fail');
    }
    expect(result.retryable).toBe(retryable);
  });

  it('resolves the current session user from a desktop session token', async () => {
    const fetchMock = vi.fn(async () => {
      return Response.json({
        data: {
          user: {
            id: 'user-session',
            email: 'session@example.com',
            name: 'Session User',
          },
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const authClient = new AuthClient(createTestLogger());
    const user = await authClient.getSessionUserFromSessionToken('session-token');

    expect(fetchMock).toHaveBeenCalledWith('https://auth.example.com/api/auth/get-session', {
      method: 'GET',
      headers: {
        Authorization: 'Bearer session-token',
      },
    });
    expect(user).toEqual({
      id: 'user-session',
      email: 'session@example.com',
      name: 'Session User',
    });
  });
});
