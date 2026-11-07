type Row = Record<string, any>;
/** Only a durable, finished provider turn can be used as a fork boundary. */
export function forkableTurn(
  history: Row[],
  meta: Row,
  capability: Row | undefined,
  id: string,
): boolean {
  if (
    meta.isArchived ||
    !meta.machineId ||
    !meta.agentConfigId ||
    capability?.provenance !== 'runtime' ||
    capability.sessionFork !== true
  )
    return false;
  return history.some(
    (turn) =>
      turn.id === id &&
      turn.role === 'assistant' &&
      turn.finished === true &&
      typeof turn.acpTurnId === 'string' &&
      turn.acpTurnId.length > 0,
  );
}

type ForkState = 'created' | 'rejected' | 'unknown';
/** Publish uncertainty before transport starts. A lost response must never cause a replay. */
export async function forkOnce(
  attempts: Map<string, ForkState>,
  key: string,
  request: { sourceSessionId: string; targetSessionId: string },
  send: () => Promise<{ result?: unknown }>,
): Promise<{ state: ForkState }> {
  const previous = attempts.get(key);
  if (previous) return { state: previous };
  attempts.set(key, 'unknown');
  try {
    const reply = await send();
    const result = reply.result as Row | undefined;
    let state: ForkState = 'unknown';
    if (
      result?.sourceSessionId === request.sourceSessionId &&
      result?.targetSessionId === request.targetSessionId
    ) {
      if (result.success === true) state = 'created';
      else if (result.success === false) state = 'rejected';
    }
    attempts.set(key, state);
    return { state };
  } catch {
    return { state: 'unknown' };
  }
}

/** Metadata may be one legacy object or newer per-field Flock rows. */
export function sessionActionMeta(
  base: unknown,
  rows: { key: readonly unknown[]; value?: unknown }[],
  exists: unknown,
): Row | undefined {
  if (exists === false || (!base && !rows.length)) return undefined;
  const value: Row =
    base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {};
  for (const row of rows)
    if (row.key.length === 3 && typeof row.key[2] === 'string')
      value[row.key[2]] = row.value;
  return value;
}
