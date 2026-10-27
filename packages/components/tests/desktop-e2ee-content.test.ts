import { describe, expect, it } from 'vitest';
import type { E2eeWorkspaceRuntime } from '@lody/platform';
import { LoroDoc } from 'loro-crdt';
import { createDesktopE2eeContent } from '../src/providers/desktop-e2ee-content';

const context = {
  protocol: 'loro-streams-crdt-payload-protection',
  version: 2,
  kind: 'update_batch',
} as const;

describe('desktop E2EE content epoch safety', () => {
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

  it('requests repair without blocking replay, then clears the recovery hint on a valid read', async () => {
    const requests: unknown[][] = [];
    const statuses: boolean[] = [];
    const release = Promise.withResolvers<unknown>();
    let valid = false;
    const runtime = {
      openContent: async () => {
        if (!valid) throw new Error('snapshot rejected');
        return new Uint8Array([7]);
      },
      contentStreamsToken: (...args: unknown[]) => {
        requests.push(args);
        return release.promise;
      },
    } as unknown as E2eeWorkspaceRuntime;
    const access = createDesktopE2eeContent({
      runtime,
      workspaceId: 'workspace',
      genesisHash: '11'.repeat(32),
      epoch: 0,
      authToken: () => null,
      onSnapshotRecoveryChange: (pending) => statuses.push(pending),
    });
    if (access.content.mode !== 'protected') throw new Error('expected protected content');
    const room = access.content.resolve({ kind: 'meta' });
    if (room.mode !== 'protected') throw new Error('expected protected room');
    const request = {
      context: { ...context, kind: 'snapshot' as const, continuationOffset: '00000001' },
      header: new Uint8Array([4]),
      sealed: new Uint8Array([1]),
      additionalData: new Uint8Array([2]),
    };
    try {
      await expect(room.config.provider.open(request)).rejects.toThrow('snapshot rejected');
      access.content.snapshotUpload.onSnapshotRecovery!(
        'https://streams.invalid/ds/encrypted/workspace%3Ameta',
        true
      );
      access.content.snapshotUpload.onSnapshotRecovery!(
        'https://streams.invalid/ds/encrypted/workspace%3Ameta',
        true
      );
      await expect(room.config.provider.open(request)).rejects.toThrow('snapshot rejected');
      expect(requests).toEqual([['workspace', undefined, 'workspace:meta']]);
      expect(statuses.at(-1)).toBe(true);
      valid = true;
      // The request action is still unsettled; retained history remains usable.
      expect(await room.config.provider.open({ ...request, context })).toEqual(new Uint8Array([7]));
      access.content.snapshotUpload.onSnapshotRecovery!(
        'https://streams.invalid/ds/encrypted/workspace%3Ameta',
        false
      );
      expect(statuses.at(-1)).toBe(false);
    } finally {
      release.resolve(undefined);
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
      if (access.content.mode !== 'protected') throw new Error('expected protected content');
      expect(await access.content.snapshotUpload.canUpload()).toBe(true);
      await room.config.provider.seal(request);
      const accepted = received.slice();
      access.updateStatus(status);
      expect(await access.content.snapshotUpload.canUpload()).toBe(false);
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
