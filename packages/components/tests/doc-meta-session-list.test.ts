import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';
import { getSessionRoomId, type MachineId, type SessionId, type SessionMeta } from '@lody/shared';

import {
  childSessionsAtomFamily,
  sessionListAtom,
  sessionMetaCacheAtom,
  sideSessionsAtomFamily,
} from '../src/atoms/doc-meta';

const sessionId = 'session-with-ci' as SessionId;
const roomId = getSessionRoomId(sessionId);
const prUrl = 'https://github.com/loro-dev/lody/pull/42';

const session: SessionMeta = {
  id: sessionId,
  machineId: 'machine-1' as MachineId,
  createdAt: '2026-07-19T00:00:00.000Z',
  userId: 'user-1',
  cliType: 'builtin',
  agentType: 'codex',
  pullRequests: [{ url: prUrl, status: 'open' }],
};

describe('sessionListAtom', () => {
  it('publishes a new list when only pullRequestState changes', () => {
    const store = createStore();
    store.set(sessionMetaCacheAtom, { [roomId]: session });
    const before = store.get(sessionListAtom);

    store.set(sessionMetaCacheAtom, {
      [roomId]: {
        ...session,
        pullRequestState: { [prUrl]: { s: 's', m: 'c', t: 1_752_000_000 } },
      },
    });
    const after = store.get(sessionListAtom);

    expect(after).not.toBe(before);
    expect(after[0]?.pullRequestState?.[prUrl]?.s).toBe('s');
  });

  it('projects side sessions into the right-panel list instead of child tabs', () => {
    const store = createStore();
    const parentId = 'parent-session' as SessionId;
    const childId = 'child-session' as SessionId;
    const sideId = 'side-session' as SessionId;
    store.set(sessionMetaCacheAtom, {
      [getSessionRoomId(parentId)]: { ...session, id: parentId },
      [getSessionRoomId(childId)]: {
        ...session,
        id: childId,
        parentSessionId: parentId,
      },
      [getSessionRoomId(sideId)]: {
        ...session,
        id: sideId,
        parentSessionId: parentId,
        childSessionPlacement: 'side-panel',
      },
    });

    expect(store.get(childSessionsAtomFamily(parentId)).map((item) => item.id)).toEqual([childId]);
    expect(store.get(sideSessionsAtomFamily(parentId)).map((item) => item.id)).toEqual([sideId]);
    expect(store.get(sessionListAtom).map((item) => item.id)).toEqual([parentId]);
  });

  it('orders child tabs by creation time when no local tab order exists', () => {
    const store = createStore();
    const parentId = 'parent-session' as SessionId;
    const olderChildId = 'older-child' as SessionId;
    const newerChildId = 'newer-child' as SessionId;

    store.set(sessionMetaCacheAtom, {
      [getSessionRoomId(parentId)]: { ...session, id: parentId },
      [getSessionRoomId(newerChildId)]: {
        ...session,
        id: newerChildId,
        parentSessionId: parentId,
        createdAt: '2026-07-19T00:02:00.000Z',
      },
      [getSessionRoomId(olderChildId)]: {
        ...session,
        id: olderChildId,
        parentSessionId: parentId,
        createdAt: '2026-07-19T00:01:00.000Z',
      },
    });

    expect(store.get(childSessionsAtomFamily(parentId)).map((item) => item.id)).toEqual([
      olderChildId,
      newerChildId,
    ]);
  });
});
