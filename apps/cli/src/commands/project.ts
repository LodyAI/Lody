import { Command } from 'commander';
import path from 'node:path';
import inquirer from 'inquirer';
import chalk from 'chalk';
import {
  type LocalProjectControlRequest,
  type LocalProjectControlResponse,
  type LocalProjectId,
  type MachineId,
  type WorkspaceId,
} from '@lody/shared';
import { AuthClient } from '@/lib/auth';
import {
  extractWorkspaceCandidates,
  printWorkspaceCandidates,
  promptWorkspaceSelection,
  sendLocalProjectControl,
} from '@/lib/local-project-control-client';
import { renderTerminalTable } from '@/lib/terminal-table';
import { getLogger, rootLogger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import {
  getAuthContextOrThrow,
  resolveWorkspaceOrThrow,
  runOneShotCommand,
  withWorkspaceManager,
} from '@/lib/command-runtime';
import { getCliPlatformKind } from '@/lib/cli-platform';
import { listRemoteLocalProjects } from '@/lib/remote-local-project-list';

type CommonOptions = {
  json?: boolean;
  debug?: boolean;
};

type AddProjectOptions = CommonOptions & {
  workspace?: string;
  allWorkspaces?: boolean;
};

type ListProjectOptions = CommonOptions & {
  workspace?: string;
  machine?: string;
};

type SelectableProject = {
  workspaceId: WorkspaceId;
  workspaceName: string;
  localProjectId: LocalProjectId;
  name: string;
  rootPath: string;
};

export function shouldUseRemoteProjectCatalog(options: {
  workspace?: string;
  machine?: string;
}): boolean {
  return Boolean(options.workspace?.trim() || options.machine?.trim());
}

function setDebugIfEnabled(options: CommonOptions): void {
  if (options.debug) {
    rootLogger.setDebug(true);
  }
}

function resolveMachineIdOrExit(): MachineId {
  const logger = getLogger('project');
  const authClient = new AuthClient(logger);
  const authInfo = authClient.getAuthInfo();
  if (!authInfo) {
    logger.error('Not logged in. Run `lody login` first.');
    process.exit(1);
  }
  return authInfo.machine.machineId as MachineId;
}

function printProjectControlError(
  action: string,
  response: Extract<LocalProjectControlResponse, { ok: false }>
): void {
  const logger = getLogger('project');
  logger.error(`Failed to ${action}: ${response.message}`);

  if (response.error === 'workspace_required') {
    const candidates = extractWorkspaceCandidates(response);
    if (candidates && candidates.length > 0) {
      printWorkspaceCandidates(candidates, 'project');
    }
  }
}

function buildAddProjectRequest(
  machineId: MachineId,
  rootPath: string,
  options: { workspace?: string; allWorkspaces?: boolean }
): LocalProjectControlRequest {
  return {
    type: 'local-project/add',
    machineId,
    rootPath,
    ...(options.workspace ? { workspace: options.workspace } : {}),
    ...(options.allWorkspaces ? { allWorkspaces: true } : {}),
  };
}

function collectSelectableProjects(
  response: Extract<LocalProjectControlResponse, { ok: true; type: 'local-project/list' }>
): SelectableProject[] {
  for (const workspace of response.result.workspaces) {
    workspace.projects.sort((a, b) => {
      const nameCompare = a.name.localeCompare(b.name);
      if (nameCompare !== 0) {
        return nameCompare;
      }
      return a.rootPath.localeCompare(b.rootPath);
    });
  }

  const projects: SelectableProject[] = response.result.workspaces.flatMap((workspace) =>
    workspace.projects.map((project) => ({
      workspaceId: workspace.workspaceId,
      workspaceName: workspace.workspaceName,
      localProjectId: project.localProjectId,
      name: project.name,
      rootPath: project.rootPath,
    }))
  );

  projects.sort((a, b) => {
    const workspaceCompare = a.workspaceName.localeCompare(b.workspaceName);
    if (workspaceCompare !== 0) {
      return workspaceCompare;
    }
    const nameCompare = a.name.localeCompare(b.name);
    if (nameCompare !== 0) {
      return nameCompare;
    }
    return a.rootPath.localeCompare(b.rootPath);
  });

  return projects;
}

async function promptDeleteProjectsSelection(
  projects: SelectableProject[]
): Promise<SelectableProject[] | null> {
  const logger = getLogger('project');
  const choices = projects.map((project) => {
    return {
      name: `${project.workspaceName} · ${project.name} ${chalk.gray(`(${project.rootPath})`)}`,
      value: project,
    };
  });

  try {
    const answer = await inquirer.prompt([
      {
        type: 'checkbox' as const,
        name: 'selection',
        message: 'Select local projects to delete:',
        choices,
        pageSize: Math.min(choices.length + 2, 12),
        validate: (value: unknown) => {
          if (!Array.isArray(value) || value.length === 0) {
            return 'Select at least one project.';
          }
          return true;
        },
      },
    ]);

    const rawSelection = (answer as { selection?: unknown }).selection;
    if (!Array.isArray(rawSelection)) {
      return null;
    }
    return rawSelection.filter(
      (item): item is SelectableProject =>
        !!item &&
        typeof item === 'object' &&
        typeof (item as SelectableProject).workspaceId === 'string' &&
        typeof (item as SelectableProject).workspaceName === 'string' &&
        typeof (item as SelectableProject).localProjectId === 'string' &&
        typeof (item as SelectableProject).name === 'string' &&
        typeof (item as SelectableProject).rootPath === 'string'
    );
  } catch (error) {
    logger.error(`Project selection aborted: ${formatErrorMessage(error)}`);
    return null;
  }
}

const projectAddCommand = new Command('add')
  .description('Add a local project directory')
  .argument('[path]', 'Local project directory path', '.')
  .option('--workspace <selector>', 'Target workspace id, slug, or name')
  .option('--all-workspaces', 'Apply to all active workspaces')
  .option('--json', 'Output machine-readable JSON')
  .option('-d, --debug', 'enable debug output')
  .action(async (projectPath: string, options: AddProjectOptions) => {
    setDebugIfEnabled(options);

    if (options.workspace && options.allWorkspaces) {
      const logger = getLogger('project');
      logger.error('Cannot use --workspace together with --all-workspaces');
      process.exit(1);
    }

    const machineId = resolveMachineIdOrExit();
    const rootPath = path.resolve(projectPath ?? '.');

    let response = await sendLocalProjectControl(
      buildAddProjectRequest(machineId, rootPath, {
        workspace: options.workspace,
        allWorkspaces: options.allWorkspaces,
      })
    );

    const canPromptForWorkspace =
      !options.json &&
      !options.workspace &&
      !options.allWorkspaces &&
      !!process.stdin.isTTY &&
      !!process.stdout.isTTY;

    if (!response.ok && response.error === 'workspace_required' && canPromptForWorkspace) {
      const candidates = extractWorkspaceCandidates(response);
      if (candidates && candidates.length > 0) {
        const selectedWorkspace = await promptWorkspaceSelection(candidates, 'project');
        if (!selectedWorkspace) {
          process.exit(1);
        }
        response = await sendLocalProjectControl(
          buildAddProjectRequest(machineId, rootPath, { workspace: selectedWorkspace })
        );
      }
    }

    if (options.json) {
      process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
      if (!response.ok) {
        process.exit(1);
      }
      return;
    }

    const logger = getLogger('project');
    if (!response.ok) {
      printProjectControlError('add project', response);
      process.exit(1);
    }
    if (response.type !== 'local-project/add') {
      logger.error(`Unexpected response type: ${response.type}`);
      process.exit(1);
    }

    logger.success(`✅ Added local project: ${response.result.name}`);
  });

const projectDeleteCommand = new Command('delete')
  .description('Delete local projects')
  .option('--json', 'Output machine-readable JSON')
  .option('-d, --debug', 'enable debug output')
  .action(async (options: CommonOptions) => {
    setDebugIfEnabled(options);

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      const logger = getLogger('project');
      logger.error('Interactive terminal required for project delete.');
      process.exit(1);
    }

    const machineId = resolveMachineIdOrExit();
    const listResponse = await sendLocalProjectControl({
      type: 'local-project/list',
      machineId,
    });

    if (!listResponse.ok) {
      if (options.json) {
        process.stdout.write(`${JSON.stringify(listResponse, null, 2)}\n`);
      } else {
        printProjectControlError('list projects', listResponse);
      }
      process.exit(1);
    }
    if (listResponse.type !== 'local-project/list') {
      const logger = getLogger('project');
      logger.error(`Unexpected response type: ${listResponse.type}`);
      process.exit(1);
    }

    const selectableProjects = collectSelectableProjects(listResponse);
    if (selectableProjects.length === 0) {
      const logger = getLogger('project');
      logger.info('No local projects found.');
      return;
    }

    const selectedProjects = await promptDeleteProjectsSelection(selectableProjects);
    if (!selectedProjects) {
      process.exit(1);
    }

    const deleteResults: Array<LocalProjectControlResponse> = [];
    for (const selectedProject of selectedProjects) {
      const deleteResponse = await sendLocalProjectControl({
        type: 'local-project/delete',
        machineId,
        workspaceId: selectedProject.workspaceId,
        localProjectId: selectedProject.localProjectId,
      });
      deleteResults.push(deleteResponse);
    }

    const successResults = deleteResults.filter(
      (
        response
      ): response is Extract<
        LocalProjectControlResponse,
        { ok: true; type: 'local-project/delete' }
      > => response.ok && response.type === 'local-project/delete'
    );
    const failedResults = deleteResults.filter(
      (response): response is Extract<LocalProjectControlResponse, { ok: false }> => !response.ok
    );

    if (options.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: failedResults.length === 0,
            deleted: successResults.map((result) => ({
              workspaceIds: result.result.workspaceIds,
              name: result.result.name,
              rootPath: result.result.rootPath,
            })),
            failed: failedResults.map((result) => ({
              type: result.type,
              error: result.error,
              message: result.message,
            })),
          },
          null,
          2
        )}\n`
      );
      if (failedResults.length > 0) {
        process.exit(1);
      }
      return;
    }

    const logger = getLogger('project');
    if (successResults.length > 0) {
      logger.success(
        `✅ Deleted ${successResults.length} local project${successResults.length > 1 ? 's' : ''}.`
      );
    }

    if (failedResults.length > 0) {
      for (const result of failedResults) {
        printProjectControlError('delete project', result);
      }
      process.exit(1);
    }
  });

const projectListCommand = new Command('list')
  .description('List local projects')
  .option('--workspace <selector>', 'Remote workspace id, slug, or name')
  .option('--machine <selector>', 'Remote machine id or name')
  .option('--json', 'Output machine-readable JSON')
  .option('-d, --debug', 'enable debug output')
  .action(async (options: ListProjectOptions) => {
    setDebugIfEnabled(options);

    const useRemoteCatalog = shouldUseRemoteProjectCatalog(options);
    if (useRemoteCatalog && getCliPlatformKind() === 'local') {
      const message = 'Remote project listing is not available on the local platform.';
      if (options.json) {
        process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
      } else {
        getLogger('project').error(message);
      }
      process.exit(1);
      return;
    }

    if (useRemoteCatalog) {
      await runOneShotCommand('project', options, async () => {
        const auth = getAuthContextOrThrow('project');
        const workspace = await resolveWorkspaceOrThrow(auth, options.workspace);
        const response = await withWorkspaceManager(
          auth,
          workspace,
          'project',
          async (manager) =>
            await listRemoteLocalProjects({
              manager,
              auth,
              workspace,
              machineSelector: options.machine,
            })
        );
        renderProjectListResponse(response, options);
      });
      return;
    }

    const machineId = resolveMachineIdOrExit();
    const response = await sendLocalProjectControl({
      type: 'local-project/list',
      machineId,
    });
    renderProjectListResponse(response, options);
  });

function renderProjectListResponse(
  response: LocalProjectControlResponse,
  options: CommonOptions
): void {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    if (!response.ok) {
      process.exit(1);
    }
    return;
  }

  const logger = getLogger('project');
  if (!response.ok) {
    printProjectControlError('list projects', response);
    process.exit(1);
  }
  if (response.type !== 'local-project/list') {
    logger.error(`Unexpected response type: ${response.type}`);
    process.exit(1);
  }

  const rows = response.result.workspaces
    .flatMap((workspace) =>
      workspace.projects.map((project) => [workspace.workspaceName, project.name, project.rootPath])
    )
    .sort((left, right) => {
      const workspaceCompare = String(left[0]).localeCompare(String(right[0]));
      if (workspaceCompare !== 0) {
        return workspaceCompare;
      }
      const projectCompare = String(left[1]).localeCompare(String(right[1]));
      if (projectCompare !== 0) {
        return projectCompare;
      }
      return String(left[2]).localeCompare(String(right[2]));
    });

  if (rows.length === 0) {
    logger.info('No local projects found.');
    return;
  }

  console.log(
    renderTerminalTable([{ header: 'Workspace' }, { header: 'Project' }, { header: 'Path' }], rows)
  );
}

export const projectCommand = new Command('project')
  .description('Manage local projects')
  .addCommand(projectAddCommand)
  .addCommand(projectDeleteCommand)
  .addCommand(projectListCommand);
