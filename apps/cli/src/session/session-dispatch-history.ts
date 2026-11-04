import type { SessionHistoryInput } from '@lody/shared';
import type {
  SessionDirectoryRow,
  SessionHistoryReader,
  SessionTurnRead,
} from '@lody/shared/session-data';

/** Dispatch evidence has no prompt, items, plan, tool output or provider metadata. */
export type SessionDispatchEntry = Pick<
  SessionHistoryInput,
  'id' | 'role' | 'status' | 'read' | 'userTurnId' | 'endedAt'
> & { inputConfig?: Pick<NonNullable<SessionHistoryInput['inputConfig']>, '_lodyDeliveryKind'> };
export type SessionDispatchSelector = (
  history: readonly SessionDispatchEntry[]
) => string | undefined;
export type SessionDispatchSelection = {
  history: SessionDispatchEntry[];
  turnId?: string;
  turn?: SessionTurnRead;
};

type DispatchSource = Omit<SessionDispatchEntry, 'inputConfig'> & { inputConfig?: unknown };
export const dispatchEntry = (entry: DispatchSource): SessionDispatchEntry => ({
  id: entry.id,
  role: entry.role,
  ...(entry.status === undefined ? {} : { status: entry.status }),
  ...(entry.read === undefined ? {} : { read: entry.read }),
  ...(entry.userTurnId === undefined ? {} : { userTurnId: entry.userTurnId }),
  ...(entry.endedAt === undefined ? {} : { endedAt: entry.endedAt }),
  ...(entry.inputConfig &&
  typeof entry.inputConfig === 'object' &&
  '_lodyDeliveryKind' in entry.inputConfig &&
  entry.inputConfig._lodyDeliveryKind === 'steer'
    ? { inputConfig: { _lodyDeliveryKind: 'steer' as const } }
    : {}),
});

/** A potential input, before metadata-specific prepared/steer/import gates. */
export const isDispatchCandidate = (entry: SessionDispatchEntry): boolean =>
  entry.role === 'user' &&
  (entry.status === undefined
    ? entry.read === false
    : ['pending', 'seen', 'processing', 'prepared', 'pending_apply'].includes(entry.status));

/** Keep last-copy selection and every relevant completion/terminal witness. */
export function selectDispatchHistory(
  entries: readonly SessionDispatchEntry[],
  includeTurnIds: readonly string[]
): SessionDispatchEntry[] {
  const last = new Map(entries.map((entry) => [entry.id, entry]));
  const ids = new Set(includeTurnIds);
  for (const entry of last.values()) if (isDispatchCandidate(entry)) ids.add(entry.id);
  return entries.filter(
    (entry) =>
      ids.has(entry.id) ||
      (entry.role === 'assistant' &&
        entry.userTurnId !== undefined &&
        ids.has(entry.userTurnId) &&
        typeof entry.endedAt === 'number')
  );
}

export function dispatchEntryFromDirectory(row: SessionDirectoryRow): SessionDispatchEntry[] {
  if (row.state !== 'ready' || !row.scalars) return [];
  return [
    dispatchEntry({
      ...row.scalars,
      inputConfig: row.inputConfig as SessionDispatchEntry['inputConfig'],
    }),
  ];
}

/** One directory observation; the in-process Loro reader stays synchronous. */
export async function readDispatchHistory(
  reader: SessionHistoryReader,
  includeTurnIds: readonly string[]
): Promise<SessionDispatchEntry[]> {
  const requested = [...includeTurnIds];
  const rows = await reader.readDirectory(0, Number.MAX_SAFE_INTEGER);
  return selectDispatchHistory(rows.flatMap(dispatchEntryFromDirectory), requested);
}

/** The CLI Loro owner reads both parts synchronously, before yielding. Other
 * owners must supply their own cursor-fenced implementation rather than stitch
 * independently awaited directory/body reads into a purported snapshot. */
export function readDispatchSelection(
  reader: SessionHistoryReader,
  includeTurnIds: readonly string[],
  select: SessionDispatchSelector
): Promise<SessionDispatchSelection> {
  const rows = reader.readDirectory(0, Number.MAX_SAFE_INTEGER);
  if (rows instanceof Promise)
    throw new Error('Dispatch selection requires the owning history backend');
  const history = selectDispatchHistory(rows.flatMap(dispatchEntryFromDirectory), includeTurnIds);
  const turnId = select(history);
  const turn = turnId === undefined ? undefined : reader.readTurn(turnId);
  if (turn instanceof Promise)
    throw new Error('Dispatch selection requires a coherent owner observation');
  return Promise.resolve({ history, turnId, turn });
}

export const sameDispatchEntry = (left: DispatchSource, right: DispatchSource) =>
  JSON.stringify(dispatchEntry(left)) === JSON.stringify(dispatchEntry(right));
