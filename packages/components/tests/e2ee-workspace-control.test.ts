import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Result } from 'effect';
import {
  encodeCbor,
  hashRecordBytes,
  recordSigningBytes,
  type CborValue,
} from '@lody/e2ee-core/protocol';
import type { E2eeWorkspaceHistoryPage } from '@lody/cloud-api';
import type { PlatformE2eeWorkspaces } from '@lody/platform';
import {
  appendLedgerHistory,
  bytesToHex,
  ledgerRecordFields,
} from '../src/lib/e2ee-ledger-history';
import { createPreparedE2eeWorkspace } from '../src/lib/create-e2ee-workspace';
import {
  listPendingE2eeWorkspaces,
  readE2eeGenesisPin,
  readObservedLedgerCheckpoint,
  readPendingE2eeWorkspace,
  readWorkspaceModeProof,
  retainObservedLedgerCheckpoint,
  retainWorkspaceModeProof,
  savePendingE2eeWorkspace,
} from '../src/lib/e2ee-workspace-storage';

class MemoryStorage implements Storage {
  data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
}

const fill = (size: number, value: number) => new Uint8Array(size).fill(value);
function historyFixture(commitment = 6) {
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.from(fill(32, 1)),
    ]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = new Uint8Array(
    createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32)
  );
  const signed = (body: CborValue) => {
    const bytes = Result.getOrThrow(encodeCbor(body));
    return Result.getOrThrow(
      encodeCbor([body, new Uint8Array(sign(null, recordSigningBytes(bytes), privateKey))])
    );
  };
  const genesis = signed([1, publicKey, fill(32, 2), fill(16, 3), fill(32, 4), fill(32, 5)]);
  const genesisHash = bytesToHex(hashRecordBytes(genesis).toBytes());
  const second = signed([
    hashRecordBytes(genesis).toBytes(),
    publicKey,
    [7, 1, fill(32, commitment), fill(72, 7)],
  ]);
  const third = signed([
    hashRecordBytes(second).toBytes(),
    publicKey,
    [7, 2, fill(32, 10), fill(72, 11)],
  ]);
  const checkpoint = { headHash: bytesToHex(hashRecordBytes(second).toBytes()), length: 2 };
  const firstPage: E2eeWorkspaceHistoryPage = {
    workspaceId: 'workspace-1',
    genesisHash,
    checkpoint,
    startIndex: 0,
    recordsHex: [bytesToHex(genesis)],
    nextCursor: 'next',
  };
  const secondPage: E2eeWorkspaceHistoryPage = {
    ...firstPage,
    startIndex: 1,
    recordsHex: [bytesToHex(second)],
    nextCursor: null,
  };
  return {
    genesisHash,
    firstPage,
    secondPage,
    third,
    expected: { workspaceId: 'workspace-1', genesisHash, localPin: genesisHash },
  };
}

