import type { RoomModel } from './manifest';

/**
 * Room classification shared by export and import. A codec names the domain and
 * the format of its raw bytes; import rejects any codec it does not list here.
 */
export type RoomClass =
  | {
      kind: 'room';
      model: RoomModel;
      codec: RoomCodec;
      encoding: RoomEncoding;
      /** Room id with the workspace prefix removed, for Flock rooms. */
      suffix?: string;
    }
  | { kind: 'excluded' }
  | { kind: 'unknown' };

export const META_ROOM_ID = 'meta';
/** Bundle-only room holding a Roost conversation's visible turns, read out as JSON. */
export const ROOST_ROOM_PREFIX = 'roost:';

const LORO_CODECS = {
  'session-comment-': 'session-comment/v1',
  'preview-comment-': 'preview-comment/v1',
  'session-': 'session/v1',
  'schedule-': 'schedule/v1',
  'task-': 'task/v1',
  'machine-': 'machine/v1',
  'agent-': 'agent-config/v1',
} as const;

const FLOCK_CODECS = {
  'wf:workspace': 'workspace-catalog/v1',
  sr: 'schedule-registry/v1',
  ti: 'task-index/v1',
} as const;

export type RoomCodec =
  | 'meta/v1'
  | (typeof LORO_CODECS)[keyof typeof LORO_CODECS]
  | (typeof FLOCK_CODECS)[keyof typeof FLOCK_CODECS]
  | 'machine-catalog/v1'
  | 'roost-turns/v1';
export type RoomEncoding = 'flock-file/v1' | 'loro-snapshot/v1' | 'json/v1';

export const KNOWN_CODECS: ReadonlySet<string> = new Set<string>([
  'meta/v1',
  ...Object.values(LORO_CODECS),
  ...Object.values(FLOCK_CODECS),
  'machine-catalog/v1',
  'roost-turns/v1',
]);

/** Codecs whose rooms describe one machine; they never cross workspaces. */
export const MACHINE_CODECS: ReadonlySet<string> = new Set([
  'machine/v1',
  'agent-config/v1',
  'machine-catalog/v1',
]);

export function classifyRoom(roomId: string, workspaceId: string): RoomClass {
  if (roomId === META_ROOM_ID)
    return { kind: 'room', model: 'meta', codec: 'meta/v1', encoding: 'flock-file/v1' };
  const prefix = `${workspaceId}:`;
  if (roomId.startsWith(prefix)) {
    const suffix = roomId.slice(prefix.length);
    // File indexes are rebuilt by their owner and expire; they are not workspace data.
    if (/^(fi|fis):/.test(suffix)) return { kind: 'excluded' };
    if (/^mf:[^:]+$/.test(suffix))
      return { kind: 'room', model: 'flock', codec: 'machine-catalog/v1', encoding: 'flock-file/v1', suffix };
    const codec = FLOCK_CODECS[suffix as keyof typeof FLOCK_CODECS];
    return codec
      ? { kind: 'room', model: 'flock', codec, encoding: 'flock-file/v1', suffix }
      : { kind: 'unknown' };
  }
  if (roomId.includes(':')) return { kind: 'unknown' };
  for (const [docPrefix, codec] of Object.entries(LORO_CODECS)) {
    if (roomId.startsWith(docPrefix) && roomId.length > docPrefix.length)
      return { kind: 'room', model: 'loro', codec, encoding: 'loro-snapshot/v1' };
  }
  return { kind: 'unknown' };
}
