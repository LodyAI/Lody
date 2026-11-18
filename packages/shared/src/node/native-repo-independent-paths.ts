import { createHash } from 'node:crypto';
import path from 'node:path';

/** Trusted Node composition only. Calling this does not admit or migrate a profile. */
export function resolveLocalIndependentRepo(options: {
  platform: 'local';
  accountId: string;
  workspaceId: string;
  dataRoot: string;
}): { directory: string; dataDir: string; binding: string; classicDirectory: string } {
  if (
    options.platform !== 'local' ||
    !options.accountId.startsWith('local:') ||
    !options.workspaceId.startsWith('lw_') ||
    !path.isAbsolute(options.dataRoot)
  )
    throw new Error('Independent native Repo requires a local plaintext installation binding');
  const dataRoot = path.resolve(options.dataRoot);
  const binding = JSON.stringify([
    'lody-native-repo-independent',
    1,
    options.platform,
    dataRoot,
    options.accountId,
    options.workspaceId,
    'plaintext',
  ]);
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const directory = path.join(dataRoot, 'native-repo', 'independent', 'v1', hash(binding));
  return {
    directory,
    dataDir: path.join(directory, 'engine'),
    binding,
    // Consumers must reject classic admission before first selecting independent mode.
    classicDirectory: path.join(
      dataRoot,
      'native-repo',
      'v1',
      hash(JSON.stringify([options.accountId, options.workspaceId]))
    ),
  };
}
