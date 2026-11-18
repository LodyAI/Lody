import { expect, type Page } from '@playwright/test';

const REPO_DB_PREFIX = 'lody-loro-repo-db-';

type AuxiliaryCacheSnapshot = {
  windowId: string | null;
  workspaceId: string | null;
  activeLegacyRepoOpened: boolean;
  legacyHighWaterNamespaceObserved: boolean;
  namespace: string | null;
  repoDbName: string | null;
  highWaterDbOpened: boolean;
  highWaterNamespaceObserved: boolean;
};

export class DesktopWindowCachePage {
  private auxiliaryPage: Page | null = null;

  constructor(private readonly primaryPage: Page) {}

  async openAuxiliaryWorkspace(): Promise<void> {
    await this.installCacheObserverForFutureRenderers();
    const auxiliaryPagePromise = this.primaryPage.context().waitForEvent('page');
    await this.primaryPage.evaluate(async () => {
      if (!window.ipc) throw new Error('Electron IPC is unavailable');
      await window.ipc.invoke('app.openWindow', { workspace: 'local' });
    });
    this.auxiliaryPage = await auxiliaryPagePromise;
  }

  async expectAuxiliaryRuntimeCacheIsolation(
    storage:
      | { owner: 'legacy' }
      | {
          owner: 'native';
          readEvidence(): readonly {
            stage: string;
            rendererOwner: string | null;
            head: number;
            proofTx: number;
          }[];
        }
  ): Promise<void> {
    const auxiliaryPage = this.requireAuxiliaryPage();
    await expect(auxiliaryPage.locator('#chat-prompt')).toBeEditable({ timeout: 60_000 });
    if (storage.owner === 'native') {
      await expect.poll(storage.readEvidence, { timeout: 60_000 }).toEqual([
        expect.objectContaining({
          stage: 'native',
          rendererOwner: 'native',
          head: expect.any(Number),
          proofTx: expect.any(Number),
        }),
      ]);
      const proof = storage.readEvidence()[0]!;
      expect(proof.proofTx).toBeGreaterThan(0);
      expect(proof.head).toBeGreaterThanOrEqual(proof.proofTx);
    }

    await expect
      .poll(
        async () => {
          const snapshot = await this.readAuxiliaryCacheSnapshot();
          return (
            snapshot.windowId !== null &&
            (storage.owner === 'native'
              ? !snapshot.activeLegacyRepoOpened
              : snapshot.repoDbName !== null) &&
            snapshot.highWaterDbOpened &&
            snapshot.highWaterNamespaceObserved
          );
        },
        {
          message:
            storage.owner === 'native'
              ? 'auxiliary native reads should use window-scoped progress without a legacy Repo'
              : 'auxiliary Repo and eager-sync high-water state should share one window-scoped namespace',
          timeout: 60_000,
        }
      )
      .toBe(true);

    const snapshot = await this.readAuxiliaryCacheSnapshot();
    expect(snapshot.windowId).not.toBeNull();
    expect(snapshot.namespace).toBeTruthy();
    if (storage.owner === 'legacy') {
      expect(snapshot.repoDbName).toBe(`${REPO_DB_PREFIX}${snapshot.namespace}`);
    } else {
      expect(snapshot.repoDbName).toBeNull();
      expect(snapshot.activeLegacyRepoOpened).toBe(false);
      expect(snapshot.legacyHighWaterNamespaceObserved).toBe(false);
      const primary = await this.primaryPage.evaluate(async () => {
        if (!window.ipc) throw new Error('Electron IPC is unavailable');
        const state = (await window.ipc.invoke('localPlatform.getSnapshot')) as {
          workspace?: { workspaceId?: string };
        };
        return {
          workspaceId: state.workspace?.workspaceId,
          windowId: sessionStorage.getItem('lody:windowId'),
        };
      });
      expect(snapshot.workspaceId).toBe(primary.workspaceId);
      expect(snapshot.windowId).not.toBe(primary.windowId);
      expect(snapshot.namespace).toBe(`${primary.workspaceId}:${snapshot.windowId}`);
      await expect(auxiliaryPage).toHaveURL(/#\/local\/chat(?:\?.*)?$/u);
    }
    expect(snapshot.namespace).toMatch(new RegExp(`:${snapshot.windowId}$`, 'u'));
    expect(snapshot.highWaterNamespaceObserved).toBe(true);
  }

  private async installCacheObserverForFutureRenderers(): Promise<void> {
    await this.primaryPage.context().addInitScript(`
      (() => {
        if (window.__LODY_E2E_CACHE_OBSERVATION__) return;
        const observation = {
          openedDatabaseNames: [],
          highWaterNamespaces: [],
        };
        Object.defineProperty(window, '__LODY_E2E_CACHE_OBSERVATION__', {
          configurable: false,
          value: observation,
        });

        const originalOpen = indexedDB.open.bind(indexedDB);
        Object.defineProperty(indexedDB, 'open', {
          configurable: true,
          value: (name, version) => {
            observation.openedDatabaseNames.push(name);
            return version === undefined ? originalOpen(name) : originalOpen(name, version);
          },
        });

        const originalGetAll = IDBIndex.prototype.getAll;
        Object.defineProperty(IDBIndex.prototype, 'getAll', {
          configurable: true,
          value: function (query, count) {
            if (this.name === 'byWorkspace' && typeof query === 'string') {
              observation.highWaterNamespaces.push(query);
            }
            const args = [];
            if (query !== undefined) args.push(query);
            if (count !== undefined) args.push(count);
            return Reflect.apply(originalGetAll, this, args);
          },
        });
      })();
    `);
  }

  private async readAuxiliaryCacheSnapshot(): Promise<AuxiliaryCacheSnapshot> {
    return await this.requireAuxiliaryPage().evaluate(async () => {
      type CacheObservation = {
        openedDatabaseNames: string[];
        highWaterNamespaces: string[];
      };
      const observedWindow = window as typeof window & {
        __LODY_E2E_CACHE_OBSERVATION__?: CacheObservation;
      };
      const observation = observedWindow.__LODY_E2E_CACHE_OBSERVATION__;
      const windowId = sessionStorage.getItem('lody:windowId');
      if (!window.ipc) throw new Error('Electron IPC is unavailable');
      const state = (await window.ipc.invoke('localPlatform.getSnapshot')) as {
        workspace?: { workspaceId?: string };
      };
      const workspaceId = state.workspace?.workspaceId ?? null;
      const repoDbName =
        windowId === null
          ? null
          : (observation?.openedDatabaseNames.find(
              (name) => name.startsWith('lody-loro-repo-db-') && name.endsWith(`:${windowId}`)
            ) ?? null);
      const namespace = workspaceId && windowId ? `${workspaceId}:${windowId}` : null;
      return {
        windowId,
        workspaceId,
        activeLegacyRepoOpened:
          workspaceId !== null &&
          (observation?.openedDatabaseNames.some(
            (name) =>
              name === `lody-loro-repo-db-${workspaceId}` ||
              name.startsWith(`lody-loro-repo-db-${workspaceId}:`)
          ) ??
            false),
        legacyHighWaterNamespaceObserved:
          workspaceId !== null && (observation?.highWaterNamespaces.includes(workspaceId) ?? false),
        namespace,
        repoDbName,
        highWaterDbOpened:
          observation?.openedDatabaseNames.includes('lody:eager-sync-high-water') ?? false,
        highWaterNamespaceObserved:
          namespace !== null && (observation?.highWaterNamespaces.includes(namespace) ?? false),
      };
    });
  }

  private requireAuxiliaryPage(): Page {
    if (!this.auxiliaryPage) throw new Error('The auxiliary workspace window is not open');
    return this.auxiliaryPage;
  }
}
