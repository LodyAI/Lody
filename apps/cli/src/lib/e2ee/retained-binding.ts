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

/** A retained pairing binding was read and contradicts the listed mode or genesis.
 * Local evidence cannot change by retrying; only a consistent listing clears it. */
export class E2eeModeConflictError extends Error {
  constructor(readonly workspaceId: string) {
    super(
      `Workspace ${workspaceId} is encrypted on this machine, but the server described it as unencrypted or with a different identity. Lody refused to open it without encryption; the local encrypted identity is kept.`
    );
    this.name = 'E2eeModeConflictError';
  }
}

/** The binding could not be read, so this machine cannot tell whether it holds an
 * encrypted identity. Not a verdict: the workspace stays closed to plaintext and the
 * opener retries; the original error stays the cause. */
export class E2eeBindingUnreadableError extends Error {
  readonly code: string | undefined;
  constructor(
    readonly workspaceId: string,
    cause: unknown
  ) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    super(
      `The encrypted pairing binding of workspace ${workspaceId} could not be read${code ? ` (${code})` : ''}. Lody will retry and does not open the workspace without encryption meanwhile.`,
      { cause }
    );
    this.name = 'E2eeBindingUnreadableError';
    this.code = code;
  }
}

export type RetainedModeVerdict =
  | { kind: 'consistent' }
  | { kind: 'conflict'; error: E2eeModeConflictError }
  | { kind: 'unreadable'; error: E2eeBindingUnreadableError };

/**
 * The binding is written only through the trusted local pairing approval and
 * survives until member removal or an explicit identity reset. While it exists,
 * the server's mode field cannot downgrade this workspace. Only a missing binding
 * is absence. A binding that cannot be read or parsed is `unreadable`, never
 * plaintext permission, and never a conflict verdict.
 */
export function classifyRetainedE2eeMode(
  accountId: string,
  workspace: { id: string; contentMode?: string; genesisHash?: string }
): RetainedModeVerdict {
  let directory: string;
  try {
    directory = cliE2eeIdentityDirectory(accountId, workspace.id);
  } catch {
    return { kind: 'consistent' }; // No identity can be stored for an ID this host cannot name.
  }
  let retainedGenesis: string;
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
      if (typeof genesis !== 'string' || !/^[0-9a-f]{64}$/.test(genesis))
        throw new Error('e2ee_binding_invalid');
      retainedGenesis = genesis;
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'consistent' };
    // An encrypted listing proceeds: its opener validates the binding itself and
    // fails closed. Anything else cannot be opened until the binding is readable.
    return workspace.contentMode === 'e2ee'
      ? { kind: 'consistent' }
      : { kind: 'unreadable', error: new E2eeBindingUnreadableError(workspace.id, error) };
  }
  return workspace.contentMode === 'e2ee' && retainedGenesis === workspace.genesisHash
    ? { kind: 'consistent' }
    : { kind: 'conflict', error: new E2eeModeConflictError(workspace.id) };
}

/** Every opener calls this before choosing a data plane. */
export function assertRetainedE2eeModeAllowsOpen(
  accountId: string,
  workspace: { id: string; contentMode?: string; genesisHash?: string }
): void {
  const verdict = classifyRetainedE2eeMode(accountId, workspace);
  if (verdict.kind !== 'consistent') throw verdict.error;
}
