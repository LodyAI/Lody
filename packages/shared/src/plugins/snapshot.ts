export const MAX_UNSTABLE_SNAPSHOT_BYTES = 512 * 1024;
const fields = {
  sessions: [
    'id',
    'title',
    'machineId',
    'userId',
    'createdAt',
    'updatedAt',
    'isArchived',
    'agentRoleId',
    'branchName',
    'createdByPluginId',
  ],
  projects: ['id', 'name', 'machineId', 'createdAtMs', 'lastOpenedAtMs', 'rootPath'],
  machines: ['id', 'name', 'platform', 'version'],
  roles: ['id', 'name', 'description', 'machineId'],
  schedules: ['scheduleId', 'title', 'enabled', 'machineId', 'nextRunAt'],
  rateLimits: ['limitId', 'limitName', 'planName'],
  windows: ['label', 'usedPercent', 'windowDurationSeconds', 'resetsAtEpochSeconds'],
  turns: [
    'id',
    'role',
    'userTurnId',
    'timestamp',
    'startedAt',
    'endedAt',
    'finished',
    'proseMarkdown',
  ],
} as const;
const deny = (): never => {
  throw Object.assign(Error('Snapshot target unavailable'), { code: 'forbidden' });
};
const own = (x: unknown, k: string): unknown =>
  x && typeof x === 'object' ? Object.getOwnPropertyDescriptor(x, k)?.value : undefined;
/** Project known scalar fields rather than copying unknown nested data. */
export function copyPluginSnapshot(
  raw: unknown,
  path: readonly string[],
  pluginId: string,
  kind: string
) {
  let size = 0;
  const count = (v: string) => {
    if (v.length > MAX_UNSTABLE_SNAPSHOT_BYTES) throw Error('Snapshot exceeds byte limit');
    size += new TextEncoder().encode(JSON.stringify(v)).length;
    if (size > MAX_UNSTABLE_SNAPSHOT_BYTES) throw Error('Snapshot exceeds byte limit');
  };
  function row(x: unknown, collection: keyof typeof fields) {
    const result: Record<string, unknown> = Object.create(null);
    for (const k of [
      ...fields[collection],
      ...(collection === 'sessions' && own(x, 'createdByPluginId') === pluginId
        ? ['businessKey']
        : []),
    ]) {
      const value = own(x, k);
      if (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))
      ) {
        if (typeof value === 'string') count(value);
        result[k] = value;
      }
    }
    if (collection === 'rateLimits') {
      const windows = own(x, 'windows');
      if (Array.isArray(windows)) {
        if (windows.length > 100) throw Error('Invalid rate-limit window count');
        result.windows = Object.freeze(windows.map((w) => row(w, 'windows')));
      }
    }
    return Object.freeze(result);
  }
  let projected: unknown;
  if (kind === 'workspace-state') {
    const [collection, key, ...tail] = path;
    if (
      !collection ||
      !key ||
      !Object.hasOwn(fields, collection) ||
      collection === 'turns' ||
      collection === 'windows'
    )
      return deny();
    projected = row(own(own(raw, collection), key), collection as keyof typeof fields);
    path = tail;
  } else if (kind === 'session-meta') projected = row(raw, 'sessions');
  else if (kind === 'project-state' && path.length) projected = row(raw, 'projects');
  else if (kind === 'session-transcript') {
    const turns = own(raw, 'turns');
    if (!Array.isArray(turns) || turns.length > 100) return deny();
    projected = Object.freeze({ turns: Object.freeze(turns.map((t) => row(t, 'turns'))) });
  } else return deny();
  for (const k of path) {
    projected = own(projected, k);
    if (projected === undefined) return deny();
  }
  return projected;
}
export function checkSnapshotEnvelope<T>(value: T): T {
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_UNSTABLE_SNAPSHOT_BYTES)
    throw Error('Snapshot exceeds byte limit');
  return Object.freeze(value);
}
