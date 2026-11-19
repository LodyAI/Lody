import type { BundleKind } from '@lody/shared/workspace-bundle-control';
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

/**
 * What each codec is to a person and to a cross-workspace import. `counted` rooms are
 * the items a person recognises; the others (indexes, Roost turn payloads) still show
 * when skipped. `machine` rooms describe one machine and never cross workspaces.
 */
export const CODEC_TRAITS: Readonly<
  Record<RoomCodec, { kind: BundleKind; counted: boolean; machine?: true }>
> = {
  'meta/v1': { kind: 'other', counted: false },
  'session/v1': { kind: 'conversations', counted: true },
  'roost-turns/v1': { kind: 'conversations', counted: false },
  'session-comment/v1': { kind: 'other', counted: true },
  'preview-comment/v1': { kind: 'previewComments', counted: true },
  'schedule/v1': { kind: 'schedules', counted: true },
  'schedule-registry/v1': { kind: 'schedules', counted: false },
  'task/v1': { kind: 'other', counted: true },
  'task-index/v1': { kind: 'other', counted: false },
  'workspace-catalog/v1': { kind: 'catalog', counted: true },
  'machine/v1': { kind: 'machines', counted: false, machine: true },
  'agent-config/v1': { kind: 'machines', counted: false, machine: true },
  'machine-catalog/v1': { kind: 'machines', counted: true, machine: true },
};

export const KNOWN_CODECS: ReadonlySet<string> = new Set(Object.keys(CODEC_TRAITS));

export function codecTraits(codec: string) {
  return KNOWN_CODECS.has(codec) ? CODEC_TRAITS[codec as RoomCodec] : undefined;
}

export function classifyRoom(roomId: string, workspaceId: string): RoomClass {
  if (roomId === META_ROOM_ID)
    return { kind: 'room', model: 'meta', codec: 'meta/v1', encoding: 'flock-file/v1' };
  const prefix = `${workspaceId}:`;
  if (roomId.startsWith(prefix)) {
    const suffix = roomId.slice(prefix.length);
    // File indexes are rebuilt by their owner and expire; they are not workspace data.
    if (/^(fi|fis):/.test(suffix)) return { kind: 'excluded' };
    if (/^mf:[^:]+$/.test(suffix))
      return {
        kind: 'room',
        model: 'flock',
        codec: 'machine-catalog/v1',
        encoding: 'flock-file/v1',
      };
    const codec = FLOCK_CODECS[suffix as keyof typeof FLOCK_CODECS];
    return codec
      ? { kind: 'room', model: 'flock', codec, encoding: 'flock-file/v1' }
      : { kind: 'unknown' };
  }
  if (roomId.includes(':')) return { kind: 'unknown' };
  for (const [docPrefix, codec] of Object.entries(LORO_CODECS)) {
    if (roomId.startsWith(docPrefix) && roomId.length > docPrefix.length)
      return { kind: 'room', model: 'loro', codec, encoding: 'loro-snapshot/v1' };
  }
  return { kind: 'unknown' };
}
