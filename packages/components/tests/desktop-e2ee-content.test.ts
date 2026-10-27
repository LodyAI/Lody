import { describe, expect, it, vi } from 'vitest';
import type { E2eeWorkspaceRuntime } from '@lody/platform';
import { LoroDoc } from 'loro-crdt';
import { createDesktopE2eeContent } from '../src/providers/desktop-e2ee-content';

const context = {
  protocol: 'loro-streams-crdt-payload-protection',
  version: 2,
  kind: 'update_batch',
} as const;

describe('desktop E2EE content epoch safety', () => {
  it('does not hydrate a previous epoch token when a retired provider left a cache row', async () => {
    const entries = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
      removeItem: (key: string) => entries.delete(key),
    });
    let issued = 0;
    const runtime = {
      contentStreamsToken: async () => ({
        token: `epoch-token-${++issued}`,
        bucketId: 'encrypted-content',
        gatewayBaseUrl: 'https://streams.example.com',
        expiresIn: 900,
        expiresAt: 1_900_000_000_000,
      }),
    } as unknown as E2eeWorkspaceRuntime;
    const access = createDesktopE2eeContent({
      runtime,
      workspaceId: 'token-epoch-workspace',
      genesisHash: '11'.repeat(32),
      epoch: 0,
      authToken: () => 'account-token',
    });
    const first = access.e2ee.createTokenProvider(new AbortController().signal);
    let successor: typeof first | undefined;
    try {
      expect(await first.getToken()).toBe('epoch-token-1');
      expect(entries.size).toBeGreaterThan(0);
      access.updateStatus({ epoch: 1, rotationRequired: false, hasCurrentKey: true });
      await access.transition({
        // Even a cache row that could not be removed cannot select the next token.
        drain: () => first.close(),
        install: async () => ({ epoch: 1, rotationRequired: false, hasCurrentKey: true }),
        restart: async () => {
          successor = access.e2ee.createTokenProvider(new AbortController().signal);
        },
      });
      expect(await successor?.getToken()).toBe('epoch-token-2');
      expect(access.e2ee.bucketId()).toBe('encrypted-content');
    } finally {
      await first.close();
      await successor?.close();
      await access.close();
      vi.unstubAllGlobals();
    }
  });
  it('replaces a gateway-rejected cached token through the native token capability', async () => {
    let cached = 'cached-token';
    const rejected: Array<string | undefined> = [];
    const runtime = {
      contentStreamsToken: async (workspaceId: string, rejectedToken?: string) => {
        expect(workspaceId).toBe('workspace');
        rejected.push(rejectedToken);
        if (rejectedToken === cached) cached = 'replacement-token';
        return {
          token: cached,
          bucketId: 'encrypted-content',
          gatewayBaseUrl: 'https://streams.example.com',
          expiresIn: 900,
          expiresAt: 1_900_000_000_000,
        };
      },
    } as unknown as E2eeWorkspaceRuntime;
    const access = createDesktopE2eeContent({
      runtime,
      workspaceId: 'workspace',
      genesisHash: '11'.repeat(32),
      epoch: 0,
      authToken: () => 'account-token',
    });
    const provider = access.e2ee.createTokenProvider(new AbortController().signal);
    const authenticate = provider.createAuthCallback();
    try {
      expect(await authenticate({ reason: 'request' })).toBe('cached-token');
      // This is the callback the Streams transport uses after a gateway 401.
      expect(await authenticate({ reason: 'unauthorized', previousToken: 'cached-token' })).toBe(
        'replacement-token'
      );
      expect(rejected).toEqual([undefined, 'cached-token']);
      // A delayed rejection of the old token cannot replace the healthy token.
      expect(await authenticate({ reason: 'unauthorized', previousToken: 'cached-token' })).toBe(
        'replacement-token'
      );
      expect(cached).toBe('replacement-token');
    } finally {
      await provider.close();
    }
  });

  it.each([
    { epoch: 1, rotationRequired: false },
    { epoch: 0, rotationRequired: true },
  ])('retains local edits and stops encrypted sends after %j', async (status) => {
    const doc = new LoroDoc();
    const received: Uint8Array[] = [];
    let updateRequired = false;
    const runtime = {
      seal: async (_workspaceId: string, request: { plaintext: Uint8Array }) => {
        const sealed = new Uint8Array([99, request.plaintext.length]);
        received.push(sealed);
        return { header: new Uint8Array([3]), sealed };
      },
    } as unknown as E2eeWorkspaceRuntime;
    const access = createDesktopE2eeContent({
      runtime,
      workspaceId: 'workspace',
      genesisHash: '11'.repeat(32),
      epoch: 0,
      authToken: () => null,
      onKeyUpdateRequired: () => {
        updateRequired = true;
      },
    });
    try {
      const room =
        access.content.mode === 'protected'
          ? access.content.resolve({ kind: 'doc', docId: 'session' })
          : undefined;
      if (!room || room.mode !== 'protected') throw new Error('expected protected room');
      const request = {
        context,
        plaintext: new Uint8Array([1, 2]),
        additionalData: () => new Uint8Array([3]),
      };
      await room.config.provider.seal(request);
      const accepted = received.slice();
      access.updateStatus(status);
      doc.getText('draft').insert(0, 'saved locally while keys update');
      doc.commit();
      await expect(
        room.config.provider.seal({ ...request, plaintext: doc.export({ mode: 'update' }) })
      ).rejects.toThrow('e2ee_key_update_required');
      // An older status response cannot reopen the stopped sender.
      access.updateStatus({ epoch: 0, rotationRequired: false });
      await expect(room.config.provider.seal(request)).rejects.toThrow('e2ee_key_update_required');
      expect(received).toEqual(accepted);
      expect(doc.getText('draft').toString()).toBe('saved locally while keys update');
      expect(updateRequired).toBe(true);
    } finally {
      doc.free();
    }
  });
});
