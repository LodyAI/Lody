import { describe, expect, it } from 'vitest';
import {
  listSorbetAcpCredentials,
  logoutSorbetAcpCredential,
  supportsSorbetAcpCredentials,
} from './sorbet-acp-credentials';

const capabilities = { _meta: { 'sorbet.dev': { credentials: { version: 1 } } } };

describe('Sorbet ACP credentials', () => {
  it('lists only credential descriptors and logs out the requested provider', async () => {
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const connection = {
      async request(method: string, params: Record<string, unknown>): Promise<unknown> {
        requests.push({ method, params });
        return method.endsWith('/list')
          ? { credentials: [{ providerId: 'example', type: 'oauth', secret: 'private' }] }
          : {};
      },
    };
    expect(await listSorbetAcpCredentials(connection, capabilities)).toEqual([
      { providerId: 'example', type: 'oauth' },
    ]);
    await logoutSorbetAcpCredential(connection, capabilities, 'example');
    expect(requests).toEqual([
      { method: '_sorbet/auth/credentials/list', params: {} },
      { method: '_sorbet/auth/credentials/logout', params: { providerId: 'example' } },
    ]);
  });

  it.each([undefined, {}, { _meta: { 'sorbet.dev': { credentials: { version: 2 } } } }])(
    'rejects unsupported capabilities before sending requests',
    async (unsupported) => {
      const connection = {
        request: async () => {
          throw new Error('unexpected request');
        },
      };
      expect(supportsSorbetAcpCredentials(unsupported)).toBe(false);
      await expect(listSorbetAcpCredentials(connection, unsupported)).rejects.toThrow(
        'unsupported'
      );
      await expect(logoutSorbetAcpCredential(connection, unsupported, 'example')).rejects.toThrow(
        'unsupported'
      );
    }
  );

  it('preserves Unicode provider IDs at the shared length limit', async () => {
    const ids = ['提供商 / 帐号', 'a'.repeat(1024)];
    const removed: string[] = [];
    const connection = {
      request: async (method: string, params: Record<string, unknown>) => {
        if (method.endsWith('/list'))
          return { credentials: ids.map((providerId) => ({ providerId, type: 'oauth' })) };
        removed.push(String(params.providerId));
        return {};
      },
    };
    expect(await listSorbetAcpCredentials(connection, capabilities)).toEqual(
      ids.map((providerId) => ({ providerId, type: 'oauth' }))
    );
    for (const id of ids) await logoutSorbetAcpCredential(connection, capabilities, id);
    expect(removed).toEqual(ids);
    await expect(
      logoutSorbetAcpCredential(connection, capabilities, 'a'.repeat(1025))
    ).rejects.toThrow('Invalid');
  });

  it('rejects malformed responses and invalid provider IDs', async () => {
    const connection = { request: async () => ({ credentials: [{ providerId: 'x' }] }) };
    await expect(listSorbetAcpCredentials(connection, capabilities)).rejects.toThrow('Invalid');
    await expect(logoutSorbetAcpCredential(connection, capabilities, '')).rejects.toThrow(
      'Invalid'
    );
  });

  it('does not expose agent error text or retry a failed logout', async () => {
    let calls = 0;
    const connection = {
      request: async () => {
        calls++;
        throw new Error('secret');
      },
    };
    await expect(logoutSorbetAcpCredential(connection, capabilities, 'example')).rejects.toThrow(
      /^Sorbet ACP credentials logout failed$/
    );
    expect(calls).toBe(1);
    await expect(listSorbetAcpCredentials(connection, capabilities)).rejects.toThrow(
      /^Sorbet ACP credentials list failed$/
    );
  });
});
