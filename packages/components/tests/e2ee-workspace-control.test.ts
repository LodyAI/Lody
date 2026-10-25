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
import {
  createPreparedE2eeWorkspace,
  e2eeCreationChoice,
  e2eeCreationErrorCode,
  isE2eeCreationNotEnabled,
} from '../src/lib/create-e2ee-workspace';
import {
  listPendingE2eeWorkspaces,
  readE2eeGenesisPin,
  readObservedLedgerCheckpoint,
  readPendingE2eeWorkspace,
  readWorkspaceModeProof,
  repairUnreadableE2eeCaches,
  resetObservedLedgerProgress,
  retainObservedLedgerCheckpoint,
  retainWorkspaceModeProof,
  saveE2eeGenesisPin,
  savePendingE2eeWorkspace,
} from '../src/lib/e2ee-workspace-storage';
import {
  classifyE2eeControlFailure,
  e2eeControlDiagnostics,
} from '../src/lib/e2ee-control-failure';
import { createCloudE2eeWorkspaces } from '../src/providers/cloud-e2ee-workspaces';

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
  // A genuine Owner capability declaration that this client version cannot verify past.
  const declaration = signed([hashRecordBytes(second).toBytes(), publicKey, [9, [1]]]);
  const checkpoint = { headHash: bytesToHex(hashRecordBytes(second).toBytes()), length: 2 };
  const firstPage: E2eeWorkspaceHistoryPage = {
    workspaceId: 'workspace-1',
    genesisHash,
    checkpoint,
    startIndex: 0,
    recordsHex: [bytesToHex(genesis)],
    position: 'p1:workspace-1:1:offset:0',
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
    declaration,
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
    ).toThrow('rolled-back');
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

const failureOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return classifyE2eeControlFailure(error);
  }
  throw new Error('expected a failure');
};

