import {
  getSessionRoomId,
  isLoroRepoDocDeleted,
  planSessionPullRequestLink,
  planSessionPullRequestUnlink,
  resolveSessionPullRequestLinkList,
  type SessionId,
  type SessionMeta,
  type SessionPullRequestLinkListItem,
  type SessionPullRequestLinkSource,
} from '@lody/shared';

/**
 * Daemon-side explicit PR link operations for ONE Session: the `gh` shim
 * report endpoint uses `link` today; a Session-scoped agent tool can call the
 * same three operations. The daemon authors these records because the data is
 * agent-produced; the renderer writes the user's own records directly. A link
 * is intent only — the PR reconciler associates it after the provider confirms
 * the PR. Child Tabs resolve to their owner Session, as PR ownership does.
 */
export type SessionPullRequestLinkStore = {
  getDocMeta(roomId: string): Promise<{ meta?: unknown } | undefined>;
  upsertDocMeta(roomId: string, patch: Record<string, unknown>): Promise<void>;
};

export type SessionPullRequestLinkRefusal =
  | 'session_not_found'
  | 'not_this_machine'
  | 'session_archived'
  | 'unsupported'
  | 'limit';

export type SessionPullRequestLinkResult =
  | { linked: true; sessionId: SessionId; url: string }
  | { linked: false; unlinked: true; sessionId: SessionId; url: string }
  | { linked: false; reason: SessionPullRequestLinkRefusal };

export function createSessionPullRequestLinks(options: {
  store: SessionPullRequestLinkStore;
  machineId: string;
  nowMs?: () => number;
}) {
  const { store, machineId } = options;
  const nowMs = options.nowMs ?? Date.now;

  const readMeta = async (sessionId: string): Promise<SessionMeta | null> => {
    const record = await store.getDocMeta(getSessionRoomId(sessionId as SessionId));
    return record?.meta && !isLoroRepoDocDeleted(record) ? (record.meta as SessionMeta) : null;
  };

  const resolveOwner = async (
    sessionId: string
  ): Promise<
    | { ok: true; ownerSessionId: SessionId; meta: SessionMeta }
    | { ok: false; reason: SessionPullRequestLinkRefusal }
  > => {
    const meta = await readMeta(sessionId);
    if (!meta) return { ok: false, reason: 'session_not_found' };
    const ownerSessionId = (meta.parentSessionId ?? sessionId) as SessionId;
    const owner = ownerSessionId === sessionId ? meta : await readMeta(ownerSessionId);
    if (!owner) return { ok: false, reason: 'session_not_found' };
    if (owner.machineId !== machineId) return { ok: false, reason: 'not_this_machine' };
    if (owner.isArchived) return { ok: false, reason: 'session_archived' };
    return { ok: true, ownerSessionId, meta: owner };
  };

  const write = async (
    sessionId: string,
    url: string,
    k: 'link' | 'unlink',
    source: SessionPullRequestLinkSource
  ): Promise<SessionPullRequestLinkResult> => {
    const owner = await resolveOwner(sessionId);
    if (!owner.ok) return { linked: false, reason: owner.reason };
    const plan =
      k === 'link'
        ? planSessionPullRequestLink(owner.meta, url, source, nowMs())
        : planSessionPullRequestUnlink(owner.meta, url, nowMs(), source);
    if (!plan.ok) return { linked: false, reason: plan.reason };
    await store.upsertDocMeta(getSessionRoomId(owner.ownerSessionId), { [plan.field]: plan.value });
    return k === 'link'
      ? { linked: true, sessionId: owner.ownerSessionId, url: plan.url }
      : { linked: false, unlinked: true, sessionId: owner.ownerSessionId, url: plan.url };
  };

  return {
    link: (sessionId: string, url: string, source: SessionPullRequestLinkSource) =>
      write(sessionId, url, 'link', source),
    unlink: (sessionId: string, url: string, source: SessionPullRequestLinkSource = 'agent') =>
      write(sessionId, url, 'unlink', source),
    /** Every PR the Session holds, the primary first; pending records carry a reason. */
    list: async (sessionId: string): Promise<SessionPullRequestLinkListItem[]> => {
      const owner = await resolveOwner(sessionId);
      return owner.ok ? resolveSessionPullRequestLinkList(owner.meta) : [];
    },
  };
}

export type SessionPullRequestLinks = ReturnType<typeof createSessionPullRequestLinks>;
