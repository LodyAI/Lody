/** Mutable synchronized metadata supports UI access only, not malicious-member isolation. */
export type SessionAccessRecord = {
  id?: string;
  machineId?: string | null;
  userId?: string | null;
  parentSessionId?: string | null;
  childSessionPlacement?: unknown;
};

/** The sparse default is a Tab; side-panel is the only supported override.
 * Synced relation fields are mutable UI routing data: unknown placements, cross-machine links
 * and nested containment never inherit. Provenance alone is not containment.
 */
export function isContainedSession(
  child: SessionAccessRecord | null | undefined,
  parent: SessionAccessRecord | null | undefined
): boolean {
  return (
    !!child?.id &&
    !!parent?.id &&
    child.id !== parent.id &&
    child.parentSessionId === parent.id &&
    !parent.parentSessionId &&
    !!child.machineId &&
    child.machineId === parent.machineId &&
    (child.childSessionPlacement === undefined || child.childSessionPlacement === 'side-panel')
  );
}

/** Bind an ordinary history editing proof to one exact JSON operation and RPC id. */
export async function sessionHistoryWriteIntentDigest(
  requestId: string,
  operation: string,
  payload: Record<string, unknown>
): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify(['lody-session-history-edit-v1', requestId, operation, payload])
  );
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
