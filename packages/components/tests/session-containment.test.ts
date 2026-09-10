import { describe, expect, it } from 'vitest';
import type { SessionId, SessionMeta } from '@lody/shared';
import { collectSessionContainmentIds } from '../src/lib/session-containment';

function session(id: string, relations: Partial<SessionMeta> = {}): SessionMeta {
  return { id: id as SessionId, ...relations } as SessionMeta;
}

describe('collectSessionContainmentIds', () => {
  it('collects child Tabs without crossing opened-by provenance', () => {
    const sessions = [
      session('root'),
      session('tab', {
        parentSessionId: 'root' as SessionId,
        openedBySessionId: 'root' as SessionId,
      }),
      session('opened', { openedBySessionId: 'root' as SessionId }),
      session('opened-from-tab', {
        openedBySessionId: 'tab' as SessionId,
        openedByRootSessionId: 'root' as SessionId,
      }),
      session('opened-grandchild', { openedBySessionId: 'opened' as SessionId }),
      session('unrelated'),
    ];

    expect(collectSessionContainmentIds('root' as SessionId, sessions)).toEqual(['root', 'tab']);
  });
});
