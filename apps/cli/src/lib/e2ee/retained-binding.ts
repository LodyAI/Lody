import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Deliberately free of custody/core imports: ordinary Fleet and command paths
// read this file before deciding whether a workspace may open as plaintext.

export const cliE2eeIdentityDirectory = (accountId: string, workspaceId: string) => {
  if (!accountId || !/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId))
    throw new Error('e2ee_invalid_input');
  return join(
    getLodyDataDir(),
    'e2ee',
    createHash('sha256').update(accountId).digest('hex'),
    workspaceId
  );
};

/** A listed workspace that this machine's retained pairing binding contradicts. */
export class E2eeModeConflictError extends Error {
  constructor(readonly workspaceId: string) {
    super(
      `Workspace ${workspaceId} is encrypted on this machine, but the server described it as unencrypted or with a different identity. Lody refused to open it without encryption; the local encrypted identity is kept.`
    );
    this.name = 'E2eeModeConflictError';
  }
}

/**
 * The binding is written only through the trusted local pairing approval and
 * survives until member removal or an explicit identity reset. While it exists,
 * the server's mode field cannot downgrade this workspace: a listing that is not
 * `e2ee` with the same genesis is refused. Only a missing binding is absence;
 * an unreadable one still counts as encrypted evidence.
 */
export function findRetainedE2eeModeConflict(
  accountId: string,
  workspace: { id: string; contentMode?: string; genesisHash?: string }
): E2eeModeConflictError | null {
  let directory: string;
  try {
    directory = cliE2eeIdentityDirectory(accountId, workspace.id);
  } catch {
    return null; // No identity can be stored for an ID this host cannot name.
  }
  let retainedGenesis: string | null;
  try {
    const descriptor = openSync(
      join(directory, 'binding.json'),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
    );
    try {
      if (fstatSync(descriptor).size > 18_000) throw new Error('e2ee_binding_conflict');
      const parsed: unknown = JSON.parse(readFileSync(descriptor, 'utf8'));
      const genesis =
        typeof parsed === 'object' && parsed !== null && 'genesisHash' in parsed
          ? parsed.genesisHash
          : null;
      retainedGenesis =
        typeof genesis === 'string' && /^[0-9a-f]{64}$/.test(genesis) ? genesis : null;
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    retainedGenesis = null;
  }
  // An unreadable binding cannot name its genesis, so only an encrypted listing
  // may proceed; its opener validates the binding itself and fails closed.
  if (
    workspace.contentMode === 'e2ee' &&
    (retainedGenesis === null || retainedGenesis === workspace.genesisHash)
  )
    return null;
  return new E2eeModeConflictError(workspace.id);
}
