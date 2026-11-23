import type { E2eeWorkspaceHistoryPage, E2eeWorkspaceHistoryRequest } from '@lody/cloud-api';
import { ledgerStateDigest } from '@lody/e2ee-core/protocol';
import { Result } from 'effect';
import { appendLedgerHistory, bytesToHex, type VerifiedLedgerHistory } from './e2ee-ledger-history';

/** Explicit full replay against a caller-owned verified endpoint. This audit
 * never writes pins, cursors, caches or runtime state. A failed page leaves all
 * durable evidence intact; cancellation stops requesting further pages. */
export async function auditLedgerHistory(input: {
  workspaceId: string;
  genesisHash: string;
  expected: { length: number; headHash: string; stateDigest: string };
  read: (request: E2eeWorkspaceHistoryRequest) => Promise<E2eeWorkspaceHistoryPage>;
  progress: (verified: number, total: number) => void;
  signal: AbortSignal;
}): Promise<{ length: number; stateDigest: string }> {
  const checkpoint = { length: input.expected.length, headHash: input.expected.headHash };
  let history: VerifiedLedgerHistory | null = null;
  let cursor: string | undefined;
  for (;;) {
    input.signal.throwIfAborted();
    const page = await input.read({
      workspaceId: input.workspaceId,
      checkpoint,
      ...(cursor ? { cursor } : {}),
    });
    input.signal.throwIfAborted();
    // Pin the endpoint ourselves on the first page too: the server may not
    // silently select another otherwise-valid history for this audit.
    if (
      page.checkpoint.length !== checkpoint.length ||
      page.checkpoint.headHash !== checkpoint.headHash
    )
      throw new Error('e2ee_audit_endpoint_conflict');
    history = appendLedgerHistory(history, page, {
      workspaceId: input.workspaceId,
      genesisHash: input.genesisHash,
      localPin: input.genesisHash,
    });
    if (history.upgradeRequiredAt !== undefined) throw new Error('e2ee_audit_upgrade_required');
    input.progress(history.view.length, checkpoint.length);
    if (page.nextCursor === null) break;
    if (cursor === page.nextCursor) throw new Error('e2ee_audit_cursor_conflict');
    cursor = page.nextCursor;
  }
  const stateDigest = bytesToHex(Result.getOrThrow(ledgerStateDigest(history.view)).toBytes());
  if (stateDigest !== input.expected.stateDigest) throw new Error('e2ee_audit_state_conflict');
  return { length: history.view.length, stateDigest };
}
