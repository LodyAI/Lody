import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PreviewControlIntent, PreviewControlProof } from '@lody/shared';
import { PreviewControlAuthority } from './preview-control-authority';

const intent: Omit<PreviewControlIntent, 'runtimeNonce' | 'requestId'> = {
  workspaceId: 'workspace',
  machineId: 'machine',
  sessionId: 'session',
  requesterUserId: 'user',
  operation: { action: 'status', renewEndpointId: 'endpoint' },
};
const proofFor = (authority: PreviewControlAuthority): PreviewControlProof => ({
  runtimeNonce: authority.runtimeNonce,
  requestId: randomUUID(),
  requestToken: 'narrow-signed-proof',
});

describe('Preview remote control admission', () => {
  it('allows only one concurrent use and rejects requests from a previous CLI instance', async () => {
    const gate = Promise.withResolvers<{ requesterUserId: string; expiresAt: number }>();
    const verify = vi.fn(() => gate.promise);
    const authority = new PreviewControlAuthority(verify, () => 1000);
    const proof = proofFor(authority);
    const attempts = Promise.allSettled([
      authority.authorize(intent, proof),
      authority.authorize(intent, proof),
    ]);
    gate.resolve({ requesterUserId: 'user', expiresAt: 2000 });
    expect((await attempts).map((result) => result.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    await expect(authority.authorize(intent, proof)).rejects.toThrow('already used');
    const restarted = new PreviewControlAuthority(verify, () => 1000);
    await expect(restarted.authorize(intent, proof)).rejects.toThrow('runtime changed');
  });

  it('rejects invalid signatures, expired proofs and claimed identity substitution', async () => {
    const verify = vi.fn(async () => ({ requesterUserId: 'other', expiresAt: 2000 }));
    const authority = new PreviewControlAuthority(verify, () => 1000);
    await expect(authority.authorize(intent, proofFor(authority))).rejects.toThrow(
      'identity or expiry'
    );
    verify.mockResolvedValueOnce({ requesterUserId: 'user', expiresAt: 1000 });
    await expect(authority.authorize(intent, proofFor(authority))).rejects.toThrow(
      'identity or expiry'
    );
    verify.mockRejectedValueOnce(new Error('Invalid signature'));
    await expect(authority.authorize(intent, proofFor(authority))).rejects.toThrow(
      'Invalid signature'
    );
  });

  it('passes the exact command and CLI-resolved project to verification without exposing a local fallback', async () => {
    const verify = vi.fn(async () => ({ requesterUserId: 'user', expiresAt: 2000 }));
    const authority = new PreviewControlAuthority(verify, () => 1000);
    const proof = proofFor(authority);
    await authority.authorize(intent, proof, 'resolved-project');
    expect(verify).toHaveBeenCalledWith({
      intent: { ...intent, runtimeNonce: proof.runtimeNonce, requestId: proof.requestId },
      requestToken: proof.requestToken,
      localProjectId: 'resolved-project',
    });
    const local = new PreviewControlAuthority(undefined, () => 1000);
    await expect(local.authorize(intent, proofFor(local))).rejects.toThrow('unavailable');
  });
});
