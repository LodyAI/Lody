import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { WorkspaceMcpCredentialStore } from './workspace-mcp-credential-store';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('WorkspaceMcpCredentialStore', () => {
  it('round-trips bindings without writing credential plaintext', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'lody-workspace-mcp-'));
    roots.push(rootDir);
    const store = new WorkspaceMcpCredentialStore({ rootDir });
    await store.set('workspace:linear', {
      kind: 'oauth',
      tokens: {
        access_token: 'access-secret-value',
        refresh_token: 'refresh-secret-value',
        token_type: 'Bearer',
        expires_in: 3600,
      },
      clientInformation: { client_id: 'client-id' },
      redirectUrl: 'http://127.0.0.1:12345/oauth/callback',
      authorizationFingerprint: 'linear-readonly-v1',
      credentialId: 'credential-1',
      savedAt: 100,
      connectedAt: 90,
    });

    await expect(store.get('workspace:linear')).resolves.toMatchObject({
      kind: 'oauth',
      tokens: { access_token: 'access-secret-value', refresh_token: 'refresh-secret-value' },
    });
    const ciphertext = await readFile(path.join(rootDir, 'credentials.enc.json'), 'utf8');
    expect(ciphertext).not.toContain('access-secret-value');
    expect(ciphertext).not.toContain('refresh-secret-value');
    expect((await stat(path.join(rootDir, 'credentials.key'))).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(rootDir, 'credentials.enc.json'))).mode & 0o777).toBe(0o600);
  });

  it('serializes concurrent mutations without dropping bindings', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'lody-workspace-mcp-'));
    roots.push(rootDir);
    const stores = [
      new WorkspaceMcpCredentialStore({ rootDir }),
      new WorkspaceMcpCredentialStore({ rootDir }),
    ];
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        stores[index % stores.length]!.set(`binding-${index}`, {
          kind: 'secret_url',
          url: `https://mcp.feishu.cn/connect/${index}`,
          authorizationFingerprint: 'feishu-v1',
          credentialId: `credential-${index}`,
          connectedAt: index,
        })
      )
    );
    await Promise.all(
      Array.from({ length: 12 }, async (_, index) =>
        expect(await stores[index % stores.length]!.get(`binding-${index}`)).toMatchObject({
          kind: 'secret_url',
        })
      )
    );
  });
});
