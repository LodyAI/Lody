import { afterEach, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import {
  getMachineRoomId,
  getSessionRoomId,
  MACHINE_PROTOCOL_CAPABILITIES,
  OPERATION_INBOX_PROTOCOL_VERSION,
  type MachineId,
  type SessionHistory,
  type SessionId,
} from '@lody/shared';
import {
  deliverUserTurn,
  prepareSignedIntent,
  type SessionSendRuntime,
} from '../src/lib/session-send-delivery';
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

describe('deliverUserTurn force-interrupt delivery', () => {
  const sessionId = 'sess-1' as SessionId;
  const machineId = 'machine-1' as MachineId;

  function makeEntry(id: string, status: 'pending' | 'pending_apply'): SessionHistory {
    return {
      id,
      role: 'user',
      userId: 'user-1',
      userName: 'User',
      timestamp: '2026-11-28T00:00:00.000Z',
      status,
      items: [{ type: 'text', text: 'follow up' }],
      inputConfig: {
        cliType: 'builtin',
        agentType: 'claude',
        inputBlocks: [{ type: 'text', text: 'follow up' }],
      },
    } as unknown as SessionHistory;
  }

  function makeDeliveryRuntime(entry: SessionHistory) {
    const events: string[] = [];
    const upsertDocMeta = vi.fn(async (_roomId: string, patch: Record<string, unknown>) => {
      events.push(`upsert:${Object.keys(patch).join(',')}`);
    });
    const requestSessionCancel = vi.fn(async () => {
      events.push('cancel');
      return { success: true };
    });
    const requestSessionDispatchTurn = vi.fn(async () => {
      events.push('dispatch');
      return { accepted: true };
    });
    const requestSessionSteer = vi.fn(async () => {
      events.push('steer');
      return {
        type: 'session/steer_response' as const,
        sessionId,
        userTurnId: entry.id,
        applied: false,
        recoveryOwned: true,
        disposition: 'unsupported' as const,
      };
    });
    const runtime = {
      repo: {
        getDocMeta: vi.fn(async (roomId: string) => {
          if (roomId === getSessionRoomId(sessionId)) {
            return { meta: { id: sessionId, machineId } };
          }
          if (roomId === getMachineRoomId(machineId)) {
            return {
              meta: {
                id: machineId,
                protocolCapabilities: {
                  [MACHINE_PROTOCOL_CAPABILITIES.operationInbox]: OPERATION_INBOX_PROTOCOL_VERSION,
                },
              },
            };
          }
          return undefined;
        }),
      },
      writer: {
        upsertDocMeta,
      },
      sendResources: {
        withSessionStore: vi.fn(async (_id: SessionId, fn: (store: unknown) => unknown) =>
          fn({
            getState: () => ({ rpcDispatchOriginals: {}, humanInputReceipts: {} }),
            setState: vi.fn(),
            sessionData: {
              history: {
                readTurn: vi.fn(async () => ({ state: 'ready', turn: entry })),
              },
            },
          })
        ),
      },
      requestSessionCancel,
      requestSessionDispatchTurn,
      requestSessionSteer,
    } as unknown as SessionSendRuntime;

    return {
      events,
      runtime,
      upsertDocMeta,
      requestSessionCancel,
      requestSessionDispatchTurn,
      requestSessionSteer,
    };
  }

  it('interrupts active turn after write before dispatching a deferred interrupt-and-send turn', async () => {
    const entry = makeEntry('user-turn-2', 'pending');
    const harness = makeDeliveryRuntime(entry);

    await deliverUserTurn(harness.runtime, {
      sessionId,
      entry,
      targetMachineId: machineId,
      delivery: { kind: 'dispatch', interruptTurnId: 'assistant:turn-1' },
    });

    expect(harness.requestSessionCancel).toHaveBeenCalledWith(
      machineId,
      sessionId,
      'assistant:turn-1',
      { timeoutMs: 2_000, pauseInbox: false }
    );
    expect(harness.upsertDocMeta).toHaveBeenCalledWith(getSessionRoomId(sessionId), {
      lastCanceledTurn: 'assistant:turn-1',
    });
    expect(harness.requestSessionDispatchTurn).toHaveBeenCalledOnce();
    expect(harness.events.indexOf('cancel')).toBeLessThan(harness.events.indexOf('dispatch'));
  });

  it('interrupts active turn when a deferred guide with forceInterruptOnUnsupported receives unsupported', async () => {
    const entry = makeEntry('user-turn-3', 'pending_apply');
    const harness = makeDeliveryRuntime(entry);
    const onGuideOutcome = vi.fn();

    await deliverUserTurn(
      harness.runtime,
      {
        sessionId,
        entry,
        targetMachineId: machineId,
        delivery: {
          kind: 'guide',
          expectedTurnId: 'assistant:turn-1',
          forceInterruptOnUnsupported: true,
        },
      },
      onGuideOutcome
    );

    expect(harness.requestSessionSteer).toHaveBeenCalledOnce();
    expect(harness.requestSessionCancel).toHaveBeenCalledWith(
      machineId,
      sessionId,
      'assistant:turn-1',
      { timeoutMs: 2_000, pauseInbox: false }
    );
    expect(harness.upsertDocMeta).toHaveBeenCalledWith(getSessionRoomId(sessionId), {
      lastCanceledTurn: 'assistant:turn-1',
    });
    expect(onGuideOutcome).toHaveBeenLastCalledWith(
      sessionId,
      'user-turn-3',
      'assistant:turn-1',
      false
    );
  });

  it('does not interrupt active turn when a deferred guide without forceInterruptOnUnsupported receives unsupported', async () => {
    const entry = makeEntry('user-turn-4', 'pending_apply');
    const harness = makeDeliveryRuntime(entry);

    await deliverUserTurn(harness.runtime, {
      sessionId,
      entry,
      targetMachineId: machineId,
      delivery: { kind: 'guide', expectedTurnId: 'assistant:turn-1' },
    });

    expect(harness.requestSessionSteer).toHaveBeenCalledOnce();
    expect(harness.requestSessionCancel).not.toHaveBeenCalled();
    expect(harness.upsertDocMeta).not.toHaveBeenCalled();
  });
});
