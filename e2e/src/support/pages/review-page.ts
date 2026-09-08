import { expect, type Locator, type Page } from '@playwright/test';

type RegisteredLocalProject = {
  machineId: string;
  workspaceId: string;
  workspaceSlug: string;
  localProjectId: string;
  name: string;
  rootPath: string;
};

type LocalProjectAddResponse = {
  ok?: boolean;
  type?: string;
  message?: string;
  result?: {
    localProjectId?: string;
    name?: string;
    rootPath?: string;
  };
};

export class ReviewPage {
  private readonly sidePanel: Locator;

  constructor(private readonly page: Page) {
    this.sidePanel = page.locator('[data-lody-session-tab-region="side-panel"]');
  }

  async registerLocalProject(rootPath: string): Promise<RegisteredLocalProject> {
    const registered = await this.page.evaluate(async (projectRootPath) => {
      if (!window.ipc) throw new Error('Electron IPC is unavailable');
      const [cliStateRaw, platformRaw] = await Promise.all([
        window.ipc.invoke('cli.getState'),
        window.ipc.invoke('localPlatform.getSnapshot'),
      ]);
      const cliState = cliStateRaw as { runtime?: { machineId?: unknown } } | null;
      const platform = platformRaw as {
        workspace?: { workspaceId?: unknown; slug?: unknown };
      } | null;
      const machineId = cliState?.runtime?.machineId;
      const workspaceId = platform?.workspace?.workspaceId;
      const workspaceSlug = platform?.workspace?.slug;
      if (typeof machineId !== 'string' || typeof workspaceId !== 'string') {
        throw new Error('Local runtime identity is not ready');
      }
      const response = (await window.ipc.invoke('localProjects.control', {
        type: 'local-project/add',
        machineId,
        rootPath: projectRootPath,
        workspace: workspaceId,
      })) as LocalProjectAddResponse;
      if (
        response.ok !== true ||
        response.type !== 'local-project/add' ||
        typeof response.result?.localProjectId !== 'string' ||
        typeof response.result.name !== 'string' ||
        typeof response.result.rootPath !== 'string'
      ) {
        throw new Error(response.message ?? 'Failed to register synthetic local project');
      }
      return {
        machineId,
        workspaceId,
        workspaceSlug: typeof workspaceSlug === 'string' ? workspaceSlug : 'local',
        localProjectId: response.result.localProjectId,
        name: response.result.name,
        rootPath: response.result.rootPath,
      };
    }, rootPath);

    await expect
      .poll(
        async () =>
          await this.page.evaluate(async ({ machineId, workspaceId, localProjectId }) => {
            const response = (await window.ipc?.invoke('localProjects.control', {
              type: 'local-project/list',
              machineId,
            })) as
              | {
                  ok?: boolean;
                  result?: {
                    workspaces?: Array<{
                      workspaceId?: string;
                      projects?: Array<{ localProjectId?: string }>;
                    }>;
                  };
                }
              | undefined;
            return (
              response?.ok === true &&
              response.result?.workspaces?.some(
                (workspace) =>
                  workspace.workspaceId === workspaceId &&
                  workspace.projects?.some((project) => project.localProjectId === localProjectId)
              ) === true
            );
          }, registered),
        { timeout: 30_000, intervals: [100, 250, 500] }
      )
      .toBe(true);

    return registered;
  }

  async openSession(workspaceSlug: string, sessionId: string): Promise<void> {
    await this.page.evaluate(
      ({ slug, id }) => {
        window.location.hash = `/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(id)}`;
      },
      { slug: workspaceSlug, id: sessionId }
    );
    await expect(this.page).toHaveURL(
      new RegExp(
        `#/${escapeRegExp(workspaceSlug)}/sessions/${escapeRegExp(sessionId)}(?:\\?.*)?$`,
        'u'
      )
    );
    await expect(this.page.locator('#chat-prompt')).toBeVisible({ timeout: 60_000 });
  }

