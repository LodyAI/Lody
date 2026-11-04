import { resolveLatestSessionGoalFromHistory, type SessionGoalMessage } from '@lody/shared';
import { decodeJson } from '@loro-dev/roost';
import { applicationJsonText, toApplicationJson } from '@loro-dev/roost/lody-history';
import type { IndexPut, RoostNodeStream } from '@loro-dev/roost-node';

/** Local derived index; the event cursor fences the signed history it summarizes. */
const key = { table: 'lody_goal_projection_v1', key: new Uint8Array() };
export type RoostGoalProjection = {
  turnId: string;
  position: number;
  goal: SessionGoalMessage;
} | null;

export const projectLatestGoal = (
  entries: readonly { readonly id: string; readonly items?: unknown }[],
  start = 0
): RoostGoalProjection => {
  for (let position = entries.length - 1; position >= 0; position -= 1) {
    const entry = entries[position];
    if (!entry) continue;
    const goal = resolveLatestSessionGoalFromHistory([entry]);
    if (goal) return { turnId: entry.id, position: start + position, goal };
  }
  return null;
};

/** Pure staging uses the same rules as the installed projection. Unknown history
 * stays unknown; removing the current goal requires authoritative rediscovery. */
export const projectChangedGoal = (
  current: RoostGoalProjection | undefined,
  entry: { readonly id: string; readonly items?: unknown },
  position: number | undefined,
  count: number
): { latest: RoostGoalProjection | undefined; invalidated: boolean } => {
  const latest = projectLatestGoal([entry], position ?? 0);
  if (position === undefined) {
    return latest || current?.turnId === entry.id
      ? { latest: undefined, invalidated: true }
      : { latest: current, invalidated: false };
  }
  if (latest) {
    return {
      latest:
        current === null ||
        (current !== undefined && position >= current.position) ||
        position === count - 1
          ? latest
          : current,
      invalidated: false,
    };
  }
  return current?.turnId === entry.id
    ? { latest: undefined, invalidated: true }
    : { latest: current, invalidated: false };
};

export const readGoalProjection = async (
  host: RoostNodeStream,
  cursor: bigint,
  count: number
): Promise<RoostGoalProjection | undefined> => {
  const [bytes] = await host.readIndex([key]);
  if (!bytes) return undefined;
  try {
    const value = toApplicationJson(decodeJson(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const saved = value as Record<string, unknown>;
    if (saved.version !== 1 || saved.cursor !== cursor.toString()) return undefined;
    if (saved.latest === null) return null;
    if (!saved.latest || typeof saved.latest !== 'object' || Array.isArray(saved.latest))
      return undefined;
    const latest = saved.latest as Record<string, unknown>;
    if (
      typeof latest.turnId !== 'string' ||
      !latest.turnId ||
      typeof latest.position !== 'number' ||
      !Number.isSafeInteger(latest.position) ||
      latest.position < 0 ||
      latest.position >= count
    )
      return undefined;
    const goal = resolveLatestSessionGoalFromHistory([{ items: [latest.goal] }]);
    return goal ? { turnId: latest.turnId, position: latest.position, goal } : undefined;
  } catch {
    return undefined;
  }
};

export const goalProjectionPut = (cursor: bigint, latest: RoostGoalProjection): IndexPut => ({
  ...key,
  value: new TextEncoder().encode(
    applicationJsonText({ version: 1, cursor: cursor.toString(), latest })
  ),
});

export const writeGoalProjection = (
  host: RoostNodeStream,
  cursor: bigint,
  latest: RoostGoalProjection
) =>
  host.writeBatch([], {
    expectedEventCursor: cursor,
    // This projection adds no history event or command receipt. A failed CAS
    // leaves it absent/stale; the next guarded edit reads authoritative history.
    indexPuts: [goalProjectionPut(cursor, latest)],
  });
