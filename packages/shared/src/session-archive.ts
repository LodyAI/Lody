import type { MachineId, SessionId } from './ids';
import {
  getSessionPullRequestLegacyFields,
  type MachineMeta,
  type SessionMeta,
  type SessionPullRequestMeta,
} from './schema';
import {
  machineSupportsProtocolCapability,
  MACHINE_PROTOCOL_CAPABILITIES,
} from './machine-protocol-capabilities';

export type SessionArchiveRequest = {
  id: string;
  roots: SessionId[];
  targets: SessionId[];
  source: 'manual' | 'pr';
  phase: 'waiting' | 'preparing' | 'committed' | 'cancelled' | 'completed';
  /** Changes whenever preparation is retried; old readiness never authorizes a new commit. */
  generation: number;
  heldSendIds: string[];
  pr?: { url: string; status: 'merged' | 'closed' };
};

export type SessionArchiveLink = { rootId: SessionId; requestId: string };
export type SessionArchiveReadiness = {
  requestId: string;
  generation: number;
  state: 'busy' | 'ready' | 'prepared';
};
export type SessionArchiveResult = 'pending' | 'archived' | 'cancelled';
export type SessionArchiveMode = 'wait' | 'immediate';

export function isSessionArchivePending(meta: Pick<SessionMeta, 'isArchived' | 'archivePending'>) {
  return !meta.isArchived && Boolean(meta.archivePending);
}

/** A prepared owner holds an execution fence until the durable decision is known. */
export function isSessionArchiveFenced(meta: SessionMeta): boolean {
  return Boolean(
    meta.archivePending &&
    meta.archiveReadiness?.requestId === meta.archivePending.requestId &&
    meta.archiveReadiness.state === 'prepared'
  );
}

export function isArchiveRequestActive(request: SessionArchiveRequest | null | undefined) {
  return request && request.phase !== 'cancelled' && request.phase !== 'completed';
}

export type SessionArchivePorts = {
  read: (id: SessionId) => Promise<SessionMeta | undefined>;
  write: (id: SessionId, patch: Partial<SessionMeta>) => Promise<void>;
  readMachine: (id: MachineId) => Promise<MachineMeta | undefined>;
};

export async function cancelSessionArchive(ports: SessionArchivePorts, session: SessionMeta) {
  const rootId = session.archivePending?.rootId ?? session.id;
  const root = await ports.read(rootId);
  const request = root?.archiveRequest;
  if (!request || !isArchiveRequestActive(request)) return;
  if (request.phase === 'committed')
    throw new Error('Archive has committed; restore the conversation after it finishes.');
  await ports.write(rootId, { archiveCancelledRequestId: request.id });
}

/** Callers discover one ready authoritative target snapshot before writing intent. */
export async function requestDeferredSessionArchive(
  ports: SessionArchivePorts,
  input: {
    id: string;
    roots: SessionId[];
    targets: SessionMeta[];
    source: 'manual' | 'pr';
    heldSendIds?: string[];
    pr?: SessionArchiveRequest['pr'];
  }
): Promise<{ rootId: SessionId; requestId: string }> {
  const rootId = input.roots[0];
  if (!rootId || input.targets.length === 0) throw new Error('Archive requires a conversation.');
  const root = await ports.read(rootId);
  if (!root) throw new Error('Conversation is no longer available.');
  if (
    isArchiveRequestActive(root.archiveRequest) &&
    root.archiveRequest &&
    root.archiveCancelledRequestId !== root.archiveRequest.id
  ) {
    if (
      input.targets.some((target) => !root.archiveRequest!.targets.includes(target.id)) ||
      (input.heldSendIds ?? []).some((id) => !root.archiveRequest!.heldSendIds.includes(id))
    ) {
      throw new Error(
        'The pending archive has a different scope. Cancel it before requesting another archive.'
      );
    }
    return { rootId, requestId: root.archiveRequest.id };
  }
  for (const machineId of new Set(input.targets.map((target) => target.machineId))) {
    if (
      !machineSupportsProtocolCapability(
        await ports.readMachine(machineId),
        MACHINE_PROTOCOL_CAPABILITIES.deferredSessionArchive
      )
    ) {
      throw new Error(
        'A target machine does not support deferred archive. Update its daemon or choose archive immediately.'
      );
    }
  }
  for (const target of input.targets) {
    const link = target.archivePending;
    if (!link) continue;
    const owner = await ports.read(link.rootId);
    if (
      owner?.archiveRequest?.id === link.requestId &&
      owner.archiveCancelledRequestId !== link.requestId &&
      isArchiveRequestActive(owner.archiveRequest)
    ) {
      throw new Error(
        'A conversation already belongs to another pending archive. Cancel that request first.'
      );
    }
  }
  await ports.write(rootId, {
    archiveRequest: {
      id: input.id,
      roots: input.roots,
      targets: input.targets.map((target) => target.id),
      source: input.source,
      phase: 'waiting',
      generation: 1,
      heldSendIds: input.heldSendIds ?? [],
      ...(input.pr ? { pr: input.pr } : {}),
    },
    archivePending: { rootId, requestId: input.id },
  });
  return { rootId, requestId: input.id };
}

export function pickLatestSessionArchivePr(
  prs: SessionPullRequestMeta[] | undefined
): SessionPullRequestMeta | null {
  if (!prs || prs.length === 0) return null;
  let latest = prs[0];
  if (!latest) return null;
  for (let i = 1; i < prs.length; i++) {
    const candidate = prs[i];
    if (!candidate) continue;
    // ISO 8601 timestamps sort lexicographically, so plain `>` is correct and cheaper.
    const candidateReportedAt = getSessionPullRequestLegacyFields(candidate).reportedAt;
    const latestReportedAt = getSessionPullRequestLegacyFields(latest).reportedAt;
    if (candidateReportedAt || latestReportedAt) {
      if ((candidateReportedAt ?? '') > (latestReportedAt ?? '')) {
        latest = candidate;
      }
      continue;
    }
    if (i > 0) {
      latest = candidate;
    }
  }
  return latest;
}
