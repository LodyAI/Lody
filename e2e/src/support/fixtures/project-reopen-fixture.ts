import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ProjectReopenFixtureProject = {
  name: string;
  rootPath: string;
};

/** Two isolated repositories make a project-switching assertion unambiguous. */
export class ProjectReopenFixture {
  readonly firstProject: ProjectReopenFixtureProject;
  readonly secondProject: ProjectReopenFixtureProject;

  private constructor(readonly tempRoot: string) {
    this.firstProject = {
      name: 'lody-e2e-project-alpha',
      rootPath: join(tempRoot, 'lody-e2e-project-alpha'),
    };
    this.secondProject = {
      name: 'lody-e2e-project-beta',
      rootPath: join(tempRoot, 'lody-e2e-project-beta'),
    };
  }

  static async create(): Promise<ProjectReopenFixture> {
    const tempBase = process.platform === 'win32' ? tmpdir() : '/tmp';
    const fixture = new ProjectReopenFixture(
      mkdtempSync(join(tempBase, 'lody-e2e-project-reopen-'))
    );
    try {
      await Promise.all([
        fixture.createProject(fixture.firstProject),
        fixture.createProject(fixture.secondProject),
      ]);
      return fixture;
    } catch (error) {
      fixture.dispose();
      throw error;
    }
  }

  dispose(): void {
    rmSync(this.tempRoot, { recursive: true, force: true });
  }

  private async createProject(project: ProjectReopenFixtureProject): Promise<void> {
    mkdirSync(project.rootPath, { recursive: true });
    writeFileSync(
      join(project.rootPath, 'README.md'),
      `# ${project.name}\n\nSynthetic local project for the Lody desktop E2E suite.\n`,
      'utf8'
    );
    await execFileAsync('git', ['init', '--initial-branch=e2e-project-reopen', project.rootPath]);
    await execFileAsync('git', ['-C', project.rootPath, 'add', 'README.md']);
    await execFileAsync('git', [
      '-C',
      project.rootPath,
      '-c',
      'user.name=Lody E2E',
      '-c',
      'user.email=e2e@lody.invalid',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '-m',
      'test: initialize synthetic local project',
    ]);
  }
}
