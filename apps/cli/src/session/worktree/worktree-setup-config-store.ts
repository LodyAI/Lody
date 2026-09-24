import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  LocalProjectControlRequest,
  LocalProjectControlResponse,
  LocalProjectId,
  WorktreeCleanupScriptConfig,
  WorktreeScriptPhase,
  WorktreeSetupScriptConfig,
} from '@lody/shared';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';

type LocalProjectWorktreeConfigRequest = Extract<
  LocalProjectControlRequest,
  {
    type:
      | 'local-project/get-worktree-setup'
      | 'local-project/set-worktree-setup'
      | 'local-project/get-worktree-cleanup'
      | 'local-project/set-worktree-cleanup';
  }
>;

const WORKTREE_CONFIG_REQUEST_TYPES = new Set<LocalProjectWorktreeConfigRequest['type']>([
  'local-project/get-worktree-setup',
  'local-project/set-worktree-setup',
  'local-project/get-worktree-cleanup',
  'local-project/set-worktree-cleanup',
]);

function getLocalProjectWorktreeScriptPath(
  localProjectId: LocalProjectId,
  phase: WorktreeScriptPhase
): string {
  return path.join(getLodyDataDir(), 'local-project-setup', localProjectId, `${phase}.json`);
}

export function getLocalProjectWorktreeSetupPath(localProjectId: LocalProjectId): string {
  return getLocalProjectWorktreeScriptPath(localProjectId, 'setup');
}

export function getLocalProjectWorktreeCleanupPath(localProjectId: LocalProjectId): string {
  return getLocalProjectWorktreeScriptPath(localProjectId, 'cleanup');
}

async function readLocalProjectWorktreeScript<
  TConfig extends WorktreeSetupScriptConfig | WorktreeCleanupScriptConfig,
>(localProjectId: LocalProjectId, phase: WorktreeScriptPhase): Promise<TConfig | null> {
  try {
    return JSON.parse(
      await readFile(getLocalProjectWorktreeScriptPath(localProjectId, phase), 'utf8')
    ) as TConfig;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function writeLocalProjectWorktreeScript(
  localProjectId: LocalProjectId,
  phase: WorktreeScriptPhase,
  config: WorktreeSetupScriptConfig | WorktreeCleanupScriptConfig
): Promise<void> {
  const filePath = getLocalProjectWorktreeScriptPath(localProjectId, phase);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

export async function readLocalProjectWorktreeSetup(
  localProjectId: LocalProjectId
): Promise<WorktreeSetupScriptConfig | null> {
  return readLocalProjectWorktreeScript<WorktreeSetupScriptConfig>(localProjectId, 'setup');
}

export async function readLocalProjectWorktreeCleanup(
  localProjectId: LocalProjectId
): Promise<WorktreeCleanupScriptConfig | null> {
  return readLocalProjectWorktreeScript<WorktreeCleanupScriptConfig>(localProjectId, 'cleanup');
}

export async function writeLocalProjectWorktreeSetup(
  localProjectId: LocalProjectId,
  config: WorktreeSetupScriptConfig
): Promise<void> {
  await writeLocalProjectWorktreeScript(localProjectId, 'setup', config);
}

export async function writeLocalProjectWorktreeCleanup(
  localProjectId: LocalProjectId,
  config: WorktreeCleanupScriptConfig
): Promise<void> {
  await writeLocalProjectWorktreeScript(localProjectId, 'cleanup', config);
}

export async function deleteLocalProjectWorktreeSetup(
  localProjectId: LocalProjectId
): Promise<void> {
  await rm(path.dirname(getLocalProjectWorktreeSetupPath(localProjectId)), {
    force: true,
    recursive: true,
  });
}

export function isLocalProjectWorktreeConfigRequest(
  request: LocalProjectControlRequest
): request is LocalProjectWorktreeConfigRequest {
  return WORKTREE_CONFIG_REQUEST_TYPES.has(
    request.type as LocalProjectWorktreeConfigRequest['type']
  );
}

export async function handleLocalProjectWorktreeConfigRequest(
  request: LocalProjectWorktreeConfigRequest
): Promise<LocalProjectControlResponse> {
  if (request.type === 'local-project/get-worktree-setup') {
    return {
      ok: true,
      type: request.type,
      result: await readLocalProjectWorktreeSetup(request.localProjectId),
    };
  }

  if (request.type === 'local-project/set-worktree-setup') {
    await writeLocalProjectWorktreeSetup(request.localProjectId, request.config);
    return {
      ok: true,
      type: request.type,
      result: request.config,
    };
  }

  if (request.type === 'local-project/get-worktree-cleanup') {
    return {
      ok: true,
      type: request.type,
      result: await readLocalProjectWorktreeCleanup(request.localProjectId),
    };
  }

  await writeLocalProjectWorktreeCleanup(request.localProjectId, request.config);
  return {
    ok: true,
    type: request.type,
    result: request.config,
  };
}
