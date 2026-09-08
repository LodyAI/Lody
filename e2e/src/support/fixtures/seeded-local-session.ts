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
  listDoc: () => Promise<Array<{ docId: string; meta: Record<string, unknown> }>>;
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
}
