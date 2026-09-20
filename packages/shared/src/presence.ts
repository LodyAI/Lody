import { z } from 'zod';
import type { MachineId, SessionId } from './index';
import type { SessionStatus } from './schema';

export const LODY_PRESENCE_CHANNEL = 'presence';
export const LODY_PRESENCE_TTL_MS = 90_000;
export const LODY_PRESENCE_HEARTBEAT_MS = 30_000;

export type LodyPresenceInstanceId = string & { __brand: 'LodyPresenceInstanceId' };

export type LodyMachinePresenceState = {
  kind: 'machine';
  machineId: MachineId;
  instanceId: LodyPresenceInstanceId;
  updatedAt: number;
};

export type LodySessionPresenceState = {
  kind: 'session';
  sessionId: SessionId;
  machineId: MachineId;
  instanceId: LodyPresenceInstanceId;
  status: Exclude<SessionStatus, { type: 'idle' }>;
  updatedAt: number;
};

/**
 * "User U is currently viewing session S" — published by the UI while a
 * session view is mounted and the page is visible, actively deleted on
 * switch/hide/unload (TTL is only the crash fallback). Consumed by the owning
 * machine's PR poller for activity-aware scheduling, and later by other
 * members' UIs ("colleague is viewing this session"). One entry per app
 * instance; unique key = (userId, instanceId), `sessionId` replaced in place.
 */
export type LodySessionViewingPresenceState = {
  kind: 'session-viewing';
  /** Auth user id of the viewer (shared has no branded UserId type). */
  userId: string;
  instanceId: LodyPresenceInstanceId;
  sessionId: SessionId;
  /** When viewing of this session started (epoch ms, server clock). */
  since: number;
  updatedAt: number;
};

export type LodyPresenceState =
  | LodyMachinePresenceState
  | LodySessionPresenceState
  | LodySessionViewingPresenceState;
export type LodyPresenceStateMap = Record<string, LodyPresenceState>;

// Loro values (docs and the ephemeral store) cannot represent `undefined`:
// optional fields written as undefined come back as null after the wasm
// roundtrip. Strip null/undefined-valued keys before validation, otherwise a
// status like `{type:'initializing', stage:null}` fails the schema and the
// whole presence entry is silently dropped by every consumer.
const omitNullValues = (value: unknown): unknown => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null || entry === undefined) continue;
    out[key] = entry;
  }
  return out;
};

const ActiveSessionStatusSchema = z.preprocess(
  omitNullValues,
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('running'),
      activity: z.enum(['image_generation']).optional(),
    }),
    z.object({
      type: z.literal('requestPermission'),
    }),
    z.object({
      type: z.literal('initializing'),
      stage: z.enum(['git-clone', 'managed-runtime', 'acp', 'resuming']).optional(),
      detail: z.string().optional(),
    }),
  ])
);

const PresenceInstanceIdSchema = z
  .string()
  .min(1)
  .transform((value) => {
    return value as LodyPresenceInstanceId;
  });

const PresenceMachineStateSchema = z.object({
  kind: z.literal('machine'),
  machineId: z
    .string()
    .min(1)
    .transform((value) => value as MachineId),
  instanceId: PresenceInstanceIdSchema,
  updatedAt: z.number().finite(),
});

const PresenceSessionStateSchema = z.object({
  kind: z.literal('session'),
  sessionId: z
    .string()
    .min(1)
    .transform((value) => value as SessionId),
  machineId: z
    .string()
    .min(1)
    .transform((value) => value as MachineId),
  instanceId: PresenceInstanceIdSchema,
  status: ActiveSessionStatusSchema,
  updatedAt: z.number().finite(),
});

const PresenceSessionViewingStateSchema = z.object({
  kind: z.literal('session-viewing'),
  userId: z.string().min(1),
  instanceId: PresenceInstanceIdSchema,
  sessionId: z
    .string()
    .min(1)
    .transform((value) => value as SessionId),
  since: z.number().finite(),
  updatedAt: z.number().finite(),
});

export const LodyPresenceStateSchema = z.discriminatedUnion('kind', [
  PresenceMachineStateSchema,
  PresenceSessionStateSchema,
  PresenceSessionViewingStateSchema,
]);

