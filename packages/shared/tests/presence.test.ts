import { describe, expect, it } from 'vitest';
import { z } from 'zod';
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

const machineId = '01020304-1111-4222-8333-010203040501' as MachineId;
const sessionId = '01020304-1111-4222-8333-010203040502' as SessionId;
const instanceId = '01020304-1111-4222-8333-010203040503' as LodyPresenceInstanceId;

// Shape of the running object before optional `phase`. z.object strips unknown
// keys, so an older client keeps `{ type: 'running' }` instead of dropping it.
const legacyRunningStatus = z.object({
  type: z.literal('running'),
  activity: z.enum(['image_generation']).optional(),
});

describe('presence helpers', () => {
  it.each(['sessionId', 'machineId', 'instanceId', 'userId'] as const)(
    'rejects free text and oversized %s only in minimal mode',
    (field) => {
      const entry =
        field === 'machineId'
          ? {
              kind: 'machine',
              machineId: '01020304-1111-4222-8333-010203040506',
              instanceId: '01020304-1111-4222-8333-010203040507',
              updatedAt: 100,
            }
          : {
              kind: 'session-viewing',
              sessionId: '01020304-1111-4222-8333-010203040508',
              instanceId: '01020304-1111-4222-8333-010203040507',
              userId: 'Abcdef0123456789Abcdef0123456789',
              since: 100,
              updatedAt: 100,
            };
      for (const invalid of [
        'Private roadmap: /Users/example/project',
        'TitleWithoutSpaces',
        '/tmp/private-path',
        'relative/path',
        '%2Fprivate',
        '秘密标题',
        'a'.repeat(1024),
        '01020304-1111-4222-8333-010203040508\n',
      ]) {
        const input = { entry: { ...entry, [field]: invalid } };
        expect(parseLodyPresenceStates(input, { minimal: true }), `${field}: ${invalid}`).toEqual(
          {}
        );
        expect(parseLodyPresenceStates(input).entry).toHaveProperty(field, invalid);
      }
    }
  );

  it('accepts supported generated ID formats without widening ordinary parsers', () => {
    for (const ids of [
      {
        sessionId: '01020304-1111-4222-8333-010203040508',
        machineId: '01020304-1111-4222-8333-010203040509',
        instanceId: '01020304-1111-4222-8333-010203040507',
        userId: 'Abcdef0123456789Abcdef0123456789',
      },
      {
        sessionId: '019a0d00-0000-8000-8000-000000000001',
        machineId: 'ab'.repeat(32),
        instanceId: '1790000000000-k5zmz7k',
        userId: 'local:' + 'cd'.repeat(16),
      },
      {
        sessionId: '1790000000000-k5zmz7k',
        machineId: '01020304-1111-4222-8333-010203040509',
        instanceId: '01020304-1111-4222-8333-010203040507',
        userId: '019a0d00-0000-7000-8000-000000000001',
      },
    ]) {
      const states = {
        machine: {
          kind: 'machine',
          machineId: ids.machineId,
          instanceId: ids.instanceId,
          updatedAt: 100,
        },
        session: {
          kind: 'session',
          sessionId: ids.sessionId,
          machineId: ids.machineId,
          instanceId: ids.instanceId,
          status: { type: 'running' },
          updatedAt: 100,
        },
        viewing: {
          kind: 'session-viewing',
          sessionId: ids.sessionId,
          userId: ids.userId,
          instanceId: ids.instanceId,
          since: 50,
          updatedAt: 100,
        },
      };
      expect(parseLodyPresenceStates(states, { minimal: true })).toEqual(states);
    }
    for (const userId of ['a'.repeat(31), 'a'.repeat(33), 'local:' + 'ab'.repeat(17)]) {
      expect(
        parseLodyPresenceStates(
          {
            viewing: {
              kind: 'session-viewing',
              sessionId,
              instanceId,
              userId,
              since: 50,
              updatedAt: 100,
            },
          },
          { minimal: true }
        )
      ).toEqual({});
    }
    expect(
      parseLodyPresenceStates(
        {
          viewing: {
            kind: 'session-viewing',
            sessionId: '1790000000000-fallback\n',
            instanceId,
            userId: 'Abcdef0123456789Abcdef0123456789',
            since: 50,
            updatedAt: 100,
          },
        },
        { minimal: true }
      )
    ).toEqual({});
  });

  it('uses a separate minimal allowlist and ignores arbitrary details before validation', () => {
    const input = {
      entry: {
        kind: 'session',
        sessionId,
        machineId,
        instanceId,
        updatedAt: 120,
        extra: 'secret',
        status: {
          type: 'initializing',
          stage: 'acp',
          detail: 'x'.repeat(1000),
          futureText: 'secret',
        },
      },
    };
    expect(parseLodyPresenceStates(input, { minimal: true })).toEqual({
      entry: {
        kind: 'session',
        sessionId,
        machineId,
        instanceId,
        updatedAt: 120,
        status: { type: 'initializing', stage: 'acp' },
      },
    });
    expect(parseLodyPresenceStates(input)).toEqual({});
    input.entry.status.detail = 'ordinary detail';
    expect(parseLodyPresenceStates(input).entry).toHaveProperty('status.detail', 'ordinary detail');
  });

  it('keeps an optional running phase on session presence', () => {
    const sessionKey = getLodySessionPresenceKey(sessionId, instanceId);
    const parsed = parseLodyPresenceStates({
      [sessionKey]: {
        kind: 'session',
        sessionId,
        machineId,
        instanceId,
        status: { type: 'running', phase: 'finalizing' },
        updatedAt: 120,
      },
    });
    expect(parsed[sessionKey]).toMatchObject({
      status: { type: 'running', phase: 'finalizing' },
    });
  });

  it('lets an older running parser keep the session when phase is unknown', () => {
    expect(legacyRunningStatus.parse({ type: 'running', phase: 'finalizing' })).toEqual({
      type: 'running',
    });
  });

  it('rejects a new activity enum value that older parsers cannot keep', () => {
    expect(legacyRunningStatus.safeParse({ type: 'running', activity: 'finalizing' }).success).toBe(
      false
    );
  });

  it('keeps only identifiers, enums and timestamps across all minimal entry kinds', () => {
    const common = {
      instanceId,
      updatedAt: 100,
      detail: 'private detail',
      futureText: 'private text',
    };
    const states = {
      machine: { ...common, kind: 'machine', machineId },
      viewing: {
        ...common,
        kind: 'session-viewing',
        userId: 'Abcdef0123456789Abcdef0123456789',
        sessionId,
        since: 50,
      },
      running: {
        ...common,
        kind: 'session',
        machineId,
        sessionId,
        status: {
          type: 'running',
          activity: 'image_generation',
          phase: 'finalizing',
          detail: 'private text',
        },
      },
      permission: {
        ...common,
        kind: 'session',
        machineId,
        sessionId,
        status: { type: 'requestPermission', detail: 'private text' },
      },
      invalid: {
        ...common,
        kind: 'session',
        machineId,
        sessionId,
        status: { type: 'running', activity: 'arbitrary free text' },
      },
    };
    expect(parseLodyPresenceStates(states, { minimal: true })).toEqual({
      machine: { kind: 'machine', machineId, instanceId, updatedAt: 100 },
      viewing: {
        kind: 'session-viewing',
        userId: 'Abcdef0123456789Abcdef0123456789',
        sessionId,
        instanceId,
        since: 50,
        updatedAt: 100,
      },
      running: {
        kind: 'session',
        machineId,
        sessionId,
        instanceId,
        updatedAt: 100,
        status: { type: 'running', activity: 'image_generation', phase: 'finalizing' },
      },
      permission: {
        kind: 'session',
        machineId,
        sessionId,
        instanceId,
        updatedAt: 100,
        status: { type: 'requestPermission' },
      },
    });
  });

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
