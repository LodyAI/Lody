import type { WorkspacesState } from '@lody/platform';
import { E2EE_PAIRING_REFUSAL_CODES, decodeE2eeIpcError } from '@lody/shared/e2ee-ipc-error';

/** Routing hints for the desktop host: the account's encrypted workspaces as the
 * renderer lists them. The host verifies every genesis itself; names are display only. */
export function accountPairingHints(state: WorkspacesState) {
  if (state.status !== 'ready') return [];
  return state.workspaces.flatMap((workspace) =>
    workspace.contentMode === 'e2ee' && workspace.genesisHash
      ? [{ workspaceId: workspace.id, name: workspace.name, genesisHash: workspace.genesisHash }]
      : []
  );
}

/** Electron IPC carries only the message; restore the typed refusal the UI reads
 * through `accountPairingErrorCode`. Other failures pass through unchanged. */
export async function withAccountPairingCode<A>(call: Promise<A>): Promise<A> {
  try {
    return await call;
  } catch (error) {
    if (error instanceof Error) {
      const decoded = decodeE2eeIpcError(error);
      if (
        decoded &&
        decoded.code !== 'invalid-input' &&
        E2EE_PAIRING_REFUSAL_CODES.has(decoded.code as never)
      ) {
        Object.assign(
          error,
          decoded.kind === 'pairing-code-mismatch' && decoded.attemptsLeft !== undefined
            ? { code: decoded.code, attemptsLeft: decoded.attemptsLeft }
            : { code: decoded.code }
        );
      }
    }
    throw error;
  }
}
