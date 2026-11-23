import { expect, type Page } from '@playwright/test';

type LocalBootstrapState = {
  cli: {
    phase?: string;
    startupStage?: string;
    runtimeOwnership?: string;
    runtime?: { pid?: number };
  } | null;
  snapshot: {
    userId?: string;
    workspace?: { workspaceId?: string; slug?: string | null };
  } | null;
};

// Public identity/receipt format only; no cloud account or credentials are installed.
function retiredIdentityFixture(workspaceId: string) {
  const scope = {
    accountId: 'synthetic-retired-account',
    workspaceId,
    genesisHash: '11'.repeat(32),
    signingPublicKey: '22'.repeat(32),
    windowId: 'synthetic-retired-window',
  };
  const namespace = `e2ee-v1:${JSON.stringify([scope.accountId, workspaceId, scope.genesisHash, scope.signingPublicKey])}:${JSON.stringify(scope.windowId)}`;
  return {
    markerKey: `lody-e2ee-member-cleanup-v2:${namespace}`,
    marker: JSON.stringify(scope),
    database: `lody-loro-repo-db-${namespace}`,
    content: [17, 34, 51],
  };
}

export class OnboardingPage {
  constructor(private readonly page: Page) {}

  async waitForLocalBootstrap(): Promise<LocalBootstrapState> {
    await expect
      .poll(
        async () => {
          return await this.page.evaluate(async () => {
            if (window.__LODY_ELECTRON__ !== true || !window.ipc) return null;
            const [cli, snapshot] = await Promise.all([
              window.ipc.invoke('cli.getState'),
              window.ipc.invoke('localPlatform.getSnapshot'),
            ]);
            return { cli, snapshot };
          });
        },
        { timeout: 120_000, intervals: [100, 250, 500, 1000] }
      )
      .toMatchObject({
        cli: {
          phase: 'running',
          startupStage: 'ready',
          runtimeOwnership: 'owned',
        },
        snapshot: {
          userId: expect.stringMatching(/^local:/u),
          workspace: { workspaceId: expect.stringMatching(/^lw_/u), slug: 'local' },
        },
      });

    return (await this.page.evaluate(async () => {
      const [cli, snapshot] = await Promise.all([
        window.ipc!.invoke('cli.getState'),
        window.ipc!.invoke('localPlatform.getSnapshot'),
      ]);
      return { cli, snapshot };
    })) as LocalBootstrapState;
  }

  async skipConfigurationAndEnterProduct(): Promise<void> {
    await this.openAgentConfiguration();
    await this.page.getByRole('button', { name: /^(Skip for now|稍后再配置)$/u }).click();
    await expect(
      this.page.getByRole('heading', { name: /^(Explore Lody|探索 Lody)$/u })
    ).toBeVisible();
    await this.page.getByRole('button', { name: /^(Enter Lody|进入 Lody)$/u }).click();
    await expect(this.page.locator('#chat-prompt')).toBeVisible({ timeout: 60_000 });
    await expect(this.page).toHaveURL(/#\/local\/chat(?:\?.*)?$/u);
  }

  async retainOtherIdentityCleanup(): Promise<void> {
    const fixture = retiredIdentityFixture(await this.localWorkspaceId());
    await this.page.evaluate(async (retained) => {
      localStorage.setItem(retained.markerKey, retained.marker);
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(retained.database, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('retained-content');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction('retained-content', 'readwrite');
          transaction.objectStore('retained-content').put(retained.content, 'content');
          transaction.oncomplete = () => {
            db.close();
            resolve();
          };
          transaction.onabort = () => {
            db.close();
            reject(transaction.error);
          };
        };
      });
    }, fixture);
  }

  async expectLocalColdStartPreservesOtherIdentity(): Promise<void> {
    const workspaceId = await this.localWorkspaceId();
    const fixture = retiredIdentityFixture(workspaceId);
    await expect(this.page.locator('#chat-prompt')).toBeEditable({ timeout: 60_000 });
    const databases = await this.page.evaluate(async () =>
      (await indexedDB.databases()).map((database) => database.name)
    );
    expect(databases).toContain(`lody-loro-repo-db-${workspaceId}`);
    expect(databases).toContain(fixture.database);
    const retained = await this.page.evaluate(async (previous) => {
      const content = await new Promise<unknown>((resolve, reject) => {
        const request = indexedDB.open(previous.database);
        request.onupgradeneeded = () => request.transaction?.abort();
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const read = db
            .transaction('retained-content')
            .objectStore('retained-content')
            .get('content');
          read.onerror = () => {
            db.close();
            reject(read.error);
          };
          read.onsuccess = () => {
            db.close();
            resolve(read.result);
          };
        };
      });
      return { marker: localStorage.getItem(previous.markerKey), content };
    }, fixture);
    expect(retained).toEqual({ marker: fixture.marker, content: fixture.content });
  }

  private async localWorkspaceId(): Promise<string> {
    const state = await this.waitForLocalBootstrap();
    const workspaceId = state.snapshot?.workspace?.workspaceId;
    if (!workspaceId) throw new Error('Local workspace did not initialize');
    return workspaceId;
  }

  async openAgentConfiguration(): Promise<void> {
    // The intro can finish while local bootstrap is pending. Its final CTA stays
    // available, whereas the transient Skip intro button may already be gone.
    await this.page.getByRole('button', { name: /^(Configure Lody|开始配置)$/u }).click();
    await expect(
      this.page.getByRole('heading', { name: /^(Connect a coding agent|连接一个编码 Agent)$/u })
    ).toBeVisible();
  }
}