export const getLodyMachinePresenceKey = (
  machineId: MachineId,
  instanceId: LodyPresenceInstanceId
): string => `machine:${encodeURIComponent(machineId)}:${encodeURIComponent(instanceId)}`;

export const getLodySessionPresenceKey = (
  sessionId: SessionId,
  instanceId: LodyPresenceInstanceId
): string => `session:${encodeURIComponent(sessionId)}:${encodeURIComponent(instanceId)}`;

export const getLodySessionViewingPresenceKey = (
  userId: string,
  instanceId: LodyPresenceInstanceId
): string => `viewing:${encodeURIComponent(userId)}:${encodeURIComponent(instanceId)}`;

export const toLodyPresenceStreamUrl = (durableStreamUrl: string): string => {
  const url = new URL(durableStreamUrl);
  url.searchParams.set('ephemeral', LODY_PRESENCE_CHANNEL);
  return url.toString();
};

export const parseLodyPresenceStates = (states: Record<string, unknown>): LodyPresenceStateMap => {
  const parsed: LodyPresenceStateMap = {};
  for (const [key, value] of Object.entries(states)) {
    const result = LodyPresenceStateSchema.safeParse(value);
    if (!result.success) continue;
    parsed[key] = result.data;
  }
  return parsed;
};

export const isFreshLodyPresenceState = (
  state: Pick<LodyPresenceState, 'updatedAt'>,
  nowMs: number,
  ttlMs: number = LODY_PRESENCE_TTL_MS
): boolean => {
  return Number.isFinite(state.updatedAt) && nowMs - state.updatedAt < ttlMs;
};

export const findFreshMachinePresenceState = (
  states: LodyPresenceStateMap,
  machineId: MachineId,
  nowMs: number,
  ttlMs: number = LODY_PRESENCE_TTL_MS
): LodyMachinePresenceState | undefined => {
  let latest: LodyMachinePresenceState | undefined;
  for (const state of Object.values(states)) {
    if (state.kind !== 'machine' || state.machineId !== machineId) continue;
    if (!isFreshLodyPresenceState(state, nowMs, ttlMs)) continue;
    if (!latest || state.updatedAt > latest.updatedAt) {
      latest = state;
    }
  }
  return latest;
};

export const findFreshSessionPresenceState = (
  states: LodyPresenceStateMap,
  sessionId: SessionId,
  nowMs: number,
  ttlMs: number = LODY_PRESENCE_TTL_MS
): LodySessionPresenceState | undefined => {
  let latest: LodySessionPresenceState | undefined;
  for (const state of Object.values(states)) {
    if (state.kind !== 'session' || state.sessionId !== sessionId) continue;
    if (!isFreshLodyPresenceState(state, nowMs, ttlMs)) continue;
    if (!latest || state.updatedAt > latest.updatedAt) {
      latest = state;
    }
  }
  return latest;
};

/**
 * Sessions with at least one fresh viewer. Any viewer counts — the owning
 * machine keeps a viewed session fresh on behalf of the whole workspace.
 */
export const collectViewedSessionIdsFromPresence = (
  states: LodyPresenceStateMap,
  nowMs: number,
  ttlMs: number = LODY_PRESENCE_TTL_MS
): Set<SessionId> => {
  const viewed = new Set<SessionId>();
  for (const state of Object.values(states)) {
    if (state.kind !== 'session-viewing') continue;
    if (!isFreshLodyPresenceState(state, nowMs, ttlMs)) continue;
    viewed.add(state.sessionId);
  }
  return viewed;
};

/**
 * Machine liveness is judged from the ephemeral presence channel only: a
 * machine is online iff it has a fresh presence heartbeat. Durable
 * `MachineMeta.lastSeen` is legacy registration-time data and must not be
 * used for online checks.
 */
export const collectOnlineMachineIdsFromPresence = (
  states: LodyPresenceStateMap,
  nowMs: number,
  ttlMs: number = LODY_PRESENCE_TTL_MS
): Set<MachineId> => {
  const online = new Set<MachineId>();
  for (const state of Object.values(states)) {
    if (state.kind !== 'machine') continue;
    if (!isFreshLodyPresenceState(state, nowMs, ttlMs)) continue;
    online.add(state.machineId);
  }
  return online;
};