describe('encrypted workspace history', () => {
  it('verifies every signed record from genesis across pages and explains decoded events', () => {
    const fixture = historyFixture();
    const prefix = appendLedgerHistory(null, fixture.firstPage, fixture.expected);
    expect(prefix.records[0]?.body.type).toBe('genesis');
    expect(prefix.locallyPinned).toBe(true);
    const complete = appendLedgerHistory(prefix, fixture.secondPage, fixture.expected);
    expect(complete.view.length).toBe(2);
    expect(complete.page.nextCursor).toBeNull();
    expect(complete.view.inspectState().epoch.number).toBe(1);
    expect(ledgerRecordFields(complete.records[1]!.body)).toMatchObject({
      epoch: 1,
      commitment: bytesToHex(fill(32, 6)),
    });
    expect(prefix.view.length).toBe(1);
  });

  it('distinguishes a server-only genesis from an independently retained pin', () => {
    const fixture = historyFixture();
    expect(
      appendLedgerHistory(null, fixture.firstPage, { ...fixture.expected, localPin: null })
        .locallyPinned
    ).toBe(false);
    expect(() =>
      appendLedgerHistory(null, fixture.firstPage, {
        ...fixture.expected,
        localPin: '00'.repeat(32),
      })
    ).toThrow();
  });

  it('rejects skipped history, premature completion, changed boundaries and corrupt signatures', () => {
    const fixture = historyFixture();
    const prefix = appendLedgerHistory(null, fixture.firstPage, fixture.expected);
    expect(() => appendLedgerHistory(null, fixture.secondPage, fixture.expected)).toThrow();
    expect(() =>
      appendLedgerHistory(null, { ...fixture.firstPage, nextCursor: null }, fixture.expected)
    ).toThrow();
    expect(() =>
      appendLedgerHistory(
        prefix,
        { ...fixture.secondPage, checkpoint: { ...fixture.secondPage.checkpoint, length: 3 } },
        fixture.expected
      )
    ).toThrow();
    const corrupt = Uint8Array.from(Buffer.from(fixture.firstPage.recordsHex[0]!, 'hex'));
    corrupt[corrupt.length - 1]! ^= 1;
    const changedGenesis = bytesToHex(hashRecordBytes(corrupt).toBytes());
    expect(() =>
      appendLedgerHistory(
        null,
        {
          ...fixture.firstPage,
          genesisHash: changedGenesis,
          checkpoint: { headHash: changedGenesis, length: 1 },
          recordsHex: [bytesToHex(corrupt)],
          nextCursor: null,
        },
        { ...fixture.expected, genesisHash: changedGenesis, localPin: null }
      )
    ).toThrow('bad-signature');
    expect(prefix.records).toHaveLength(1);
  });

  it('rejects rollback and forks across refresh, and only advances an observed checkpoint after verifying its continuation', () => {
    const fixture = historyFixture();
    const storage = new MemoryStorage();
    const prefix = appendLedgerHistory(null, fixture.firstPage, fixture.expected);
    retainObservedLedgerCheckpoint(storage, 'account', 'workspace-1', prefix);
    expect(readObservedLedgerCheckpoint(storage, 'account', 'workspace-1')?.length).toBe(1);
    const complete = appendLedgerHistory(prefix, fixture.secondPage, fixture.expected);
    retainObservedLedgerCheckpoint(storage, 'account', 'workspace-1', complete);
    const observed = readObservedLedgerCheckpoint(storage, 'account', 'workspace-1')!;
    const expected = { ...fixture.expected, observed };
    expect(() =>
      appendLedgerHistory(
        null,
        {
          ...fixture.firstPage,
          checkpoint: { headHash: fixture.genesisHash, length: 1 },
          nextCursor: null,
        },
        expected
      )
    ).toThrow('rolled back');
    const fork = historyFixture(8);
    const forkPrefix = appendLedgerHistory(null, fork.firstPage, expected);
    expect(forkPrefix.continuityPending).toBe(true);
    expect(() => appendLedgerHistory(forkPrefix, fork.secondPage, expected)).toThrow('changed');
    expect(readObservedLedgerCheckpoint(storage, 'account', 'workspace-1')).toEqual(observed);
    const checkpoint = {
      headHash: bytesToHex(hashRecordBytes(fixture.third).toBytes()),
      length: 3,
    };
    const refreshedPrefix = appendLedgerHistory(
      null,
      { ...fixture.firstPage, checkpoint },
      expected
    );
    expect(retainObservedLedgerCheckpoint(storage, 'account', 'workspace-1', refreshedPrefix)).toBe(
      false
    );
    const longer = appendLedgerHistory(
      refreshedPrefix,
      {
        ...fixture.secondPage,
        checkpoint,
        recordsHex: [...fixture.secondPage.recordsHex, bytesToHex(fixture.third)],
      },
      expected
    );
    expect(retainObservedLedgerCheckpoint(storage, 'account', 'workspace-1', longer)).toBe(true);
    expect(readObservedLedgerCheckpoint(storage, 'account', 'workspace-1')?.length).toBe(3);
    expect(retainObservedLedgerCheckpoint(storage, 'account', 'workspace-1', refreshedPrefix)).toBe(
      false
    );
    expect(readObservedLedgerCheckpoint(storage, 'account', 'workspace-1')?.length).toBe(3);
  });
});

