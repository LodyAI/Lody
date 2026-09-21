import { describe, expect, it } from 'vitest';
import {
  LODY_PRESENCE_TTL_MS,
  collectOnlineMachineIdsFromPresence,
  findFreshMachinePresenceState,
  findFreshSessionPresenceState,
  getLodyMachinePresenceKey,
  getLodySessionPresenceKey,
  parseLodyPresenceStates,
  type LodyPresenceInstanceId,
  type LodyPresenceStateMap,
  type MachineId,
  type SessionId,
} from '../src';

const machineId = 'machine-1' as MachineId;
const sessionId = 'session-1' as SessionId;
const instanceId = 'instance-1' as LodyPresenceInstanceId;

describe('presence helpers', () => {
  it('uses a 90 second presence TTL', () => {
    expect(LODY_PRESENCE_TTL_MS).toBe(90_000);
  });

  it('parses valid presence states and drops invalid states', () => {
    const machineKey = getLodyMachinePresenceKey(machineId, instanceId);
    const sessionKey = getLodySessionPresenceKey(sessionId, instanceId);
    const parsed = parseLodyPresenceStates({
      [machineKey]: {
        kind: 'machine',
        machineId,
        instanceId,
        updatedAt: 100,
      },
      [sessionKey]: {
        kind: 'session',
        sessionId,
        machineId,
        instanceId,
        status: { type: 'running' },
        updatedAt: 120,
      },
      invalid: {
        kind: 'session',
        sessionId,
        machineId,
        instanceId,
        status: { type: 'idle' },
        updatedAt: 130,
      },
    });

    expect(Object.keys(parsed).sort()).toEqual([machineKey, sessionKey].sort());
  });

  it('accepts status fields nulled by the Loro value roundtrip', () => {
    // Loro values cannot represent `undefined`; optional status fields written
    // as undefined come back as null after the wasm roundtrip. These entries
    // must still parse or the Working indicator silently drops them.
    const sessionKey = getLodySessionPresenceKey(sessionId, instanceId);
    const parsed = parseLodyPresenceStates({
      [sessionKey]: {
        kind: 'session',
        sessionId,
        machineId,
        instanceId,
        status: { type: 'initializing', stage: null, detail: null },
        updatedAt: 120,
      },
    });

    expect(parsed[sessionKey]).toMatchObject({
      kind: 'session',
      sessionId,
      status: { type: 'initializing' },
    });
  });

  it('returns only fresh latest presence for a machine/session', () => {
    const freshInstance = 'instance-fresh' as LodyPresenceInstanceId;
    const staleInstance = 'instance-stale' as LodyPresenceInstanceId;
    const states: LodyPresenceStateMap = {
      [getLodyMachinePresenceKey(machineId, staleInstance)]: {
        kind: 'machine',
        machineId,
        instanceId: staleInstance,
        updatedAt: 1,
      },
      [getLodyMachinePresenceKey(machineId, freshInstance)]: {
        kind: 'machine',
        machineId,
        instanceId: freshInstance,
        updatedAt: 95,
      },
      [getLodySessionPresenceKey(sessionId, freshInstance)]: {
        kind: 'session',
        sessionId,
        machineId,
        instanceId: freshInstance,
        status: { type: 'running', activity: 'image_generation' },
        updatedAt: 90,
      },
    };

    expect(findFreshMachinePresenceState(states, machineId, 100, 20)?.instanceId).toBe(
      freshInstance
    );
    expect(findFreshSessionPresenceState(states, sessionId, 100, 20)?.status).toEqual({
      type: 'running',
      activity: 'image_generation',
    });
    expect(findFreshMachinePresenceState(states, machineId, LODY_PRESENCE_TTL_MS + 200)).toBe(
      undefined
    );
  });

  it('collects online machine ids from fresh machine presence only', () => {
    const now = 1_000;
    const staleMachineId = 'machine-stale' as MachineId;
    const states: LodyPresenceStateMap = {
      [getLodyMachinePresenceKey(machineId, instanceId)]: {
        kind: 'machine',
        machineId,
        instanceId,
        updatedAt: now,
      },
      [getLodyMachinePresenceKey(staleMachineId, instanceId)]: {
        kind: 'machine',
        machineId: staleMachineId,
        instanceId,
        updatedAt: now - LODY_PRESENCE_TTL_MS - 1,
      },
      [getLodySessionPresenceKey(sessionId, instanceId)]: {
        kind: 'session',
        sessionId,
        machineId: 'machine-session-only' as MachineId,
        instanceId,
        status: { type: 'running' },
        updatedAt: now,
      },
    };

    const online = collectOnlineMachineIdsFromPresence(states, now);
    expect(online.has(machineId)).toBe(true);
    expect(online.has(staleMachineId)).toBe(false);
    // Session presence alone must not mark a machine online; machine liveness
    // is only asserted by machine heartbeats.
    expect(online.size).toBe(1);
  });
});
