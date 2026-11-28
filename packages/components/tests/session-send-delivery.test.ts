import { afterEach, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import { getSessionRoomId, type MachineId, type SessionId } from '@lody/shared';
import { prepareSignedIntent, type SessionSendRuntime } from '../src/lib/session-send-delivery';
import { SessionInputNotSentError } from '../src/lib/session-accepted-inputs';

afterEach(() => {
  vi.restoreAllMocks();
});

function makeRuntime(prepareError: unknown): SessionSendRuntime {
  return {
    contentMode: 'e2ee',
    repo: {
      getDocMeta: async () => ({
        meta: { id: 'sess-1', machineId: 'machine-1' },
      }),
    },
    writer: {} as SessionSendRuntime['writer'],
    sendResources: {} as SessionSendRuntime['sendResources'],
    requestSessionDispatchTurn: async () => null,
    requestSessionSteer: async () => null,
    prepareEncryptedDispatch: async () => {
      throw prepareError;
    },
  } as unknown as SessionSendRuntime;
}

describe('prepareSignedIntent error classification', () => {
  it.each([
    { code: 'epoch-mismatch' },
    { code: 'e2ee_epoch_mismatch' },
    { code: 'stale-epoch' },
    new Error('e2ee_epoch_mismatch'),
  ])('maps transient epoch mismatch %j to e2eeNotReady instead of e2eeRevoked', async (err) => {
    const spy = vi.spyOn(i18next, 't').mockImplementation((key) => String(key));
    const runtime = makeRuntime(err);
    await expect(
      prepareSignedIntent(runtime, 'sess-1' as SessionId, {
        id: 'turn-1',
        userId: 'user-1',
        timestamp: '2026-11-26T00:00:00.000Z',
        machineId: 'machine-1' as MachineId,
        inputConfig: {
          cliType: 'builtin',
          agentType: 'codex',
          inputBlocks: [{ type: 'text', text: 'hello' }],
        },
      })
    ).rejects.toEqual(new SessionInputNotSentError('sessions.sendError.e2eeNotReady'));
    expect(spy).toHaveBeenCalledWith('sessions.sendError.e2eeNotReady');
    expect(getSessionRoomId('sess-1' as SessionId)).toBeTruthy();
  });

  it.each([
    { code: 'unauthorized' },
    { code: 'e2ee_device_revoked' },
    { code: 'e2ee_member_removed' },
    { code: 'revoked' },
  ])('continues mapping genuine revocation/auth failure %j to e2eeRevoked', async (err) => {
    vi.spyOn(i18next, 't').mockImplementation((key) => String(key));
    const runtime = makeRuntime(err);
    await expect(
      prepareSignedIntent(runtime, 'sess-1' as SessionId, {
        id: 'turn-1',
        userId: 'user-1',
        timestamp: '2026-11-26T00:00:00.000Z',
        machineId: 'machine-1' as MachineId,
        inputConfig: {
          cliType: 'builtin',
          agentType: 'codex',
          inputBlocks: [{ type: 'text', text: 'hello' }],
        },
      })
    ).rejects.toEqual(new SessionInputNotSentError('sessions.sendError.e2eeRevoked'));
  });
});