describe('encrypted workspace recovery classification', () => {
  it('shows the verified prefix and stops at a capability declaration instead of reporting corruption', () => {
    const fixture = historyFixture();
    const checkpoint = {
      headHash: bytesToHex(hashRecordBytes(fixture.declaration).toBytes()),
      length: 3,
    };
    const single = appendLedgerHistory(
      null,
      {
        ...fixture.firstPage,
        checkpoint,
        recordsHex: [
          ...fixture.firstPage.recordsHex,
          ...fixture.secondPage.recordsHex,
          bytesToHex(fixture.declaration),
        ],
        nextCursor: null,
      },
      fixture.expected
    );
    expect(single.upgradeRequiredAt).toBe(2);
    expect(single.view.length).toBe(2);
    expect(single.records.map((record) => record.index)).toEqual([0, 1]);
    const storage = new MemoryStorage();
    expect(retainObservedLedgerCheckpoint(storage, 'account', 'workspace-1', single)).toBe(true);
    expect(readObservedLedgerCheckpoint(storage, 'account', 'workspace-1')?.length).toBe(2);

    const first = appendLedgerHistory(
      null,
      {
        ...fixture.firstPage,
        checkpoint,
        recordsHex: [...fixture.firstPage.recordsHex, ...fixture.secondPage.recordsHex],
      },
      fixture.expected
    );
    const paged = appendLedgerHistory(
      first,
      {
        ...fixture.secondPage,
        checkpoint,
        startIndex: 2,
        recordsHex: [bytesToHex(fixture.declaration)],
      },
      fixture.expected
    );
    expect(paged.upgradeRequiredAt).toBe(2);
    expect(paged.records).toHaveLength(2);
    expect(paged.view).toBe(first.view);
  });

  it('separates identity conflicts, rollbacks and invalid server history', () => {
    const fixture = historyFixture();
    expect(
      failureOf(() =>
        appendLedgerHistory(null, fixture.firstPage, {
          ...fixture.expected,
          localPin: 'ab'.repeat(32),
        })
      )
    ).toEqual({ kind: 'identity-conflict', code: 'pin-mismatch' });
    const prefix = appendLedgerHistory(null, fixture.firstPage, fixture.expected);
    expect(
      failureOf(() =>
        appendLedgerHistory(
          prefix,
          { ...fixture.secondPage, recordsHex: [bytesToHex(fixture.third)] },
          fixture.expected
        )
      )
    ).toMatchObject({ kind: 'server' });
    const storage = new MemoryStorage();
    saveE2eeGenesisPin(storage, 'account', 'workspace-1', fixture.genesisHash);
    expect(
      failureOf(() => saveE2eeGenesisPin(storage, 'account', 'workspace-1', 'cd'.repeat(32)))
    ).toEqual({
      kind: 'identity-conflict',
      code: 'Genesis pin changed',
    });
  });

  it('repairs only unreadable optional caches and keeps identity evidence and conflicts', () => {
    const fixture = historyFixture();
    const storage = new MemoryStorage();
    saveE2eeGenesisPin(storage, 'account', 'encrypted', fixture.genesisHash);
    storage.setItem('lody-e2ee-known-mode:account:encrypted', fixture.genesisHash);
    storage.setItem('lody-workspace-mode-proof:account:encrypted', '{broken');
    storage.setItem('lody-workspace-mode-proof:account:plain', '{broken');
    // A valid proof that contradicts sticky evidence is a downgrade signal, not a cache.
    storage.setItem('lody-e2ee-known-mode:account:downgraded', fixture.genesisHash);
    storage.setItem(
      'lody-workspace-mode-proof:account:downgraded',
      JSON.stringify({
        accountId: 'account',
        workspaceSlug: 'downgraded',
        descriptor: { workspaceId: 'downgraded', contentMode: 'plaintext', contentModeVersion: 1 },
      })
    );
    storage.setItem('lody-e2ee-observed-ledger:account:encrypted:1:x', 'not json');
    storage.setItem('lody-workspace-mode-proof:other:plain', '{broken');
    savePendingE2eeWorkspace(storage, {
      accountId: 'account',
      requestId: 'r',
      name: 'n',
      slug: 's',
    });
    expect(
      failureOf(() => readWorkspaceModeProof(storage, 'account', 'plain', 'plain'))
    ).toMatchObject({
      kind: 'local-corrupt',
    });

    expect(repairUnreadableE2eeCaches(storage, 'account')).toBe(3);
    expect(storage.getItem('lody-workspace-mode-proof:account:plain')).toBeNull();
    expect(storage.getItem('lody-workspace-mode-proof:account:encrypted')).toBeNull();
    expect(storage.getItem('lody-e2ee-observed-ledger:account:encrypted:1:x')).toBeNull();
    expect(readE2eeGenesisPin(storage, 'account', 'encrypted')).toBe(fixture.genesisHash);
    expect(storage.getItem('lody-e2ee-known-mode:account:encrypted')).toBe(fixture.genesisHash);
    expect(storage.getItem('lody-workspace-mode-proof:account:downgraded')).not.toBeNull();
    expect(storage.getItem('lody-workspace-mode-proof:other:plain')).toBe('{broken');
    expect(readPendingE2eeWorkspace(storage, 'account')?.requestId).toBe('r');

    // A corrupt pin is identity evidence: classified for support, never deleted.
    storage.setItem('lody-e2ee-genesis-pin:account:encrypted', 'garbage');
    expect(failureOf(() => readE2eeGenesisPin(storage, 'account', 'encrypted'))).toMatchObject({
      kind: 'identity-conflict',
    });
    repairUnreadableE2eeCaches(storage, 'account');
    expect(storage.getItem('lody-e2ee-genesis-pin:account:encrypted')).toBe('garbage');
  });

  it('resets observed progress for one workspace only after an explicit request', () => {
    const fixture = historyFixture();
    const storage = new MemoryStorage();
    const prefix = appendLedgerHistory(null, fixture.firstPage, fixture.expected);
    retainObservedLedgerCheckpoint(storage, 'account', 'workspace-1', prefix);
    retainObservedLedgerCheckpoint(storage, 'account', 'workspace-2', {
      ...prefix,
      page: { ...prefix.page, workspaceId: 'workspace-2' },
    });
    saveE2eeGenesisPin(storage, 'account', 'workspace-1', fixture.genesisHash);
    expect(resetObservedLedgerProgress(storage, 'account', 'workspace-1')).toBe(1);
    expect(readObservedLedgerCheckpoint(storage, 'account', 'workspace-1')).toBeNull();
    expect(readObservedLedgerCheckpoint(storage, 'account', 'workspace-2')?.length).toBe(1);
    expect(readE2eeGenesisPin(storage, 'account', 'workspace-1')).toBe(fixture.genesisHash);
  });

  it('builds diagnostics without account identifiers or record bodies', () => {
    const fixture = historyFixture();
    const history = appendLedgerHistory(null, fixture.firstPage, fixture.expected);
    const report = e2eeControlDiagnostics({
      workspaceId: 'workspace-1',
      genesisHash: fixture.genesisHash,
      localPin: fixture.genesisHash,
      observed: { length: 1, headHash: fixture.genesisHash },
      history,
      failure: { kind: 'progress-conflict', code: 'rolled-back' },
      now: new Date('2026-10-17T00:00:00Z'),
    });
    const parsed = JSON.parse(report) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      workspaceId: 'workspace-1',
      server: { verifiedLength: 1, checkpoint: fixture.firstPage.checkpoint },
      failure: { kind: 'progress-conflict' },
    });
    expect(report).not.toContain(fixture.firstPage.recordsHex[0]!);
    expect(report).not.toContain('account');
  });

  it('asks for an update when the server describes a newer mode or activation', async () => {
    const service = (descriptor: unknown) =>
      createCloudE2eeWorkspaces({
        session: () => ({
          status: 'authenticated',
          user: { id: 'account', email: 'a@example.invalid', name: 'A', image: null },
        }),
        remote: {
          create: () => Promise.reject(new Error('unused')),
          describe: () => Promise.resolve(descriptor as never),
          history: () => Promise.reject(new Error('unused')),
        },
        refreshWorkspaces: () => Promise.resolve(),
      });
    const hash = 'ab'.repeat(32);
    for (const descriptor of [
      {
        workspaceId: 'w',
        contentMode: 'e2ee',
        contentModeVersion: 2,
        cryptoOrgId: hash,
        genesisHash: hash,
      },
      {
        workspaceId: 'w',
        contentMode: 'e2ee',
        contentModeVersion: 1,
        cryptoOrgId: hash,
        genesisHash: hash,
        activation: 'content',
      },
    ]) {
      const error = await service(descriptor)
        .describe({ workspaceId: 'w' })
        .catch((reason: unknown) => reason);
      expect(classifyE2eeControlFailure(error)).toMatchObject({ kind: 'upgrade' });
    }
    const malformed = await service({
      workspaceId: 'w',
      contentMode: 'e2ee',
      contentModeVersion: 1,
      activation: 7,
    })
      .describe({ workspaceId: 'w' })
      .catch((reason: unknown) => reason);
    expect(classifyE2eeControlFailure(malformed)).toMatchObject({ kind: 'mode' });
  });
});

