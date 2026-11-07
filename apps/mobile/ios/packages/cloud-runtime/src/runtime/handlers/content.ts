import {
  fileDiff,
  listDir,
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
  channel.handle('listDir', (args) => {
    if (args.workspaceId !== state.workspace)
      throw new Error('metadata_not_ready');
    const files = machineFor(ctx, args.sessionId, args.relativePath);
    if (!files.localProjectId) throw new Error('project_unavailable');
    return listDir(files, {
      localProjectId: files.localProjectId,
      relativePath: args.relativePath,
      userId: args.userId,
    });
  });
}
