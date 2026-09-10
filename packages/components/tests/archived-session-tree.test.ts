import { describe, expect, it } from 'vitest';
import type { SessionId, SessionMeta } from '@lody/shared';
import { buildArchivedSessionTree } from '../src/lib/archived-session-tree';

function session(id: string, relations: Partial<SessionMeta> = {}): SessionMeta {
  return { id: id as SessionId, ...relations } as SessionMeta;
}

describe('buildArchivedSessionTree', () => {
  it('keeps agent-opened sessions indented below their archived root', () => {
    const root = session('root');
    const opened = session('opened', { openedBySessionId: root.id });
    const openedFromTab = session('opened-from-tab', {
      openedBySessionId: 'tab' as SessionId,
      openedByRootSessionId: root.id,
    });

    expect(buildArchivedSessionTree([root, opened, openedFromTab, session('unrelated')])).toEqual([
      expect.objectContaining({ id: 'root', depth: 0, childCount: 2 }),
      expect.objectContaining({ id: 'opened', depth: 1, openedById: 'root' }),
      expect.objectContaining({ id: 'opened-from-tab', depth: 1, openedById: 'root' }),
      expect.objectContaining({ id: 'unrelated', depth: 0 }),
    ]);
  });
});
