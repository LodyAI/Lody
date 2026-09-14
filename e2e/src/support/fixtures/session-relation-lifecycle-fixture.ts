import type { Page } from '@playwright/test';

type SeedMap = {
  set: (key: string, value: unknown) => void;
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
      commit: () => void;
    };
  }>;
  persistDocNow: (docId: string, doc: unknown) => Promise<void>;
};

declare global {
  interface Window {
    repo?: SeedRepo;
    __LODY_E2E_LIFECYCLE_PUBLISH_FAILURE__?: { attempts: number };
  }
}

const LIFECYCLE_DOC_ID = '_lody/session-lifecycle-operations/v1';
const LIFECYCLE_FIELD_PREFIX = 'operation:';

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

export class SessionRelationLifecycleFixture {
  async failNextLifecyclePublication(page: Page): Promise<void> {
    await page.evaluate(
      ({ docId }) => {
        const repo = window.repo;
        if (!repo) throw new Error('Renderer workspace repo is unavailable');
        const original = repo.upsertDocMeta.bind(repo);
        const control = { attempts: 0 };
        repo.upsertDocMeta = async (targetDocId, patch) => {
          if (targetDocId === docId && control.attempts === 0) {
            control.attempts += 1;
            throw new Error('injected lifecycle publication failure');
          }
          await original(targetDocId, patch);
        };
        window.__LODY_E2E_LIFECYCLE_PUBLISH_FAILURE__ = control;
      },
      { docId: LIFECYCLE_DOC_ID }
    );
  }

  async readLifecycleEvidence(
    page: Page,
    subjectId: string
  ): Promise<{
    operationId: string;
    targetIds: string[];
    state: string;
    journalPublished: boolean;
    replicated: boolean;
    injectedFailures: number;
  } | null> {
    return await page.evaluate(
      async ({ docId, fieldPrefix, subjectId: evaluatedSubjectId }) => {
        const repo = window.repo;
        if (!repo || !window.ipc) throw new Error('Local workspace repo is unavailable');
        const snapshot = (await window.ipc.invoke('localPlatform.getSnapshot')) as {
          workspace: { workspaceId: string };
        };
        const openRequest = indexedDB.open(
          `lody-session-lifecycle-v1:${snapshot.workspace.workspaceId}`
        );
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          openRequest.onsuccess = () => resolve(openRequest.result);
          openRequest.onerror = () => reject(openRequest.error);
        });
        const transaction = database.transaction('admissions', 'readonly');
        const getAllRequest = transaction.objectStore('admissions').getAll();
        const rows = await new Promise<
          Array<{ operationId: string; operationJson: string; published: boolean }>
        >((resolve, reject) => {
          getAllRequest.onsuccess = () => resolve(getAllRequest.result);
          getAllRequest.onerror = () => reject(getAllRequest.error);
        });
        await new Promise<void>((resolve, reject) => {
          transaction.oncomplete = () => resolve();
          transaction.onabort = () => reject(transaction.error);
          transaction.onerror = () => reject(transaction.error);
        });
        database.close();
        const candidates = rows
          .map((row) => ({
            row,
            operation: JSON.parse(row.operationJson) as Record<string, unknown>,
          }))
          .filter(({ operation }) => operation.subjectId === evaluatedSubjectId);
        const admission = candidates.at(-1);
        if (!admission) return null;
        const replicatedRecord = await repo.getDocMeta(docId);
        const replicatedValue =
          replicatedRecord?.meta?.[`${fieldPrefix}${admission.row.operationId}`];
        return {
          operationId: admission.row.operationId,
          targetIds: admission.operation.targetIds as string[],
          state: String(admission.operation.state),
          journalPublished: admission.row.published,
          replicated: typeof replicatedValue === 'string',
          injectedFailures: window.__LODY_E2E_LIFECYCLE_PUBLISH_FAILURE__?.attempts ?? 0,
        };
      },
      { docId: LIFECYCLE_DOC_ID, fieldPrefix: LIFECYCLE_FIELD_PREFIX, subjectId }
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