  async openChangesPanel(expectedPaths: readonly string[]): Promise<void> {
    const showSidebar = this.page.getByRole('button', { name: /^(Show sidebar|显示侧边栏)$/u });
    if (await showSidebar.isVisible()) {
      await showSidebar.click();
      await this.waitForSidebarState(false);
    }

    const existingTab = this.allChangesTabs().first();
    if ((await existingTab.count()) > 0) {
      await existingTab.click();
    } else {
      const emptyStateButton = this.sidePanel.getByRole('button', {
        name: /^(All Changes|全部变更)$/iu,
      });
      if (await emptyStateButton.isVisible()) {
        await emptyStateButton.click();
      } else {
        await this.sidePanel.getByRole('button', { name: /^(Add panel|添加面板)$/u }).click();
        await this.page.getByRole('menuitem', { name: /^(All Changes|全部变更)$/iu }).click();
      }
    }

    await expect(this.activeSidePanelTab()).toContainText(/^(All Changes|全部变更)$/iu);
    for (const path of expectedPaths) {
      await expect(this.changeRow(path)).toBeVisible({ timeout: 60_000 });
    }
  }

  async openChangedFile(path: string, expectedPaths: readonly string[]): Promise<void> {
    await this.openChangesPanel(expectedPaths);
    await this.changeRow(path).click();
    await expect(this.activeSidePanelTab()).toContainText(/^(All Changes|全部变更)$/iu);

    const readyDiffs = this.sidePanel.locator('[data-section-id="diff-viewer"]');
    await expect(readyDiffs).toHaveCount(expectedPaths.length, { timeout: 60_000 });
    const focusedCard = readyDiffs.filter({ has: this.page.getByTitle(path, { exact: true }) });
    await expect(focusedCard).toHaveCount(1);
    await expect(focusedCard).toBeInViewport();
  }

  async hide(): Promise<void> {
    await this.sidePanel.getByRole('button', { name: /^(Hide sidebar|隐藏侧边栏)$/u }).click();
    await this.waitForSidebarState(true);
    await expect(
      this.page.getByRole('button', { name: /^(Show sidebar|显示侧边栏)$/u })
    ).toBeVisible();
  }

  async show(): Promise<void> {
    await this.page.getByRole('button', { name: /^(Show sidebar|显示侧边栏)$/u }).click();
    await this.waitForSidebarState(false);
    await expect(
      this.sidePanel.getByRole('button', { name: /^(Hide sidebar|隐藏侧边栏)$/u })
    ).toBeVisible();
  }

  async closeDiffViewer(): Promise<void> {
    const readyDiffs = this.sidePanel.locator('[data-section-id="diff-viewer"]');
    await expect(readyDiffs.first()).toBeVisible();

    const activeTab = this.activeSidePanelTab();
    await expect(activeTab).toContainText(/^(All Changes|全部变更)$/iu);
    await activeTab
      .getByRole('button', { name: /^(Close All Changes|关闭\s*全部变更)$/iu })
      .click();

    await expect(readyDiffs).toHaveCount(0);
    await expect(this.allChangesTabs()).toHaveCount(1);
  }

  async closeChangesPanel(): Promise<void> {
    await expect(this.sidePanel.locator('[data-section-id="diff-viewer"]')).toHaveCount(0);
    const activeTab = this.activeSidePanelTab();
    await expect(activeTab).toContainText(/^(All Changes|全部变更)$/iu);
    await activeTab
      .getByRole('button', { name: /^(Close All Changes|关闭\s*全部变更)$/iu })
      .click();
    await expect(this.allChangesTabs()).toHaveCount(0);
    await expect(this.sidePanel.locator('[data-id^="change:"]')).toHaveCount(0);
    await expect(this.sidePanel.locator('[data-section-id="diff-viewer"]')).toHaveCount(0);
  }

  private allChangesTabs(): Locator {
    return this.sidePanel.locator('[role="tab"]').filter({ hasText: /^(All Changes|全部变更)$/iu });
  }

  private activeSidePanelTab(): Locator {
    return this.sidePanel.locator('[role="tab"][aria-selected="true"]');
  }

  private changeRow(path: string): Locator {
    return this.sidePanel.getByTitle(path, { exact: true }).locator('xpath=self::button');
  }

  private async waitForSidebarState(hidden: boolean): Promise<void> {
    const animatedPanel = this.sidePanel.locator('xpath=ancestor::*[@aria-hidden][1]');
    await expect(animatedPanel).toHaveAttribute('aria-hidden', String(hidden));
    await animatedPanel.evaluate(async (element) => {
      await Promise.all(
        element.getAnimations({ subtree: true }).map(async (animation) => {
          try {
            await animation.finished;
          } catch {
            // A replacement animation is itself the next observable state.
          }
        })
      );
    });
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
