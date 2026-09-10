import { expect, type Page } from '@playwright/test';

type SeedMap = {
  constructor: new () => SeedMap;
  set: (key: string, value: unknown) => void;
  setContainer: <T>(key: string, value: T) => T;
};

type SeedList = {
  constructor: new () => SeedList;
  pushContainer: <T>(value: T) => T;
};

type SeedRepo = {
  listDoc: () => Promise<
    Array<{
      docId: string;
      meta: Record<string, unknown>;
      exists?: boolean;
      e?: boolean;
      deleted?: boolean;
    }>
  >;
  getDocMeta: (
    docId: string
  ) => Promise<{ meta?: Record<string, unknown>; exists?: boolean } | undefined>;
  upsertDocMeta: (docId: string, patch: Record<string, unknown>) => Promise<void>;
  openPersistedDoc: (docId: string) => Promise<{
    doc: {
      getMap: (name: string) => SeedMap;
      getList: (name: string) => SeedList;
      commit: () => void;
    };
  }>;
  persistDocNow: (docId: string, doc: unknown) => Promise<void>;
};

declare global {
  interface Window {
    repo?: SeedRepo;
  }
}

export const SEEDED_SESSION_ID = '10000000-0000-4000-8000-000000000002';
export const SEEDED_SESSION_TITLE = 'Synthetic session metadata journey';
export const RENAMED_SESSION_TITLE = 'Renamed local session';
export const SEEDED_HISTORY_TEXT = 'Synthetic history retained across archive and restore.';
export const RELATION_TAB_ID = '20000000-0000-4000-8000-000000000002';
export const RELATION_TAB_TITLE = 'Contained tab T';
export const OPENED_SESSION_TITLE = 'Independent opened Session B';
export const OPENED_FROM_TAB_TITLE = 'Opened-from-tab Session C';
export const COLD_ROOT_ID = '30000000-0000-4000-8000-000000000001';
export const COLD_TAB_ID = '30000000-0000-4000-8000-000000000002';
export const COLD_ROOT_TITLE = 'Cold hydration root';
export const COLD_TAB_TITLE = 'Cold hydration empty tab';

export type RelationGraphSeed = {
  rootSessionId: string;
  openedSessionId: string;
  openedFromTabSessionId: string;
};

export class SeededLocalSessionFixture {
  readonly sessionId = SEEDED_SESSION_ID;

  async seed(page: Page): Promise<void> {
    await expect
      .poll(
        async () =>
          await page.evaluate(async () => {
            const repo = window.repo;
            if (!repo) return false;
            return (await repo.listDoc()).some((entry) => entry.docId.startsWith('machine-'));
          }),
        { timeout: 60_000, intervals: [100, 250, 500] }
      )
      .toBe(true);

    await page.evaluate(
      async ({ historyText, sessionId, title }) => {
        const repo = window.repo;
        if (!repo || !window.ipc) throw new Error('Local workspace repo is unavailable');
        const snapshot = (await window.ipc.invoke('localPlatform.getSnapshot')) as {
          userId: string;
        };
        const machine = (await repo.listDoc()).find((entry) => entry.docId.startsWith('machine-'));
        if (!machine) throw new Error('Bundled CLI did not publish a local machine');
        const machineId = String(machine.meta.id ?? machine.docId.slice('machine-'.length));
        const roomId = `session-${sessionId}`;

        const handle = await repo.openPersistedDoc(roomId);
        const session = handle.doc.getMap('session');
        const history = handle.doc.getList('history');
        const MapContainer = session.constructor as new () => typeof session;
        const ListContainer = history.constructor as new () => typeof history;
        session.set('id', sessionId);
        const turn = history.pushContainer(new MapContainer());
        turn.set('id', 'seeded-turn-1');
        turn.set('role', 'user');
        turn.set('timestamp', '2026-01-01T00:00:00.000Z');
        turn.set('status', 'handled');
        turn.set('read', true);
        turn.set('userId', snapshot.userId);
        const items = turn.setContainer('items', new ListContainer());
        const textItem = items.pushContainer(new MapContainer());
        textItem.set('type', 'text');
        textItem.set('text', historyText);
        handle.doc.commit();
        await repo.persistDocNow(roomId, handle.doc);

        // Publish metadata only after the body is durable. Publishing first lets the
        // bundled CLI observe the session and replace the renderer's open replica.
        await repo.upsertDocMeta(roomId, {
          id: sessionId,
          machineId,
          userId: snapshot.userId,
          status: { type: 'idle' },
          isArchived: false,
          isPinned: false,
          createdAt: '2026-01-01T00:00:00.000Z',
          lastMessageAt: 1_767_225_600_000,
          latestUserMsgId: 'seeded-turn-1',
          cliType: 'custom',
          agentType: 'synthetic-e2e',
          agentConfigId: 'synthetic-e2e-agent',
          title,
          titleSource: 'user',
        });
      },
      { historyText: SEEDED_HISTORY_TEXT, sessionId: this.sessionId, title: SEEDED_SESSION_TITLE }
    );
  }