describe('encrypted workspace creation gate', () => {
  it('requires both developer toggles for new creation but keeps a saved request resumable', () => {
    expect(
      e2eeCreationChoice({
        featureEnabled: false,
        selected: true,
        resumable: false,
        savedRequests: 0,
      })
    ).toEqual({
      showOption: false,
      encrypt: false,
    });
    expect(
      e2eeCreationChoice({
        featureEnabled: true,
        selected: false,
        resumable: false,
        savedRequests: 0,
      })
    ).toEqual({
      showOption: true,
      encrypt: false,
    });
    expect(
      e2eeCreationChoice({
        featureEnabled: true,
        selected: true,
        resumable: false,
        savedRequests: 0,
      })
    ).toEqual({
      showOption: true,
      encrypt: true,
    });
    expect(
      e2eeCreationChoice({
        featureEnabled: false,
        selected: false,
        resumable: true,
        savedRequests: 1,
      })
    ).toEqual({
      showOption: true,
      encrypt: true,
    });
    expect(
      e2eeCreationChoice({
        featureEnabled: false,
        selected: false,
        resumable: false,
        savedRequests: 1,
      })
    ).toEqual({
      showOption: true,
      encrypt: false,
    });
  });
});

describe('saved creation requests after a server refusal', () => {
  const pending = { accountId: 'account', requestId: 'request-1', name: 'n', slug: 's' };
  const refusing = (failure: unknown) =>
    ({
      prepareCreation: async () => ({
        ...pending,
        genesisRecordHex: 'aa',
        genesisHashHex: 'bb'.repeat(32),
      }),
      create: async () => {
        throw failure;
      },
      describe: async () => {
        throw new Error('unused');
      },
      history: async () => {
        throw new Error('unused');
      },
    }) satisfies PlatformE2eeWorkspaces;
  const refusal = (code: string) => Object.assign(new Error(code), { data: { code } });

  it.each([
    'e2ee_creation_not_enabled',
    'e2ee_creation_deleted',
    'e2ee_genesis_already_bound',
    'workspace_slug_taken',
  ])(
    'removes a request the server proved unreserved (%s) and rethrows the refusal',
    async (code) => {
      const storage = new MemoryStorage();
      const other = { ...pending, requestId: 'request-2', slug: 'other' };
      savePendingE2eeWorkspace(storage, pending);
      savePendingE2eeWorkspace(storage, other);
      const error = await createPreparedE2eeWorkspace(
        refusing(refusal(code)),
        storage,
        pending
      ).catch((reason: unknown) => reason);
      expect(e2eeCreationErrorCode(error)).toBe(code);
      expect(isE2eeCreationNotEnabled(error)).toBe(code === 'e2ee_creation_not_enabled');
      expect(listPendingE2eeWorkspaces(storage, 'account')).toEqual([other]);
    }
  );

  it.each([
    ['an unknown outcome', new Error('reply lost')],
    ['a reserved conflicting request', refusal('e2ee_creation_conflict')],
    ['a code only in the message', new Error('e2ee_creation_not_enabled')],
  ])('keeps the request after %s', async (_label, failure) => {
    const storage = new MemoryStorage();
    savePendingE2eeWorkspace(storage, pending);
    await expect(createPreparedE2eeWorkspace(refusing(failure), storage, pending)).rejects.toBe(
      failure
    );
    expect(readPendingE2eeWorkspace(storage, 'account')).toEqual(pending);
  });
});
