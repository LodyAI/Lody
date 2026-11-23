import { describe, expect, it } from 'vitest';
import type { LoroRepo } from 'loro-repo';
import type { SessionId } from '../src/ids';
import type { SessionMeta } from '../src/schema';
import { collectSessionArchiveTargets } from '../src/session-archive-targets';
import { readSessionOperationTargets } from '../src/session-operation-targets';

function session(id: string, relations: Partial<SessionMeta> = {}): SessionMeta {
  return { id: id as SessionId, ...relations } as SessionMeta;
}

function snapshot(sessions: SessionMeta[]): Pick<LoroRepo, 'listDoc'> {
  return {
    listDoc: async () =>
      sessions.map((meta) => ({ docId: `session-${meta.id}`, meta, exists: true })),
  } as Pick<LoroRepo, 'listDoc'>;
}

function mixedTree() {
  const root = session('root');
  const tab = session('tab', { parentSessionId: root.id });
  const opened = session('opened', { openedBySessionId: root.id });
  const openedTab = session('opened-tab', { parentSessionId: opened.id });
  const fromTab = session('from-tab', {
    openedBySessionId: tab.id,
    openedByRootSessionId: root.id,
  });
  const fromTabChild = session('from-tab-child', { parentSessionId: fromTab.id });
  const furtherOpened = session('further-opened', { openedBySessionId: opened.id });
  const routeOnly = session('route-only', { openedByRootSessionId: root.id });
  const foreignTab = session('foreign-tab', {
    parentSessionId: routeOnly.id,
    openedBySessionId: root.id,
  });
  return {
    root,
    tab,
    opened,
    openedTab,
    fromTab,
    fromTabChild,
    furtherOpened,
    routeOnly,
    foreignTab,
  };
}

describe('Session operation target ownership', () => {
  it.each(['archive', 'restore', 'delete'] as const)(
    '%s excludes independently opened Sessions and all of their descendants',
    async (operation) => {
      const tree = mixedTree();
      const repo = snapshot(Object.values(tree));
      expect(await readSessionOperationTargets(repo, tree.root.id, operation)).toEqual([
        tree.root,
        tree.tab,
      ]);
      expect(await readSessionOperationTargets(repo, tree.tab.id, operation)).toEqual([tree.tab]);
      expect(await readSessionOperationTargets(repo, tree.opened.id, operation)).toEqual([
        tree.opened,
        tree.openedTab,
      ]);
    }
  );

  it('archive-tree follows opened Sessions and Tabs downward only', async () => {
    const tree = mixedTree();
    const repo = snapshot(Object.values(tree));
    expect(
      (await readSessionOperationTargets(repo, tree.root.id, 'archive-tree')).map(
        (target) => target.id
      )
    ).toEqual([
      tree.root.id,
      tree.tab.id,
      tree.opened.id,
      tree.fromTab.id,
      tree.openedTab.id,
      tree.furtherOpened.id,
      tree.fromTabChild.id,
    ]);
    // Unlike collaboration, a selected opened Session never pulls in its opener.
    expect(await readSessionOperationTargets(repo, tree.opened.id, 'archive-tree')).toEqual([
      tree.opened,
      tree.openedTab,
      tree.furtherOpened,
    ]);
  });

  it('retains explicit collaboration stop scope through opened Sessions and Tabs', async () => {
    const tree = mixedTree();
    const targets = await readSessionOperationTargets(
      snapshot(Object.values(tree)),
      tree.fromTabChild.id,
      'collaboration'
    );
    expect(targets.map((target) => target.id)).toEqual([
      tree.root.id,
      tree.tab.id,
      tree.opened.id,
      tree.fromTab.id,
      tree.openedTab.id,
      tree.furtherOpened.id,
      tree.fromTabChild.id,
    ]);
  });

  it('deduplicates cyclic legacy containment without traversing opened-by cycles', async () => {
    const root = session('root');
    const tab = session('tab', { parentSessionId: root.id });
    const nested = session('nested', { parentSessionId: tab.id });
    root.parentSessionId = nested.id;
    const opened = session('opened', { openedBySessionId: root.id });
    const child = session('opened-child', { parentSessionId: opened.id });
    root.openedBySessionId = child.id;
    const sessions = [root, tab, nested, opened, child, tab];

    expect(collectSessionArchiveTargets(root.id, sessions)).toEqual([tab, nested]);
    expect(await readSessionOperationTargets(snapshot(sessions), root.id, 'archive')).toEqual([
      root,
      tab,
      nested,
    ]);
    expect(
      (await readSessionOperationTargets(snapshot(sessions), root.id, 'collaboration')).map(
        (target) => target.id
      )
    ).toEqual([tab.id, nested.id, root.id, opened.id, child.id]);
  });
});
