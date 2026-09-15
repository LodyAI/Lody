import { Command } from 'commander';
import path from 'node:path';
import type {
  LocalProjectControlRequest,
  LocalProjectControlResponse,
  LocalProjectId,
  MachineId,
} from '@lody/shared';
import {
  createLocalProjectId,
  ensureLocalProjectRootPath,
  getLocalProjectNameFromRootPath,
} from '@lody/shared/node/local-project';
import {
  getAuthContextOrThrow,
  printJson,
  runOneShotCommand,
  type CommonCommandOptions,
} from '@/lib/command-runtime';
import { appResetCacheCommand } from '@/commands/app-reset-cache';
import { buildOpenLocalProjectDeepLink } from '@/lib/desktop-deep-link';
import {
  extractWorkspaceCandidates,
  promptWorkspaceSelection,
  sendLocalProjectControl,
  type WorkspaceCandidate,
} from '@/lib/local-project-control-client';
import { formatWorkspaceCandidate } from '@/lib/workspace-selector';
import { openBrowser } from '@/utils/open-browser';
import { getLogger } from '@/utils/logger';

type AppCommandOptions = Pick<CommonCommandOptions, 'json' | 'debug' | 'workspace'>;

export type AppLocalProjectTarget = {
  localProjectId: LocalProjectId;
  name: string;
  /**
   * Null when the CLI could not resolve a slug: with a single active workspace
   * the daemon never reports candidates, and the app's current workspace is
   * then the right target anyway.
   */
  workspaceSlug: string | null;
  /** False when the daemon was unreachable and the directory could not be registered. */
  registered: boolean;
};

/**
 * Register the directory as a local project (idempotent — the id is a hash of
 * the resolved root path) and report what the deep link should carry.
 *
 * Registration happens HERE, in a user-invoked local process, and never from the
 * deep link itself: any web page can navigate the OS to `lody://…`, so turning a
 * link-supplied path into a local project would hand agents access to arbitrary
 * directories.
 */
export async function resolveLocalProjectForApp(args: {
  machineId: MachineId;
  rootPath: string;
  workspaceSelector?: string | undefined;
  canPrompt: boolean;
  send: (message: LocalProjectControlRequest) => Promise<LocalProjectControlResponse>;
  promptWorkspace: (candidates: WorkspaceCandidate[]) => Promise<string | null>;
}): Promise<AppLocalProjectTarget> {
  const buildRequest = (workspace?: string): LocalProjectControlRequest => ({
    type: 'local-project/add',
    machineId: args.machineId,
    rootPath: args.rootPath,
    ...(workspace ? { workspace } : {}),
  });

  let response = await args.send(buildRequest(args.workspaceSelector));
  let workspaceSlug: string | null = null;

  if (!response.ok && response.error === 'workspace_required' && args.canPrompt) {
    const candidates = extractWorkspaceCandidates(response);
    if (candidates) {
      const selectedWorkspaceId = await args.promptWorkspace(candidates);
      if (!selectedWorkspaceId) {
        throw new Error('Workspace selection is required to open a local project.');
      }
      workspaceSlug = candidates.find((c) => c.id === selectedWorkspaceId)?.slug ?? null;
      response = await args.send(buildRequest(selectedWorkspaceId));
    }
  }

  if (!response.ok) {
    if (response.error === 'daemon_unavailable') {
      // The desktop app starts its own CLI worker, so still open it: a directory
      // that is already registered stays selectable. A brand new one is not, and
      // the caller warns about that.
      return {
        localProjectId: createLocalProjectId(args.rootPath),
        name: getLocalProjectNameFromRootPath(args.rootPath),
        workspaceSlug: null,
        registered: false,
      };
    }

    const candidates = extractWorkspaceCandidates(response);
    if (candidates) {
      throw new Error(
        `${response.message} Pass --workspace <id|slug|name>. Candidates: ${candidates
          .map(formatWorkspaceCandidate)
          .join(', ')}`
      );
    }
    throw new Error(response.message);
  }

  if (response.type !== 'local-project/add') {
    throw new Error(`Unexpected response type: ${response.type}`);
  }

  return {
    localProjectId: response.result.localProjectId,
    name: response.result.name,
    workspaceSlug,
    registered: true,
  };
}

export const appCommand = new Command('app')
  .description(
    'Open the Lody desktop app on a new chat with a local directory selected (registers it if needed)'
  )
  // `lody app reset-cache` wins over the optional path argument, so a directory
  // with that exact name has to be passed as `./reset-cache`.
  //
  // Positional options are REQUIRED here, like on the program: `app` declares
  // `--json`/`--debug` of its own, and without this Commander lets the parent
  // swallow them before the subcommand is reached — `app reset-cache --json`
  // would then print human text. Existing `lody app [path]` spellings, including
  // a trailing `--json`, keep working.
  .enablePositionalOptions()
  .addCommand(appResetCacheCommand)
  .argument('[path]', 'Local project directory to select', '.')
  .option('--workspace <selector>', 'Target workspace id, slug, or name')
  .option('--json', 'Print JSON output')
  .option('-d, --debug', 'Enable debug output')
  .action(async (projectPath: string, options: AppCommandOptions) => {
    await runOneShotCommand('app', options, async () => {
      const logger = getLogger('app');
      const auth = getAuthContextOrThrow('app');
      const rootPath = ensureLocalProjectRootPath(path.resolve(projectPath ?? '.'));

      const target = await resolveLocalProjectForApp({
        machineId: auth.machineId,
        rootPath,
        workspaceSelector: options.workspace,
        canPrompt:
          !options.json && !options.workspace && !!process.stdin.isTTY && !!process.stdout.isTTY,
        send: sendLocalProjectControl,
        promptWorkspace: (candidates) => promptWorkspaceSelection(candidates, 'app'),
      });

      const deepLink = buildOpenLocalProjectDeepLink({
        machineId: auth.machineId,
        localProjectId: target.localProjectId,
        workspaceSlug: target.workspaceSlug,
      });

      try {
        await openBrowser(deepLink);
      } catch (error) {
        throw new Error(
          `Could not hand the link to the operating system. Is the Lody desktop app installed? Open it manually: ${deepLink}`,
          { cause: error }
        );
      }

      if (options.json) {
        printJson({
          ok: true,
          machineId: auth.machineId,
          localProjectId: target.localProjectId,
          name: target.name,
          rootPath,
          registered: target.registered,
          deepLink,
        });
        return;
      }

      if (!target.registered) {
        logger.warn(
          '⚠️  Local CLI daemon is not running, so this directory could not be registered. If it is new, add it from the desktop app after it starts.'
        );
      }
      logger.success(`✅ Opening Lody desktop: ${target.name} (${rootPath})`);
    });
  });