describe('encrypted workspace creation recovery', () => {
  const pending = {
    accountId: 'account-1',
    requestId: 'request-1',
    name: 'Synthetic',
    slug: 'synthetic',
  };
  const genesisHash = '12'.repeat(32);
  const result = {
    workspaceId: 'workspace-1',
    name: pending.name,
    slug: pending.slug,
    contentMode: 'e2ee' as const,
    contentModeVersion: 1 as const,
    cryptoOrgId: genesisHash,
    genesisHash,
    activation: 'control-only' as const,
  };
  function port(create: PlatformE2eeWorkspaces['create']): PlatformE2eeWorkspaces {
    return {
      prepareCreation: async (input) => ({
        ...input,
        genesisRecordHex: 'ab',
        genesisHashHex: genesisHash,
      }),
      create,
      describe: async () => result,
      history: async () => {
        throw new Error('unused');
      },
    };
  }

  it('preserves the exact request after an unknown result and pins only its reconciled success', async () => {
    const storage = new MemoryStorage();
    savePendingE2eeWorkspace(storage, pending);
    const requests: unknown[] = [];
    let responseLost = true;
    const service = port(async (request) => {
      requests.push(request);
      if (responseLost) {
        responseLost = false;
        throw new Error('Response lost after commit');
      }
      return result;
    });
    await expect(createPreparedE2eeWorkspace(service, storage, pending)).rejects.toThrow(
      'Response lost'
    );
    expect(readPendingE2eeWorkspace(storage, pending.accountId)).toEqual(pending);
    expect(readE2eeGenesisPin(storage, pending.accountId, result.workspaceId)).toBeNull();
    expect(
      await createPreparedE2eeWorkspace(
        service,
        storage,
        readPendingE2eeWorkspace(storage, pending.accountId)!
      )
    ).toEqual(result);
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[0]).toMatchObject({ accountId: pending.accountId });
    expect(readPendingE2eeWorkspace(storage, pending.accountId)).toBeNull();
    expect(readE2eeGenesisPin(storage, pending.accountId, result.workspaceId)).toBe(genesisHash);
    expect(readE2eeGenesisPin(storage, 'other-account', result.workspaceId)).toBeNull();
  });

  it('keeps the pending request when a receipt belongs to a different genesis', async () => {
    const storage = new MemoryStorage();
    savePendingE2eeWorkspace(storage, pending);
    await expect(
      createPreparedE2eeWorkspace(
        port(async () => ({ ...result, genesisHash: '34'.repeat(32) })),
        storage,
        pending
      )
    ).rejects.toThrow();
    expect(readPendingE2eeWorkspace(storage, pending.accountId)).toEqual(pending);
    expect(readE2eeGenesisPin(storage, pending.accountId, result.workspaceId)).toBeNull();
  });

  it('preserves an unknown request from one window when another request completes', async () => {
    const storage = new MemoryStorage();
    const second = { ...pending, requestId: 'request-2', name: 'Second', slug: 'second' };
    savePendingE2eeWorkspace(storage, pending);
    savePendingE2eeWorkspace(storage, second);
    expect(listPendingE2eeWorkspaces(storage, pending.accountId)).toEqual([pending, second]);
    await createPreparedE2eeWorkspace(
      port(async () => ({
        ...result,
        name: second.name,
        slug: second.slug,
        workspaceId: 'second',
      })),
      storage,
      second
    );
    expect(listPendingE2eeWorkspaces(storage, pending.accountId)).toEqual([pending]);
    await expect(
      createPreparedE2eeWorkspace(
        port(async () => {
          throw new Error('Unknown');
        }),
        storage,
        pending
      )
    ).rejects.toThrow();
    expect(readPendingE2eeWorkspace(storage, pending.accountId)).toEqual(pending);
  });

  it('retains known encrypted mode without accepting a malformed response or downgrade', () => {
    const storage = new MemoryStorage();
    expect(() =>
      retainWorkspaceModeProof(storage, pending.accountId, pending.slug, {
        ...result,
        genesisHash: 'invalid',
      })
    ).toThrow();
    expect(
      readWorkspaceModeProof(storage, pending.accountId, result.workspaceId, pending.slug)
    ).toBeNull();
    retainWorkspaceModeProof(storage, pending.accountId, pending.slug, result);
    expect(() =>
      retainWorkspaceModeProof(storage, pending.accountId, pending.slug, {
        workspaceId: result.workspaceId,
        contentMode: 'plaintext',
        contentModeVersion: 1,
      })
    ).toThrow();
    expect(
      readWorkspaceModeProof(storage, pending.accountId, result.workspaceId, pending.slug)
    ).toEqual(result);
  });
});
