import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Effect } from 'effect';
import {
  archiveE2eeIdentity,
  leaseE2eeIdentity,
  completedE2eeIdentityReset,
} from '@lody/shared/node/e2ee-identity';
import { cliE2eeIdentityDirectory } from './workspace-legacy';

/** Called only after Fleet drains this workspace. Does not create, admit or
 * activate a replacement. Normal pairing must generate and approve it. */
export const resetCliE2eeIdentity = Effect.fnUntraced(function* (input: {
  accountId: string;
  workspaceId: string;
  resetId: string;
  now: number;
}) {
  const directory = cliE2eeIdentityDirectory(input.accountId, input.workspaceId);
  yield* leaseE2eeIdentity(directory, true);
  yield* Effect.tryPromise({
    try: async () => {
      const selected = await readFile(join(directory, 'custody', 'protection'), 'utf8').catch(
        () => null
      );
      // Unknown/lost protection cannot authorize a weaker selection. An existing
      // explicitly file-protected machine may retain its prior protection class.
      if (selected !== 'file')
        await writeFile(`${directory}.require-os`, 'os-keystore', { mode: 0o600 });
    },
    catch: () => new Error('e2ee_storage'),
  });
  return yield* archiveE2eeIdentity(directory, input.now, input.resetId);
});

/** Receipt lookup does not open custody or stop a subsequently paired identity. */
export const completedCliE2eeIdentityReset = (input: {
  accountId: string;
  workspaceId: string;
  resetId: string;
}) =>
  completedE2eeIdentityReset(
    cliE2eeIdentityDirectory(input.accountId, input.workspaceId),
    input.resetId
  );
