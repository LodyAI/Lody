import type { Flock } from '@loro-dev/flock-wasm/base64';
import type { StreamsClient } from '@loro-dev/streams-client';
import type { Catalog, Project } from '../../models/catalog.ts';
import type { MachinePresence } from '../../models/machines.ts';
import type {
  Grant,
  SessionRuntimeEvent,
  ShortcutCloudParams,
} from '../../contract/methods.ts';
import type { createChannel } from '../channel.ts';
import type { FileContext } from '../files';

export type RuntimeChannel = ReturnType<typeof createChannel>;
export type MetaReplica = { flock: Flock; client: StreamsClient };

export type RuntimeState = {
  workspace: string;
  userId: string;
  metaReplica: MetaReplica | undefined;
  presence: MachinePresence;
  knownProjects: Pick<Project, 'id' | 'repoFullName'>[];
  readonly machineReplicas: Map<string, Flock>;
  readonly catalogs: Map<string, Catalog>;
  readonly unhealthy: Set<string>;
};

export type RuntimeContext = {
  channel: RuntimeChannel;
  state: RuntimeState;
  getGrant: () => Promise<Grant>;
  broker: (operation: string, args: object) => Promise<unknown>;
  publish: () => void;
  publishSubscriptions: () => void;
  emitSession: (event: SessionRuntimeEvent) => void;
  markDispatch: (
    sessionId: string,
    turnId: string,
    queued?: boolean,
  ) => Promise<void>;
  watch: (mode: string) => void;
  startPresence: () => void;
  stopPresence: () => void;
};

export function scopedShortcutCloud(
  { channel, state }: RuntimeContext,
  workspaceId: string,
  userId: string,
) {
  return async (operation: string, args: Record<string, unknown>) => {
    const check = () => {
      if (state.workspace !== workspaceId || state.userId !== userId)
        throw new Error('workspace_changed');
    };
    check();
    let value: unknown;
    try {
      ({ value } = await channel.request('shortcutCloud', {
        workspaceId,
        operation,
        args,
      } as ShortcutCloudParams));
    } catch {
      throw new Error('shortcut_unavailable');
    }
    check();
    return value;
  };
}

export function machineFor(
  { state, getGrant }: RuntimeContext,
  sessionId: string,
  path: string,
): FileContext & { localProjectId?: string } {
  if (!state.metaReplica || state.unhealthy.size)
    throw new Error('metadata_not_ready');
  if (typeof path !== 'string' || path.length > 32768 || path.includes('\0'))
    throw new Error('invalid_path');
  const session = state.catalogs
    .get('meta')
    ?.sessions.find((item) => item.id === sessionId);
  if (!session || !state.machineReplicas.has(session.machineId))
    throw new Error('machine_unavailable');
  const localPrefix = `${session.machineId}:local:`;
  return {
    workspaceId: state.workspace,
    machineId: session.machineId,
    // Code Collab ownership lives in workspace Meta Flock, not the session doc.
    ownerSessionId: session.parentSessionId ?? session.id,
    localProjectId: session.projectId.startsWith(localPrefix)
      ? session.projectId.slice(localPrefix.length)
      : undefined,
    getGrant,
    signal: AbortSignal.timeout(35000),
  };
}
