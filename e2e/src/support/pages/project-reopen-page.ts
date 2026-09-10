import { expect, type Locator, type Page } from '@playwright/test';
import type {
  ProjectReopenFixture,
  ProjectReopenFixtureProject,
} from '../fixtures/project-reopen-fixture.js';

type RegisteredProject = {
  machineId: string;
  localProjectId: string;
  name: string;
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

export class ProjectReopenPage {
  private readonly recordsByRootPath = new Map<string, RegisteredProject>();

  constructor(
    private readonly page: Page,
    private readonly fixture: ProjectReopenFixture
  ) {}

  async addFirstProject(): Promise<void> {
    await this.addProjectThroughProductUi(this.fixture.firstProject);
  }

  async addSecondProjectAfterReopeningPicker(): Promise<void> {
    await this.addProjectThroughProductUi(this.fixture.secondProject);
  }

  async switchToSecondProjectAndReopenFirstFromPicker(): Promise<void> {
    await this.selectProjectFromSidebar(this.fixture.secondProject);
    await this.selectProjectFromPicker(this.fixture.firstProject);
  }

  async tryAddingFirstProjectAgain(): Promise<void> {
    await this.openAddProjectDialog();
    const dialog = this.addProjectDialog();
    await this.navigateDialogTo(this.fixture.firstProject.rootPath);
    await dialog.getByRole('button', { name: /^(Add|添加)$/u }).click();

    await expect(
      this.page.getByText('This folder is already a project in this workspace.', { exact: true })
    ).toBeVisible();
    await expect(dialog).toBeHidden();
    await expect(this.selectedProjectTrigger(this.fixture.firstProject)).toBeVisible();
  }

  async expectCatalogKeepsOriginalRecords(): Promise<void> {
    await expect
      .poll(() => this.readFixtureCatalog(), {
        timeout: 30_000,
        intervals: [100, 250, 500],
      })
      .toHaveLength(2);

    const catalog = await this.readFixtureCatalog();
    for (const project of [this.fixture.firstProject, this.fixture.secondProject]) {
      const original = this.requireRegisteredProject(project);
      const current = catalog.find(
        (entry) => entry.rootPath === project.rootPath || entry.name === project.name
      );
      expect(current, `Catalog is missing ${project.name}`).toEqual(original);
    }
  }

  async expectSidebarAndPickerAgreeOnFirstProject(): Promise<void> {
    for (const project of [this.fixture.firstProject, this.fixture.secondProject]) {
      await expect(this.projectRow(project)).toHaveCount(1);
    }

    await this.openProjectPicker();
    for (const project of [this.fixture.firstProject, this.fixture.secondProject]) {
      await expect(
        this.page.getByRole('menuitem', { name: project.name, exact: true })
      ).toHaveCount(1);
    }
    await this.page.keyboard.press('Escape');

    await this.selectProjectFromSidebar(this.fixture.firstProject);
  }

  private async addProjectThroughProductUi(project: ProjectReopenFixtureProject): Promise<void> {
    await this.openAddProjectDialog();
    const dialog = this.addProjectDialog();
    await this.navigateDialogTo(project.rootPath);
    await expect(dialog.getByText(project.name, { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: /^(Add|添加)$/u }).click();
    await expect(dialog).toBeHidden();

    await expect
      .poll(() => this.findRegisteredProject(project), {
        timeout: 30_000,
        intervals: [100, 250, 500],
      })
      .not.toBeNull();
    const registered = await this.findRegisteredProject(project);
    if (!registered)
      throw new Error(`Added project is missing from the local catalog: ${project.name}`);
    this.recordsByRootPath.set(project.rootPath, registered);
    await expect(this.projectRow(project)).toBeVisible();
  }

  private async selectProjectFromSidebar(project: ProjectReopenFixtureProject): Promise<void> {
    const row = this.projectRow(project);
    await row.click();
    await expect(row).toHaveAttribute('aria-current', 'page');
    await expect(this.selectedProjectTrigger(project)).toBeVisible();
  }

  private async selectProjectFromPicker(project: ProjectReopenFixtureProject): Promise<void> {
    await this.openProjectPicker();
    await this.page.getByRole('menuitem', { name: project.name, exact: true }).click();
    await expect(this.selectedProjectTrigger(project)).toBeVisible();
  }

  private async openAddProjectDialog(): Promise<void> {
    await this.openProjectPicker();
    await this.page.getByRole('menuitem', { name: /^(Add a folder|添加文件夹)$/u }).click();
    await expect(this.addProjectDialog()).toBeVisible();
  }

  private async openProjectPicker(): Promise<void> {
    await this.projectPickerTrigger().click();
    await expect(this.page.getByPlaceholder(/^(Search projects|搜索项目)$/u)).toBeVisible();
  }

  private async navigateDialogTo(rootPath: string): Promise<void> {
    const dialog = this.addProjectDialog();
    const editPath = dialog.getByTitle(/^(Edit path|编辑路径)$/u);
    if (!(await editPath.isVisible())) {
      await dialog.getByText(/^(Your machine|你的机器)$/u).click();
    }
    await expect(editPath).toBeVisible();
    await editPath.click();
    const pathInput = dialog.getByPlaceholder(/^(Type an absolute path|输入绝对路径)$/u);
    await pathInput.fill(rootPath);
    await pathInput.press('Enter');
  }

  private addProjectDialog(): Locator {
    return this.page.getByRole('dialog', { name: /^(Add a folder|添加文件夹)$/u });
  }

  private projectPickerTrigger(): Locator {
    return this.page.getByRole('button', {
      name: /^(Select a project|选择项目|lody-e2e-project-alpha|lody-e2e-project-beta)$/u,
    });
  }

  private selectedProjectTrigger(project: ProjectReopenFixtureProject): Locator {
    return this.page.getByRole('button', { name: project.name, exact: true });
  }

  private projectRow(project: ProjectReopenFixtureProject): Locator {
    const registered = this.requireRegisteredProject(project);
    return this.page.locator(
      `[data-sidebar-project-key="${registered.machineId}:${registered.localProjectId}"]`
    );
  }

  private requireRegisteredProject(project: ProjectReopenFixtureProject): RegisteredProject {
    const registered = this.recordsByRootPath.get(project.rootPath);
    if (!registered) throw new Error(`Project was not added through the UI: ${project.name}`);
    return registered;
  }

  private async findRegisteredProject(
    project: ProjectReopenFixtureProject
  ): Promise<RegisteredProject | null> {
    const catalog = await this.readFixtureCatalog();
    return (
      catalog.find((entry) => entry.rootPath === project.rootPath || entry.name === project.name) ??
      null
    );
  }

  private async readFixtureCatalog(): Promise<RegisteredProject[]> {
    return await this.page.evaluate(
      async ({ names, rootPaths }) => {
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
        const workspace = response.result?.workspaces?.find(
          (entry) => entry.workspaceId === workspaceId
        );
        return (workspace?.projects ?? []).flatMap((project) => {
          if (
            typeof project.localProjectId !== 'string' ||
            typeof project.name !== 'string' ||
            typeof project.rootPath !== 'string' ||
            (!rootPaths.includes(project.rootPath) && !names.includes(project.name))
          ) {
            return [];
          }
          return [
            {
              machineId,
              localProjectId: project.localProjectId,
              name: project.name,
              rootPath: project.rootPath,
            },
          ];
        });
      },
      {
        names: [this.fixture.firstProject.name, this.fixture.secondProject.name],
        rootPaths: [this.fixture.firstProject.rootPath, this.fixture.secondProject.rootPath],
      }
    );
  }
}