  async seedRelationGraph(page: Page, relationGraph: RelationGraphSeed): Promise<void> {
    await page.evaluate(
      async ({ graph, openedFromTabTitle, openedTitle, tabId, tabTitle }) => {
        const repo = window.repo;
        if (!repo || !window.ipc) throw new Error('Local workspace repo is unavailable');
        const rootEntry = await repo.getDocMeta(`session-${graph.rootSessionId}`);
        const rootMeta = rootEntry?.meta;
        if (!rootMeta) throw new Error('Root Session metadata is unavailable');
        const snapshot = (await window.ipc.invoke('localPlatform.getSnapshot')) as {
          userId: string;
        };
        const roomId = `session-${tabId}`;
        const handle = await repo.openPersistedDoc(roomId);
        handle.doc.getMap('session').set('id', tabId);
        handle.doc.commit();
        await repo.persistDocNow(roomId, handle.doc);
        await repo.upsertDocMeta(roomId, {
          id: tabId,
          machineId: rootMeta.machineId,
          userId: snapshot.userId,
          parentSessionId: graph.rootSessionId,
          status: { type: 'idle' },
          isArchived: false,
          createdAt: '2026-09-10T01:00:00.000Z',
          lastMessageAt: 1_789_000_000_000,
          cliType: rootMeta.cliType,
          agentType: rootMeta.agentType,
          agentConfigId: rootMeta.agentConfigId,
          project: rootMeta.project,
          repoFullName: rootMeta.repoFullName,
          baseBranch: rootMeta.baseBranch,
          branchName: rootMeta.branchName,
          isWorktree: rootMeta.isWorktree,
          title: tabTitle,
          titleSource: 'user',
        });
        await repo.upsertDocMeta(`session-${graph.openedSessionId}`, {
          title: openedTitle,
          titleSource: 'user',
          openedBySessionId: graph.rootSessionId,
        });
        await repo.upsertDocMeta(`session-${graph.openedFromTabSessionId}`, {
          title: openedFromTabTitle,
          titleSource: 'user',
          openedBySessionId: tabId,
          openedByRootSessionId: graph.rootSessionId,
        });
      },
      {
        graph: relationGraph,
        openedFromTabTitle: OPENED_FROM_TAB_TITLE,
        openedTitle: OPENED_SESSION_TITLE,
        tabId: RELATION_TAB_ID,
        tabTitle: RELATION_TAB_TITLE,
      }
    );
  }

  async seedColdHydrationPair(page: Page): Promise<void> {
    await page.evaluate(
      async ({ rootId, rootTitle, tabId, tabTitle }) => {
        const repo = window.repo;
        if (!repo || !window.ipc) throw new Error('Local workspace repo is unavailable');
        const snapshot = (await window.ipc.invoke('localPlatform.getSnapshot')) as {
          userId: string;
        };
        const machine = (await repo.listDoc()).find((entry) => entry.docId.startsWith('machine-'));
        if (!machine) throw new Error('Bundled CLI did not publish a local machine');
        const machineId = String(machine.meta.id ?? machine.docId.slice('machine-'.length));

        for (const sessionId of [rootId, tabId]) {
          const roomId = `session-${sessionId}`;
          const handle = await repo.openPersistedDoc(roomId);
          handle.doc.getMap('session').set('id', sessionId);
          handle.doc.commit();
          await repo.persistDocNow(roomId, handle.doc);
        }
        const base = {
          machineId,
          userId: snapshot.userId,
          status: { type: 'idle' },
          isArchived: false,
          createdAt: '2026-09-10T02:00:00.000Z',
          cliType: 'custom',
          agentType: 'synthetic-e2e',
          agentConfigId: 'synthetic-e2e-agent',
          titleSource: 'user',
        };
        await repo.upsertDocMeta(`session-${rootId}`, {
          ...base,
          id: rootId,
          title: rootTitle,
          lastMessageAt: 1_789_000_100_000,
        });
        await repo.upsertDocMeta(`session-${tabId}`, {
          ...base,
          id: tabId,
          parentSessionId: rootId,
          title: tabTitle,
        });
      },
      {
        rootId: COLD_ROOT_ID,
        rootTitle: COLD_ROOT_TITLE,
        tabId: COLD_TAB_ID,
        tabTitle: COLD_TAB_TITLE,
      }
    );
  }
}
