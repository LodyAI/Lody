import type { WorkspacesState } from '@lody/platform';

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

const REFUSAL = /\be2ee_(pairing-(?:tampered|expired|used))\b/;
/** Electron IPC carries only the message; restore the typed refusal the UI reads
 * through `accountPairingErrorCode`. Other failures pass through unchanged. */
export async function withAccountPairingCode<A>(call: Promise<A>): Promise<A> {
  try {
    return await call;
  } catch (error) {
    const code = error instanceof Error ? REFUSAL.exec(error.message)?.[1] : undefined;
    if (code && error instanceof Error) Object.assign(error, { code });
    throw error;
  }
}
