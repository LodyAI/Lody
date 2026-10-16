import os from 'node:os';
import path from 'node:path';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import {
  resolveFilePreviewPath as resolvePath,
  type FilePreviewPathPolicyOptions,
} from '@lody/shared/node/file-preview-path-policy';
export * from '@lody/shared/node/file-preview-path-policy';

const FILE_PREVIEW_EXTRA_ROOTS_ENV_VAR = 'LODY_FILE_PREVIEW_EXTRA_ROOTS';

/**
 * The fixed extra roots, before symlink resolution. Missing directories are fine:
 * `resolveRealPathOrNull` drops them, and a root that cannot be resolved simply
 * grants nothing.
 */
export function getDefaultFilePreviewExtraRoots(
  options: FilePreviewPathPolicyOptions = {}
): readonly string[] {
  const env = options.env ?? process.env;
  const configured = (env[FILE_PREVIEW_EXTRA_ROOTS_ENV_VAR] ?? '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => path.resolve(entry));
  return [
    os.tmpdir(),
    // Chat sessions without a repository run in this directory, so an agent that
    // writes a file "in the working directory" lands here.
    path.join(getLodyDataDir(undefined, options.homeDir), 'chats'),
    ...configured,
  ];
}

export function resolveFilePreviewPath(args: Parameters<typeof resolvePath>[0]) {
  return resolvePath({
    ...args,
    extraRoots: args.extraRoots ?? getDefaultFilePreviewExtraRoots(args.options),
  });
}
