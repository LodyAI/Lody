import { machineMeta } from '../create-session';
import {
  fileDiff,
  listDir,
  listSessionDir,
  readFile,
  turnDiff,
  workspaceChanges,
} from '../files';
import { itemDetail } from '../session';
import { machineFor, type RuntimeContext } from './context.ts';

const boxed = (value: unknown) => (value === undefined ? undefined : { value });

export function registerContent(ctx: RuntimeContext) {
  const { channel, state } = ctx;
  channel.handle('itemDetail', async (args) => {
    const detail = await itemDetail(args);
    return {
      ...detail,
      rawInput: boxed(detail.rawInput),
      rawOutput: boxed(detail.rawOutput),
      options: Array.isArray(detail.options) ? detail.options : undefined,
      outcome: boxed(detail.outcome),
    };
  });
  channel.handle('turnDiff', (args) =>
    turnDiff(machineFor(ctx, args.sessionId, args.path), args),
  );
  channel.handle('workspaceChanges', (args) =>
    workspaceChanges(machineFor(ctx, args.sessionId, '/'), args),
  );
  channel.handle('fileDiff', (args) =>
    fileDiff(machineFor(ctx, args.sessionId, args.path), args),
  );
  channel.handle('readFile', (args) =>
    readFile(machineFor(ctx, args.sessionId, args.path), args),
  );
  channel.handle('listDir', async (args) => {
    if (args.workspaceId !== state.workspace)
      throw new Error('metadata_not_ready');
    const files = machineFor(ctx, args.sessionId, args.relativePath);
    // The session's own folder (its worktree) when the machine can list it, so the
    // list matches what readFile opens; older machines list the project folder.
    if (listsSessionFolders(state, files.machineId)) {
      const listing = await listSessionDir(files, {
        sessionId: args.sessionId,
        relativePath: args.relativePath,
      });
      if (listing) return listing;
    }
    if (!files.localProjectId) throw new Error('project_unavailable');
    return listDir(files, {
      localProjectId: files.localProjectId,
      relativePath: args.relativePath,
      userId: args.userId,
    });
  });
}

/** Machine meta `protocolCapabilities.sessionDirectoryListing` >= 1; missing means unsupported. */
export function listsSessionFolders(
  state: RuntimeContext['state'],
  machineId: string,
): boolean {
  const flock = state.metaReplica?.flock;
  if (!flock) return false;
  const capabilities = machineMeta(flock, machineId).protocolCapabilities;
  if (!capabilities || typeof capabilities !== 'object') return false;
  return (
    Number((capabilities as Record<string, unknown>).sessionDirectoryListing) >=
    1
  );
}
