import { existsSync } from 'node:fs';
import { expect, type Locator, type Page } from '@playwright/test';
import {
  COLD_ROOT_ID,
  COLD_TAB_ID,
  COLD_TAB_TITLE,
  RELATION_TAB_ID,
  RENAMED_SESSION_TITLE,
  SEEDED_HISTORY_TEXT,
  SEEDED_SESSION_TITLE,
  type SeededLocalSessionFixture,
} from '../fixtures/seeded-local-session.js';
import { isProcessAlive } from '../fixtures/session-fork-fixture.js';
import type { AdditionalWorktreeFork, SessionForkResources } from './session-fork-page.js';

export type SessionRelationLifecycleResources = {
  rootSessionId: string;
  tabSessionId: string;
  openedSessionId: string;
  openedFromTabSessionId: string;
  openedWorktreePath: string;
  openedFromTabWorktreePath: string;
  openedAgentPid: number;
  openedFromTabAgentPid: number;
};

export class SessionManagementPage {
  constructor(
    private readonly page: Page,
    private readonly fixture: SeededLocalSessionFixture
  ) {}

  async enterLocalProduct(): Promise<void> {
    await expect(this.page.locator('#chat-prompt')).toBeEditable({ timeout: 60_000 });
  }

  async seedSession(): Promise<void> {
    await this.fixture.seed(this.page);
    await this.openSessionRoute();
    await expect(this.page.getByText(SEEDED_HISTORY_TEXT, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await this.openHome();
    await expect(this.activeRow(SEEDED_SESSION_TITLE)).toBeVisible({ timeout: 30_000 });
  }

  async renameSession(): Promise<void> {
    await this.openRowMenu(this.activeRow(SEEDED_SESSION_TITLE));
    await this.page.getByRole('menuitem', { name: /^(Rename|重命名)$/u }).click();
    const dialog = this.page.getByRole('dialog', { name: /^(Rename Chat|重命名聊天)$/u });
    await dialog.locator('textarea').fill(RENAMED_SESSION_TITLE);
    await dialog.getByRole('button', { name: /^(Save|保存)$/u }).click();
    await expect(this.activeRow(RENAMED_SESSION_TITLE)).toBeVisible();
  }

  async pinSession(): Promise<void> {
    await this.openRowMenu(this.activeRow(RENAMED_SESSION_TITLE));
    await this.page.getByRole('menuitem', { name: /^(Pin Session|置顶会话)$/u }).click();
    await expect(this.page.getByText(/^(Pinned|已置顶)$/u, { exact: true }).first()).toBeVisible();
    await this.openRowMenu(this.activeRow(RENAMED_SESSION_TITLE));
    await expect(
      this.page.getByRole('menuitem', { name: /^(Unpin Session|取消置顶会话)$/u })
    ).toBeVisible();
    await this.page.keyboard.press('Escape');
  }

  async expectMetadataAfterNavigation(): Promise<void> {
    await this.openSessionRoute();
    await expect(this.page.getByText(SEEDED_HISTORY_TEXT, { exact: true })).toBeVisible();
    await this.openHome();
    await expect(this.activeRow(RENAMED_SESSION_TITLE)).toBeVisible();
    await this.openRowMenu(this.activeRow(RENAMED_SESSION_TITLE));
    await expect(
      this.page.getByRole('menuitem', { name: /^(Unpin Session|取消置顶会话)$/u })
    ).toBeVisible();
    await this.page.keyboard.press('Escape');
  }

  async archiveAndRestore(): Promise<void> {
    await this.openRowMenu(this.activeRow(RENAMED_SESSION_TITLE));
    await this.page.getByRole('menuitem', { name: /^(Archive Session|归档会话)$/u }).click();
    await expect(this.activeRow(RENAMED_SESSION_TITLE)).toBeHidden();
    await this.openArchive();
    const archived = this.archivedRow();
    await expect(archived).toContainText(RENAMED_SESSION_TITLE);
    await archived.hover();
    await this.page.getByRole('button', { name: /^(Restore session|恢复会话)$/u }).click();
    await expect(archived).toBeHidden();
  }

  async expectRestoredState(): Promise<void> {
    await expect(this.activeRow(RENAMED_SESSION_TITLE)).toBeVisible();
    await this.openRowMenu(this.activeRow(RENAMED_SESSION_TITLE));
    await expect(
      this.page.getByRole('menuitem', { name: /^(Unpin Session|取消置顶会话)$/u })
    ).toBeVisible();
    await this.page.keyboard.press('Escape');
    await this.activeRow(RENAMED_SESSION_TITLE).click();
    await expect(this.page).toHaveURL(this.sessionRoutePattern());
    await expect(this.page.getByText(SEEDED_HISTORY_TEXT, { exact: true })).toBeVisible();
  }

  async permanentlyDelete(): Promise<void> {
    await this.openRowMenu(this.activeRow(RENAMED_SESSION_TITLE));
    await this.page.getByRole('menuitem', { name: /^(Archive Session|归档会话)$/u }).click();
    await this.openArchive();
    const archived = this.archivedRow();
    await expect(archived).toBeVisible();
    await archived.hover();
    await this.page.getByRole('button', { name: /^(Delete permanently|永久删除)$/u }).click();
    const dialog = this.page.getByRole('dialog', {
      name: /^(Delete permanently\?|确认永久删除？)$/u,
    });
    await dialog.getByRole('button', { name: /^(Delete|删除)$/u }).click();
    await expect(archived).toBeHidden({ timeout: 30_000 });
  }

  async expectDeletedFromListAndRoute(): Promise<void> {
    await expect(
      this.page.locator(`[data-sidebar-session-id="${this.fixture.sessionId}"]`)
    ).toHaveCount(0);
    await this.openSessionRoute();
    await expect(
      this.page.getByRole('heading', { name: /^(Session Not Found|未找到会话)$/u })
    ).toBeVisible({ timeout: 30_000 });
  }

  async seedRelationLifecycle(
    firstFork: SessionForkResources,
    secondFork: AdditionalWorktreeFork
  ): Promise<SessionRelationLifecycleResources> {
    const resources = {
      rootSessionId: firstFork.sourceSessionId,
      tabSessionId: RELATION_TAB_ID,
      openedSessionId: firstFork.targetSessionId,
      openedFromTabSessionId: secondFork.targetSessionId,
      openedWorktreePath: firstFork.targetWorktreePath,
      openedFromTabWorktreePath: secondFork.targetWorktreePath,
      openedAgentPid: firstFork.targetAgentPid,
      openedFromTabAgentPid: secondFork.targetAgentPid,
    };
    await this.fixture.seedRelationGraph(this.page, resources);
    await this.openHome();
    for (const sessionId of [
      resources.rootSessionId,
      resources.openedSessionId,
      resources.openedFromTabSessionId,
    ]) {
      await expect(this.activeRowById(sessionId)).toBeVisible({ timeout: 30_000 });
    }
    return resources;
  }

  async archiveRelationRoot(resources: SessionRelationLifecycleResources): Promise<void> {
    await this.openRowMenu(this.activeRowById(resources.rootSessionId));
    await this.page.getByRole('menuitem', { name: /^(Archive Session|归档会话)$/u }).click();
    await expect(this.activeRowById(resources.rootSessionId)).toBeHidden({ timeout: 30_000 });
    await expect(this.activeRowById(resources.openedSessionId)).toBeVisible();
    await expect(this.activeRowById(resources.openedFromTabSessionId)).toBeVisible();
    await expect
      .poll(() => this.readArchiveStates(resources), {
        timeout: 30_000,
        intervals: [50, 100, 250, 500],
      })
      .toEqual({ root: true, tab: true, opened: false, openedFromTab: false });
  }

  async permanentlyDeleteRelationRoot(resources: SessionRelationLifecycleResources): Promise<void> {
    await this.openArchive();
    const archived = this.page.locator(`[data-id="archive-session:${resources.rootSessionId}"]`);
    await expect(archived).toBeVisible();
    await archived.hover();
    await this.page.getByRole('button', { name: /^(Delete permanently|永久删除)$/u }).click();
    const dialog = this.page.getByRole('dialog', {
      name: /^(Delete permanently\?|确认永久删除？)$/u,
    });
    await dialog.getByRole('button', { name: /^(Delete|删除)$/u }).click();
    await expect(archived).toBeHidden({ timeout: 30_000 });
    await expect
      .poll(() => this.readExistingSessionIds(resources), {
        timeout: 30_000,
        intervals: [50, 100, 250, 500],
      })
      .toEqual([resources.openedFromTabSessionId, resources.openedSessionId].sort());

    expect(existsSync(resources.openedWorktreePath)).toBe(true);
    expect(existsSync(resources.openedFromTabWorktreePath)).toBe(true);
    expect(isProcessAlive(resources.openedAgentPid)).toBe(true);
    expect(isProcessAlive(resources.openedFromTabAgentPid)).toBe(true);
  }

  async expectDanglingProvenanceAndCleanup(
    resources: SessionRelationLifecycleResources
  ): Promise<void> {
    for (const sessionId of [resources.openedSessionId, resources.openedFromTabSessionId]) {
      await this.openSessionRouteById(sessionId);
      const relation = this.page.locator('[data-session-relation-card="opened-by"]');
      await expect(relation).toContainText('Deleted session', { timeout: 30_000 });
      const back = relation.getByRole('button', { name: /^(Back to session|返回会话)$/u });
      await expect(back).toBeDisabled();
      await expect(this.page).toHaveURL(this.sessionRoutePatternFor(sessionId));
    }

    for (const sessionId of [resources.openedSessionId, resources.openedFromTabSessionId]) {
      await this.archiveAndDeleteByRoute(sessionId);
    }
    await expect
      .poll(
        () => ({
          openedWorktree: existsSync(resources.openedWorktreePath),
          openedFromTabWorktree: existsSync(resources.openedFromTabWorktreePath),
          openedAgent: isProcessAlive(resources.openedAgentPid),
          openedFromTabAgent: isProcessAlive(resources.openedFromTabAgentPid),
        }),
        { timeout: 60_000, intervals: [50, 100, 250, 500, 1_000] }
      )
      .toEqual({
        openedWorktree: false,
        openedFromTabWorktree: false,
        openedAgent: false,
        openedFromTabAgent: false,
      });
  }

  async expectColdHydrationExactDelete(): Promise<void> {
    await this.fixture.seedColdHydrationPair(this.page);
    await this.openSessionRouteById(COLD_ROOT_ID, COLD_TAB_ID);
    await expect(this.page.getByRole('tab', { name: COLD_TAB_TITLE })).toBeVisible({
      timeout: 30_000,
    });

    await this.installMetadataScanBarrier();
    await this.page.reload({ waitUntil: 'domcontentloaded' });
    let released = false;
    try {
      await expect
        .poll(
          () =>
            this.page.evaluate(
              () =>
                (
                  window as typeof window & {
                    __LODY_E2E_META_SCAN_GATE__?: { blockedScans: number };
                  }
                ).__LODY_E2E_META_SCAN_GATE__?.blockedScans ?? 0
            ),
          { timeout: 60_000, intervals: [50, 100, 250, 500] }
        )
        .toBeGreaterThanOrEqual(2);
      await this.page.evaluate(
        async ({ rootId, tabId }) => {
          const repo = window.repo;
          if (!repo) throw new Error('Renderer workspace repo is unavailable');
          await repo.upsertDocMeta(`session-${rootId}`, { lastReadAt: 1 });
          await repo.upsertDocMeta(`session-${tabId}`, { lastReadAt: 1 });
        },
        { rootId: COLD_ROOT_ID, tabId: COLD_TAB_ID }
      );

      const tab = this.page.locator(`[data-id="session-tab:${COLD_TAB_ID}"]`);
      await expect(tab).toBeVisible({ timeout: 30_000 });
      await tab.hover();
      await tab.getByRole('button', { name: /^(Close|关闭)$/u }).click();
      await expect(tab).toBeHidden({ timeout: 30_000 });
      await expect(
        this.page.getByText(/^(Could not close this tab|无法关闭此标签页)$/u)
      ).toHaveCount(0);

      await this.releaseMetadataScanBarrier();
      released = true;
      await expect
        .poll(
          () =>
            this.page.evaluate(async (tabId) => {
              const repo = window.repo;
              if (!repo) throw new Error('Renderer workspace repo is unavailable');
              return (await repo.listDoc()).some(
                (entry) =>
                  entry.exists !== false &&
                  entry.e !== false &&
                  entry.deleted !== true &&
                  entry.docId === `session-${tabId}`
              );
            }, COLD_TAB_ID),
          { timeout: 30_000, intervals: [50, 100, 250, 500] }
        )
        .toBe(false);
    } finally {
      if (!released && !this.page.isClosed()) await this.releaseMetadataScanBarrier();
    }
  }

  private activeRow(title: string): Locator {
    return this.page
      .locator(`[data-sidebar-session-id="${this.fixture.sessionId}"]`)
      .filter({ hasText: title });
  }

  private activeRowById(sessionId: string): Locator {
    return this.page.locator(`[data-sidebar-session-id="${sessionId}"]`);
  }

  private archivedRow(): Locator {
    return this.page.locator(`[data-id="archive-session:${this.fixture.sessionId}"]`);
  }

  private async openRowMenu(row: Locator): Promise<void> {
    await expect(row).toBeVisible();
    await row.click({ button: 'right' });
  }

  private async openArchive(): Promise<void> {
    await this.page.getByRole('button', { name: 'Archive', exact: true }).click();
    await expect(this.page).toHaveURL(/#\/local\/archive(?:\?.*)?$/u);
  }

  private async openSessionRoute(): Promise<void> {
    await this.page.evaluate((sessionId) => {
      window.location.hash = `/local/sessions/${encodeURIComponent(sessionId)}`;
    }, this.fixture.sessionId);
    await expect(this.page).toHaveURL(this.sessionRoutePattern());
  }

  private async openSessionRouteById(sessionId: string, tabSessionId?: string): Promise<void> {
    await this.page.evaluate(
      ({ id, tabId }) => {
        const query = tabId ? `?tab=${encodeURIComponent(`session:${tabId}`)}` : '';
        window.location.hash = `/local/sessions/${encodeURIComponent(id)}${query}`;
      },
      { id: sessionId, tabId: tabSessionId }
    );
    await expect(this.page).toHaveURL(this.sessionRoutePatternFor(sessionId));
  }

  private async openHome(): Promise<void> {
    await this.page.evaluate(() => {
      window.location.hash = '/local/chat';
    });
    await expect(this.page).toHaveURL(/#\/local\/chat(?:\?.*)?$/u);
  }

  private sessionRoutePattern(): RegExp {
    return new RegExp(`#\\/local\\/sessions\\/${this.fixture.sessionId}(?:\\?.*)?$`, 'u');
  }

  private sessionRoutePatternFor(sessionId: string): RegExp {
    return new RegExp(`#\\/local\\/sessions\\/${sessionId}(?:\\?.*)?$`, 'u');
  }

  private async readArchiveStates(resources: SessionRelationLifecycleResources): Promise<{
    root: boolean;
    tab: boolean;
    opened: boolean;
    openedFromTab: boolean;
  }> {
    return await this.page.evaluate(async (ids) => {
      const repo = window.repo;
      if (!repo) throw new Error('Renderer workspace repo is unavailable');
      const [root, tab, opened, openedFromTab] = await Promise.all([
        repo.getDocMeta(`session-${ids.rootSessionId}`),
        repo.getDocMeta(`session-${ids.tabSessionId}`),
        repo.getDocMeta(`session-${ids.openedSessionId}`),
        repo.getDocMeta(`session-${ids.openedFromTabSessionId}`),
      ]);
      return {
        root: Boolean(root?.meta?.isArchived),
        tab: Boolean(tab?.meta?.isArchived),
        opened: Boolean(opened?.meta?.isArchived),
        openedFromTab: Boolean(openedFromTab?.meta?.isArchived),
      };
    }, resources);
  }

  private async readExistingSessionIds(
    resources: SessionRelationLifecycleResources
  ): Promise<string[]> {
    const targetIds = [
      resources.rootSessionId,
      resources.tabSessionId,
      resources.openedSessionId,
      resources.openedFromTabSessionId,
    ];
    return await this.page.evaluate(async (ids) => {
      const repo = window.repo;
      if (!repo) throw new Error('Renderer workspace repo is unavailable');
      const target = new Set(ids);
      return (await repo.listDoc())
        .filter(
          (entry) =>
            entry.exists !== false &&
            entry.e !== false &&
            entry.deleted !== true &&
            entry.docId.startsWith('session-')
        )
        .map((entry) => entry.docId.slice('session-'.length))
        .filter((id) => target.has(id))
        .sort();
    }, targetIds);
  }

  private async archiveAndDeleteByRoute(sessionId: string): Promise<void> {
    await this.openSessionRouteById(sessionId);
    await this.page
      .getByRole('button', { name: /^(More actions|更多操作)$/u })
      .last()
      .click();
    await this.page.getByRole('menuitem', { name: /^(Archive session|归档会话)$/u }).click();
    await expect(this.page).toHaveURL(/#\/local\/chat(?:\?.*)?$/u, { timeout: 30_000 });
    await this.openSessionRouteById(sessionId);
    await this.page
      .getByRole('button', { name: /^(More actions|更多操作)$/u })
      .last()
      .click();
    await this.page.getByRole('menuitem', { name: /^(Delete permanently|永久删除)$/u }).click();
    const dialog = this.page.getByRole('dialog', {
      name: /^(Delete permanently\?|确认永久删除？)$/u,
    });
    await dialog.getByRole('button', { name: /^(Delete permanently|永久删除)$/u }).click();
    await expect(this.page).toHaveURL(/#\/local\/chat(?:\?.*)?$/u, { timeout: 30_000 });
  }

  private async installMetadataScanBarrier(): Promise<void> {
    await this.page.addInitScript(`
      (() => {
        let releaseGate = () => {};
        const gate = new Promise((resolve) => {
          releaseGate = resolve;
        });
        const control = {
          blockedScans: 0,
          released: false,
          release: () => {
            control.released = true;
            releaseGate();
          },
        };
        let repoValue;
        Object.defineProperty(window, 'repo', {
          configurable: true,
          get: () => repoValue,
          set: (repo) => {
            const scanner = repo && repo.getMeta ? repo.getMeta() : null;
            if (scanner) {
              const originalScan = scanner.scan.bind(scanner);
              scanner.scan = (...args) => {
                const prefix = args[0] && args[0].prefix;
                const isFullMetadataScan =
                  Array.isArray(prefix) &&
                  prefix.length === 1 &&
                  (prefix[0] === 'm' || prefix[0] === 'e');
                if (!isFullMetadataScan || control.released) return originalScan(...args);
                control.blockedScans += 1;
                return gate.then(() => originalScan(...args));
              };
            }
            repoValue = repo;
          },
        });
        window.__LODY_E2E_META_SCAN_GATE__ = control;
      })();
    `);
  }

  private async releaseMetadataScanBarrier(): Promise<void> {
    await this.page.evaluate(() => {
      (
        window as typeof window & {
          __LODY_E2E_META_SCAN_GATE__?: { release: () => void };
        }
      ).__LODY_E2E_META_SCAN_GATE__?.release();
    });
  }
}
