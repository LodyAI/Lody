import { expect, type Locator, type Page } from '@playwright/test';
import type { WorkSessionFixture } from '../fixtures/work-session-fixture.js';

type RegisteredProject = {
  machineId: string;
  localProjectId: string;
  rootPath: string;
};

type ProjectCatalogResponse = {
  ok?: boolean;
  result?: {
    workspaces?: Array<{
      workspaceId?: string;
      projects?: Array<{
        localProjectId?: string;
        name?: string;
        rootPath?: string;
      }>;
    }>;
  };
};

export class ProjectLifecyclePage {
  private registeredProject: RegisteredProject | null = null;

  constructor(
    private readonly page: Page,
    private readonly fixture: WorkSessionFixture
  ) {}

  async addProjectThroughProductUi(): Promise<void> {
    await this.page.getByRole('button', { name: /^(Select a project|选择项目)$/u }).click();
    await this.page.getByRole('menuitem', { name: /^(Add a folder|添加文件夹)$/u }).click();

    const dialog = this.page.getByRole('dialog', { name: /^(Add a folder|添加文件夹)$/u });
    await expect(dialog).toBeVisible();
    const editPath = dialog.getByTitle(/^(Edit path|编辑路径)$/u);
    if (!(await editPath.isVisible())) {
      await dialog.getByText(/^(Your machine|你的机器)$/u).click();
    }
    await expect(editPath).toBeVisible();
    await editPath.click();
    const pathInput = dialog.getByPlaceholder(/^(Type an absolute path|输入绝对路径)$/u);
    await pathInput.fill(this.fixture.projectRoot);
    await pathInput.press('Enter');

    await expect(dialog.getByText(this.fixture.projectName, { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: /^(Add|添加)$/u }).click();
    await expect(dialog).toBeHidden();

    await expect
      .poll(() => this.findRegisteredProject(), {
        timeout: 30_000,
        intervals: [100, 250, 500],
      })
      .not.toBeNull();
    this.registeredProject = await this.findRegisteredProject();
    if (!this.registeredProject) throw new Error('Added project is missing from the local catalog');
    await expect(this.projectRow()).toHaveCount(0);
  }

  async selectProjectFromPicker(): Promise<void> {
    await this.page.getByRole('button', { name: this.fixture.projectName, exact: true }).click();
    await this.page
      .getByRole('menuitemradio', { name: this.fixture.projectName, exact: true })
      .click();
    await expect(
      this.page.getByRole('button', { name: this.fixture.projectName, exact: true })
    ).toBeVisible();
  }

  async removeProjectAfterReviewingDirectorySafety(): Promise<void> {
    await this.page.getByRole('button', { name: /^(Settings|设置)$/u, exact: true }).click();
    const settings = this.page.getByRole('dialog').filter({
      has: this.page.getByRole('navigation', { name: /^(Settings|设置)$/u }),
    });
    await settings.getByRole('button', { name: /^(Projects|项目)$/u, exact: true }).click();
    await settings
      .getByRole('button')
      .filter({ has: this.page.getByText(this.fixture.projectName, { exact: true }) })
      .click();
    const dialog = this.page.getByRole('dialog', { name: this.fixture.projectName, exact: true });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText(
        /^(Lody never deletes the original project folder or its files\.|Lody 永远不会删除原项目目录或其中的文件。)$/u
      )
    ).toBeVisible();
    const originalPath = this.requireRegisteredProject().rootPath;
    await expect(dialog.getByTitle(originalPath, { exact: true })).toHaveText(originalPath);
    await dialog.getByRole('button', { name: /^(Delete project|删除项目)$/u }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await this.page.keyboard.press('Escape');
    await expect(settings).toBeHidden();
  }

  async expectProjectAbsentFromCatalogAndSelector(): Promise<void> {
    await expect
      .poll(() => this.findRegisteredProject(), {
        timeout: 30_000,
        intervals: [100, 250, 500],
      })
      .toBeNull();
    await expect(this.projectRow()).toHaveCount(0);

    await this.page.getByRole('button', { name: /^(Select a project|选择项目)$/u }).click();
    await this.page
      .getByPlaceholder(/^(Search projects|搜索项目)$/u)
      .fill(this.fixture.projectName);
    await expect(
      this.page.getByRole('menuitemradio', { name: this.fixture.projectName, exact: true })
    ).toHaveCount(0);
    await expect(this.page.getByText(/^(No projects found|没有找到项目)$/u)).toBeVisible();
  }

  private projectRow(): Locator {
    const project = this.requireRegisteredProject();
    return this.page.locator(
      `[data-sidebar-project-key="${project.machineId}:${project.localProjectId}"]`
    );
  }

  private requireRegisteredProject(): RegisteredProject {
    if (!this.registeredProject) throw new Error('The project has not been added through the UI');
    return this.registeredProject;
  }

  private async findRegisteredProject(): Promise<RegisteredProject | null> {
    return await this.page.evaluate(
      async ({ projectName, rootPath }) => {
        if (!window.ipc) throw new Error('Electron IPC is unavailable');
        const [cliState, platform] = (await Promise.all([
          window.ipc.invoke('cli.getState'),
          window.ipc.invoke('localPlatform.getSnapshot'),
        ])) as [
          { runtime?: { machineId?: unknown } } | null,
          { workspace?: { workspaceId?: unknown } } | null,
        ];
        const machineId = cliState?.runtime?.machineId;
        const workspaceId = platform?.workspace?.workspaceId;
        if (typeof machineId !== 'string' || typeof workspaceId !== 'string') {
          throw new Error('Local runtime identity is not ready');
        }

        const response = (await window.ipc.invoke('localProjects.control', {
          type: 'local-project/list',
          machineId,
        })) as ProjectCatalogResponse;
        if (response.ok !== true) throw new Error('Could not read the local project catalog');
        for (const workspace of response.result?.workspaces ?? []) {
          if (workspace.workspaceId !== workspaceId) continue;
          const project = workspace.projects?.find(
            (entry) => entry.name === projectName || entry.rootPath === rootPath
          );
          if (typeof project?.localProjectId === 'string' && typeof project.rootPath === 'string') {
            return {
              machineId,
              localProjectId: project.localProjectId,
              rootPath: project.rootPath,
            };
          }
        }
        return null;
      },
      { projectName: this.fixture.projectName, rootPath: this.fixture.projectRoot }
    );
  }
}
