import { expect, type Page } from '@playwright/test';

const REPO_DB_PREFIX = 'lody-loro-repo-db-';

type AuxiliaryCacheSnapshot = {
  windowId: string | null;
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

  async expectAuxiliaryRuntimeCacheIsolation(): Promise<void> {
    const auxiliaryPage = this.requireAuxiliaryPage();
    await expect(auxiliaryPage.locator('#chat-prompt')).toBeEditable({ timeout: 60_000 });

    await expect
      .poll(
        async () => {
          const snapshot = await this.readAuxiliaryCacheSnapshot();
          return (
            snapshot.windowId !== null &&
            snapshot.repoDbName !== null &&
            snapshot.highWaterDbOpened &&
            snapshot.highWaterNamespaceObserved
          );
        },
        {
          message:
            'auxiliary Repo and eager-sync high-water state should share one window-scoped namespace',
          timeout: 60_000,
        }
      )
      .toBe(true);

    const snapshot = await this.readAuxiliaryCacheSnapshot();
    expect(snapshot.windowId).not.toBeNull();
    expect(snapshot.namespace).toBeTruthy();
    expect(snapshot.repoDbName).toBe(`${REPO_DB_PREFIX}${snapshot.namespace}`);
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
    return await this.requireAuxiliaryPage().evaluate(() => {
      type CacheObservation = {
        openedDatabaseNames: string[];
        highWaterNamespaces: string[];
      };
      const observedWindow = window as typeof window & {
        __LODY_E2E_CACHE_OBSERVATION__?: CacheObservation;
      };
      const observation = observedWindow.__LODY_E2E_CACHE_OBSERVATION__;
      const windowId = sessionStorage.getItem('lody:windowId');
      const repoDbName =
        windowId === null
          ? null
          : (observation?.openedDatabaseNames.find(
              (name) => name.startsWith('lody-loro-repo-db-') && name.endsWith(`:${windowId}`)
            ) ?? null);
      const namespace = repoDbName?.slice('lody-loro-repo-db-'.length) ?? null;
      return {
        windowId,
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
