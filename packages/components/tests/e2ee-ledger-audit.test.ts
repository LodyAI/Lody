import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { E2eeWorkspaceHistoryPage } from '@lody/cloud-api';
import { auditLedgerHistory } from '../src/lib/e2ee-ledger-audit';
import { appendLedgerHistory } from '../src/lib/e2ee-ledger-history';
import { ledgerVerificationCode } from '../src/lib/e2ee-ledger-verification';

const vector = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../e2ee-core/test/ledger-v1-vector.json'), 'utf8')
) as { anchor: string; records: { hex: string }[] };
const checkpoint = {
  headHash: 'e7fe1ef3dfaa4e1001fd1a4df3a1af79f6c5d6cbc72b11502372b6030b813668',
  length: 9,
};
const page: E2eeWorkspaceHistoryPage = {
  workspaceId: 'w',
  genesisHash: vector.anchor,
  checkpoint,
  startIndex: 0,
  recordsHex: vector.records.slice(0, 9).map((record) => record.hex),
  position: 'p9',
  nextCursor: null,
};
const trusted = appendLedgerHistory(null, page, {
  workspaceId: 'w',
  genesisHash: vector.anchor,
  localPin: vector.anchor,
});
const expected = { ...checkpoint, stateDigest: ledgerVerificationCode(trusted).stateDigest };
const base = {
  workspaceId: 'w',
  genesisHash: vector.anchor,
  expected,
  signal: new AbortController().signal,
};

describe('explicit ledger audit', () => {
  it('replays multiple pages to the same state without mutating the trusted view', async () => {
    const progress: number[] = [];
    const result = await auditLedgerHistory({
      ...base,
      progress: (n) => progress.push(n),
      read: async (request) => {
        expect(request.checkpoint).toEqual(checkpoint);
        return request.cursor
          ? { ...page, startIndex: 4, recordsHex: page.recordsHex.slice(4) }
          : { ...page, recordsHex: page.recordsHex.slice(0, 4), position: 'p4', nextCursor: 'c4' };
      },
    });
    expect(result).toEqual({ length: 9, stateDigest: expected.stateDigest });
    expect(progress).toEqual([4, 9]);
    expect(ledgerVerificationCode(trusted).stateDigest).toBe(expected.stateDigest);
  });

  it.each(['signature', 'gap', 'endpoint', 'digest'] as const)(
    'rejects %s and preserves original evidence',
    async (fault) => {
      const records = [...page.recordsHex];
      if (fault === 'signature') records[0] = records[0].slice(0, -2) + 'ff';
      await expect(
        auditLedgerHistory({
          ...base,
          expected: fault === 'digest' ? { ...expected, stateDigest: '00'.repeat(32) } : expected,
          progress: () => undefined,
          read: async () => ({
            ...page,
            recordsHex: records,
            ...(fault === 'gap' ? { startIndex: 1 } : {}),
            ...(fault === 'endpoint' ? { checkpoint: { ...checkpoint, length: 10 } } : {}),
          }),
        })
      ).rejects.toThrow();
      expect(ledgerVerificationCode(trusted).stateDigest).toBe(expected.stateDigest);
    }
  );

  it('stops after an in-flight cancellation and recovers on the next explicit call', async () => {
    const abort = new AbortController();
    await expect(
      auditLedgerHistory({
        ...base,
        signal: abort.signal,
        progress: () => {
          throw new Error('late progress');
        },
        read: async () => {
          abort.abort();
          return page;
        },
      })
    ).rejects.toThrow();
    await expect(
      auditLedgerHistory({ ...base, progress: () => undefined, read: async () => page })
    ).resolves.toEqual({ length: 9, stateDigest: expected.stateDigest });
  });
});
