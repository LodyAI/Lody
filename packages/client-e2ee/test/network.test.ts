import { expect, it } from 'vitest';
import { Cause, Effect, Exit, ManagedRuntime, Result } from 'effect';
import { TestClock } from 'effect/testing';
import { getFunctionName } from 'convex/server';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import {
  Bytes,
  accountUserId,
  encodeCbor,
  hashRecordBytes,
  recordSigningBytes,
  prepareJoinRequest,
  prepareLedgerCommand,
  signDeviceCredentialBinding,
  signGenesisRecord,
  signLedgerRecord,
  verifyLedger,
} from '@lody/e2ee-core/protocol';
import { importBrowserDevice } from '@lody/e2ee-core/adapters/browser-crypto';
import { encodeEpochStagedGroup } from '@lody/e2ee-core/host';
import { encodeMemberKeyPackage, signMemberOffer } from '@lody/e2ee-client/member';
import {
  BackendRefusal,
  E2eeAccessRefusal,
  makePersonalCloudNetwork,
  type PersonalCloudConnection,
} from '../src/network';

const hash = '11'.repeat(32);
const scope = {
  accountId: 'account-A',
  workspaceId: 'workspace-A',
  genesis: Result.getOrThrow(Bytes.genesisHash(new Uint8Array(32).fill(17))),
};
const request = {
  version: 1 as const,
  action: 'claim' as const,
  accountId: scope.accountId,
  workspaceId: scope.workspaceId,
  genesisHash: hash,
  pairingSessionId: '22'.repeat(16),
  requestHex: '7b7d',
};
function fixture(
  work: (name: string, args: unknown) => Promise<unknown>,
  networkScope = scope,
  options: Pick<
    Parameters<typeof makePersonalCloudNetwork>[0],
    'genesisRecordHex' | 'retryBackoffMs' | 'requestTimeoutMs'
  > = {}
) {
  let account: string | null = scope.accountId;
  const invoke = (ref: Parameters<typeof getFunctionName>[0], args: unknown) =>
    work(getFunctionName(ref), args);
  const client = {
    query: invoke,
    mutation: invoke,
    action: invoke,
  } as unknown as PersonalCloudConnection['client'];
  const network = makePersonalCloudNetwork({
    scope: networkScope,
    ...options,
    client,
    currentAccount: () => Effect.succeed(account),
  });
  return {
    network,
    switchAccount: (next: string | null) => {
      account = next;
    },
  };
}
it.each(['exchange', 'history'] as const)(
  'rejects an account switch while an actual %s response is outstanding',
  async (operation) => {
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { network, switchAccount } = fixture(async () => {
      started();
      await waiting;
      if (operation === 'history')
        return {
          workspaceId: scope.workspaceId,
          genesisHash: hash,
          checkpoint: { length: 1, headHash: hash },
          startIndex: 0,
          recordsHex: ['aa'],
          position: 'opaque/1',
          nextCursor: null,
        };
      return {
        ...request,
        status: 'pending',
        signingPublicKey: hash,
        credentialHash: hash,
        invitationHex: null,
        publisher: null,
      };
    });
    const pending = Effect.runPromise(
      Effect.result(
        operation === 'exchange'
          ? network.remote.exchange(request).pipe(Effect.asVoid)
          : network.remote.history!(new Uint8Array(32).fill(0xab)).pipe(Effect.asVoid)
      )
    );
    await entered;
    switchAccount('account-B');
    release();
    const outcome = await pending;
    expect(Result.isFailure(outcome) && outcome.failure).toMatchObject({ reason: 'unauthorized' });
  }
);
it('rejects cross-binding mailbox status and never uses ordinary credentials as a content grant', async () => {
  const { network } = fixture(async (name) =>
    name === 'e2eeMailbox:status'
      ? {
          genesis: '33'.repeat(32),
          epoch: 0,
          recipient: hash,
          revision: 1,
          status: 'EnvelopeStored',
        }
      : {
          token: 'ordinary',
          bucketId: 'lody',
          gatewayBaseUrl: 'https://streams.example.test',
          expiresAt: 1000,
          expiresIn: 900,
        }
  );
  const mailbox = network.mailbox('ab'.repeat(32));
  expect(
    Exit.isFailure(
      await Effect.runPromiseExit(mailbox.status({ genesis: hash, epoch: 0, recipient: hash }))
    )
  ).toBe(true);
  expect(
    Exit.isFailure(await Effect.runPromiseExit(network.contentToken('ab'.repeat(32), {})))
  ).toBe(true);
});
it('requires contiguous bounded history with an unchanged endpoint and exact workspace/genesis', async () => {
  for (const corrupt of ['scope', 'checkpoint', 'gap', 'repeat']) {
    let page = 0;
    const { network } = fixture(async () => {
      page++;
      return {
        workspaceId: corrupt === 'scope' ? 'workspace-B' : scope.workspaceId,
        genesisHash: hash,
        checkpoint: {
          headHash: corrupt === 'checkpoint' && page > 1 ? '33'.repeat(32) : hash,
          length: 2,
        },
        startIndex: corrupt === 'gap' ? 2 : page - 1,
        recordsHex: ['aa'],
        position: 'opaque/' + page,
        nextCursor: corrupt === 'repeat' ? 'again' : page === 1 ? 'next' : null,
      };
    });
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(network.remote.history!(new Uint8Array(32).fill(0xab)))
      )
    ).toBe(true);
  }
});
it('does not interpret an admitted relay projection as desktop approval', async () => {
  const { network } = fixture(async () => ({
    ...request,
    signingPublicKey: hash,
    credentialHash: hash,
    status: 'admitted',
    invitationHex: null,
    publisher: null,
  }));
  expect(await Effect.runPromise(network.remote.exchange(request))).toMatchObject({
    status: 'admitting',
  });
});
it('keeps SDK failure payloads out of the host failure channel', async () => {
  const secret = 'synthetic-private-error-body';
  const { network } = fixture(async () => {
    throw { token: secret, body: secret };
  });
  const result = await Effect.runPromiseExit(network.remote.exchange(request));
  expect(Exit.isFailure(result)).toBe(true);
  expect(JSON.stringify(result)).not.toContain(secret);
});

it('qualifies an approved snapshot through complete history bound to the borrowed device credential', async () => {
  const seen: unknown[] = [];
  const { network, switchAccount } = fixture(async (name, args) => {
    expect(name).toBe('e2eeWorkspaces:history');
    seen.push(args);
    const input = args as { cursor?: string };
    return {
      workspaceId: scope.workspaceId,
      genesisHash: hash,
      checkpoint: { headHash: hash, length: 2 },
      startIndex: input.cursor ? 1 : 0,
      recordsHex: [input.cursor ? 'bb' : 'aa'],
      position: input.cursor ? 'opaque/2' : 'opaque/1',
      nextCursor: input.cursor ? null : 'next',
    };
  });
  const credential = new Uint8Array(32).fill(0xab);
  const proof = network.remote.history!(credential);
  credential.fill(0);
  const pages = await Effect.runPromise(proof);
  expect(pages.flatMap((page) => page.recordsHex)).toEqual(['aa', 'bb']);
  expect(seen).toEqual([
    { workspaceId: scope.workspaceId, credential: 'ab'.repeat(32) },
    {
      workspaceId: scope.workspaceId,
      credential: 'ab'.repeat(32),
      cursor: 'next',
      checkpoint: { length: 2, headHash: hash },
    },
  ]);
  switchAccount('account-B');
  expect(Exit.isFailure(await Effect.runPromiseExit(proof))).toBe(true);
});

it('sends the session credential to the member relay and refuses replies for another workspace', async () => {
  const calls: { name: string; args: unknown }[] = [];
  const item = {
    id: 'relay-1',
    workspaceId: scope.workspaceId,
    accountId: 'applicant',
    keyPackageHex: 'aa',
    signingPublicKey: hash,
    requestId: '33'.repeat(16),
    source: 'link',
    state: 'pending',
    expiresAt: 1,
    offer: {
      version: 1,
      workspaceId: scope.workspaceId,
      genesisHash: hash,
      genesisRecordHex: 'abcd',
      endorser: hash,
      token: '44'.repeat(32),
      mode: 'link',
      expiresAt: 1,
      signature: '55'.repeat(64),
    },
  };
  let readWorkspace = scope.workspaceId;
  const { network } = fixture(async (name, args) => {
    calls.push({ name, args });
    if (name.endsWith(':pending'))
      return {
        invitations: [],
        items: [
          {
            ...item,
            applicantName: 'Riley',
            applicantEmail: 'r@example.test',
            memberLimitReached: true,
          },
        ],
        hasMore: false,
        seatPreview: { status: 'not_billed', reason: 'free' },
      };
    if (name.endsWith(':read')) return { ...item, workspaceId: readWorkspace };
    throw new Error('unexpected ' + name);
  });
  const access = { workspaceId: scope.workspaceId, credential: 'cc'.repeat(32) };
  const pending = await Effect.runPromise(network.members.pending(access));
  expect(pending.items.map((row) => row.requestId)).toEqual([item.requestId]);
  // The relay's full-workspace hint reaches the approver.
  expect(pending.items[0]).toMatchObject({ memberLimitReached: true });
  expect(calls[0]).toEqual({
    name: 'e2eeMembers:pending',
    args: { workspaceId: scope.workspaceId, credential: access.credential },
  });
  // Another workspace's access never reaches the relay.
  const before = calls.length;
  expect(
    Exit.isFailure(
      await Effect.runPromiseExit(
        network.members.pending({ ...access, workspaceId: 'workspace-B' })
      )
    )
  ).toBe(true);
  expect(calls.length).toBe(before);
  // The relay's invitation copy reaches the session intact: automatic admission verifies
  // it there, so dropping it would silently turn every email invitation explicit.
  expect((await Effect.runPromise(network.members.read(access, item.requestId))).offer).toEqual(
    item.offer
  );
  // A reply naming another workspace is refused before the host sees it.
  readWorkspace = 'workspace-B';
  expect(
    Exit.isFailure(await Effect.runPromiseExit(network.members.read(access, item.requestId)))
  ).toBe(true);
});

it.each(['method_required', 'payment_required', 'refresh'] as const)(
  'keeps the %s action and cost details so encrypted member approval can recover payment',
  async (paymentAction) => {
    const seatPreview = {
      status: 'billed',
      interval: 'month',
      unitAmount: 1000,
      proratedAmount: 500,
      currentPeriodEnd: null,
      seatCount: 1,
      nextSeatCount: 2,
      nextRenewalAmount: 2000,
      currency: 'usd',
      paymentAction,
      addedSeats: 1,
      invoiceAt: null,
    };
    const { network } = fixture(async () => ({
      invitations: [],
      items: [],
      hasMore: false,
      seatPreview,
    }));
    const result = await Effect.runPromise(
      network.members.pending({
        workspaceId: scope.workspaceId,
        credential: 'cc'.repeat(32),
      })
    );
    expect(result.seatPreview).toEqual(seatPreview);
  }
);

it.each([{ paymentAction: 'unknown' }, { addedSeats: 'one' }, { invoiceAt: 'tomorrow' }])(
  'refuses an invalid payment preview before presenting member approval: %j',
  async (invalid) => {
    const { network } = fixture(async () => ({
      invitations: [],
      items: [],
      hasMore: false,
      seatPreview: {
        status: 'billed',
        interval: 'month',
        unitAmount: 1000,
        proratedAmount: 500,
        currentPeriodEnd: null,
        seatCount: 1,
        nextSeatCount: 2,
        nextRenewalAmount: 2000,
        ...invalid,
      },
    }));
    const result = await Effect.runPromiseExit(
      network.members.pending({
        workspaceId: scope.workspaceId,
        credential: 'cc'.repeat(32),
      })
    );
    expect(Exit.isFailure(result)).toBe(true);
  }
);

it('keeps the member list usable when it holds an unsigned or unreadable invitation', async () => {
  const offer = {
    version: 1,
    workspaceId: scope.workspaceId,
    genesisHash: hash,
    genesisRecordHex: 'abcd',
    endorser: hash,
    token: '44'.repeat(32),
    mode: 'email',
    expiresAt: 1,
  };
  const legacy = { ...offer, token: '45'.repeat(32) };
  const item = {
    id: 'relay-1',
    workspaceId: scope.workspaceId,
    accountId: 'applicant',
    keyPackageHex: 'aa',
    signingPublicKey: hash,
    requestId: '33'.repeat(16),
    source: 'email',
    state: 'pending',
    expiresAt: 1,
    offer: { ...offer, signature: '55'.repeat(64) },
    applicantName: 'Riley',
    applicantEmail: 'r@example.test',
  };
  const { network } = fixture(async () => ({
    invitations: [offer, legacy, { token: 'not-an-offer' }],
    unsignedInvitations: [{ token: legacy.token, email: 'legacy@synthetic.test' }],
    items: [item],
    hasMore: false,
    seatPreview: { status: 'not_billed', reason: 'free' },
  }));
  const pending = await Effect.runPromise(
    network.members.pending({ workspaceId: scope.workspaceId, credential: 'cc'.repeat(32) })
  );
  // The applicant stays approvable, the unsigned invitation stays revocable by token and
  // is marked for re-sending, and only the unreadable entry is left out.
  expect(pending.items.map((row) => row.requestId)).toEqual([item.requestId]);
  expect(pending.invitations).toEqual([
    offer,
    { ...legacy, needsReissue: true, email: 'legacy@synthetic.test' },
  ]);
});

it('keeps the code of an invitation refused for a still-waiting applicant', async () => {
  const { network } = fixture(async () => {
    throw Object.assign(new Error('synthetic-private-cause'), {
      data: { code: 'e2ee_member_invitation_request_pending' },
    });
  });
  const exit = await Effect.runPromiseExit(
    network.members.createInvitation(
      { workspaceId: scope.workspaceId, credential: 'cc'.repeat(32) },
      { offer: { version: 1 } as never, email: 'legacy@synthetic.test' }
    )
  );
  expect(Exit.isFailure(exit)).toBe(true);
  const failure = Exit.isFailure(exit) ? Cause.squash(exit.cause) : null;
  expect(failure).toMatchObject({ code: 'e2ee_member_invitation_request_pending' });
  expect(JSON.stringify(failure)).not.toContain('synthetic-private-cause');
});

it('sends the endorser-signed invitation offer to the relay unchanged and keeps its signature', async () => {
  // The relay requires the endorsement to create an invitation (#4287) and returns it to
  // approvers, who verify it before any automatic admission; neither direction may drop it.
  const endorser = await Effect.runPromise(
    Effect.scoped(
      importBrowserDevice({
        signingPrivate: new Uint8Array(32).fill(61),
        encryptionPrivate: new Uint8Array(32).fill(62),
      }).pipe(
        Effect.flatMap((device) =>
          signMemberOffer(
            {
              version: 1,
              workspaceId: scope.workspaceId,
              genesisHash: hash,
              genesisRecordHex: 'abcd',
              endorser: Array.from(device.publicKey.toBytes(), (b) =>
                b.toString(16).padStart(2, '0')
              ).join(''),
              token: '33'.repeat(32),
              mode: 'email',
              expiresAt: 2_000_000_000_000,
            },
            device
          )
        )
      )
    )
  );
  expect(endorser.signature).toMatch(/^[0-9a-f]{128}$/);
  const sent: unknown[] = [];
  const { network } = fixture(async (name, args) => {
    if (name !== 'e2eeMembers:createInvitation') throw new Error('unexpected ' + name);
    sent.push(args);
    return { offer: (args as { offer: unknown }).offer };
  });
  const created = await Effect.runPromise(
    network.members.createInvitation(
      { workspaceId: scope.workspaceId, credential: 'cc'.repeat(32) },
      { offer: endorser, email: 'teammate@example.test' }
    )
  );
  expect(sent).toEqual([
    {
      workspaceId: scope.workspaceId,
      credential: 'cc'.repeat(32),
      offer: endorser,
      email: 'teammate@example.test',
    },
  ]);
  expect(created.offer).toEqual(endorser);
});

// A refused mailbox store stays retryable for core (`unavailable` keeps the task pending and
// resends its original), and still says which refusal it was, never the server's message.
it('keeps the server refusal code of a mailbox call while it stays retryable', async () => {
  const { network } = fixture(async () => {
    throw Object.assign(new Error('synthetic-private-cause'), {
      data: { code: 'e2ee_mailbox_ledger_stale' },
    });
  });
  const exit = await Effect.runPromiseExit(
    network.mailbox('ab'.repeat(32)).put('cd'.repeat(16), new Uint8Array(8))
  );
  expect(Exit.isFailure(exit)).toBe(true);
  const failure = Exit.isFailure(exit) ? Cause.squash(exit.cause) : null;
  expect(failure).toMatchObject({
    _tag: 'BackendError',
    reason: 'unavailable',
    cause: { code: 'e2ee_mailbox_ledger_stale' },
  });
  expect(JSON.stringify(failure)).not.toContain('synthetic-private-cause');
  expect(String((failure as { cause?: unknown }).cause)).not.toContain('synthetic-private-cause');
});

it('joins under the account login only, retires an ended request for a new invitation, and refuses another workspace', async () => {
  const calls: { name: string; args: unknown }[] = [];
  const item = {
    id: 'relay-2',
    workspaceId: scope.workspaceId,
    accountId: 'teammate',
    keyPackageHex: 'bb',
    signingPublicKey: hash,
    requestId: '44'.repeat(16),
    source: 'link',
    state: 'pending',
    expiresAt: 1,
    offer: {
      version: 1,
      workspaceId: scope.workspaceId,
      genesisHash: hash,
      genesisRecordHex: 'abcd',
      endorser: hash,
      token: 'dd'.repeat(32),
      mode: 'link',
      expiresAt: 1,
    },
  };
  let replyWorkspace = scope.workspaceId;
  const { network } = fixture(async (name, args) => {
    calls.push({ name, args });
    if (name.endsWith(':submit') || name.endsWith(':claim'))
      return { ...item, workspaceId: replyWorkspace };
    if (name.endsWith(':retire')) return { state: retireState };
    throw new Error('unexpected ' + name);
  });
  let retireState: string = 'cancelled';
  const submitted = await Effect.runPromise(
    network.members.submit({ token: 'dd'.repeat(32), keyPackageHex: 'bb' })
  );
  expect(submitted.requestId).toBe(item.requestId);
  // No device credential exists before admission; none is sent.
  expect(calls).toEqual([
    { name: 'e2eeMembers:submit', args: { token: 'dd'.repeat(32), keyPackageHex: 'bb' } },
  ]);
  await Effect.runPromise(
    network.members.claim({ workspaceId: scope.workspaceId, requestId: item.requestId })
  );
  expect(calls[1]).toEqual({
    name: 'e2eeMembers:claim',
    args: { workspaceId: scope.workspaceId, requestId: item.requestId },
  });
  // After a refused or expired join, a new invitation first retires the old request.
  // The relay is reached with the login only and its state is reported unchanged.
  await expect(
    Effect.runPromise(network.members.retire({ token: 'dd'.repeat(32), keyPackageHex: 'bb' }))
  ).resolves.toEqual({ state: 'cancelled' });
  expect(calls[2]).toEqual({
    name: 'e2eeMembers:retire',
    args: { token: 'dd'.repeat(32), keyPackageHex: 'bb' },
  });
  // An unknown relay state is refused rather than read as settled.
  retireState = 'settled';
  expect(
    Exit.isFailure(
      await Effect.runPromiseExit(
        network.members.retire({ token: 'dd'.repeat(32), keyPackageHex: 'bb' })
      )
    )
  ).toBe(true);
  const before = calls.length;
  expect(
    Exit.isFailure(
      await Effect.runPromiseExit(
        network.members.claim({ workspaceId: 'workspace-B', requestId: item.requestId })
      )
    )
  ).toBe(true);
  expect(calls.length).toBe(before);
  replyWorkspace = 'workspace-B';
  expect(
    Exit.isFailure(
      await Effect.runPromiseExit(
        network.members.submit({ token: 'dd'.repeat(32), keyPackageHex: 'bb' })
      )
    )
  ).toBe(true);
});

it('binds an approved member to the credential of the package the session listed', async () => {
  const hexOf = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
  const signed = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* importBrowserDevice({
          signingPrivate: new Uint8Array(32).fill(10),
          encryptionPrivate: new Uint8Array(32).fill(9),
        });
        const applicant = yield* importBrowserDevice({
          signingPrivate: new Uint8Array(32).fill(41),
          encryptionPrivate: new Uint8Array(32).fill(42),
        });
        const genesis = yield* signGenesisRecord({
          signer: owner,
          encryptionPublicKey: owner.enc,
          initialKey: Result.getOrThrow(Bytes.epochKey(new Uint8Array(32).fill(7))),
          membershipId: Result.getOrThrow(Bytes.membershipId(new Uint8Array(16).fill(10))),
          userId: Result.getOrThrow(accountUserId('abc')),
        });
        const join = yield* prepareJoinRequest({
          genesis: genesis.genesis,
          requestId: Result.getOrThrow(Bytes.requestId(new Uint8Array(16).fill(0x51))),
          userId: Result.getOrThrow(accountUserId('teammate')),
          encryptionPublicKey: applicant.enc,
          expiresAt: Date.now() + 3_600_000,
          signer: applicant,
        });
        const credentialHash = '33'.repeat(32);
        const binding = yield* signDeviceCredentialBinding({
          genesis: genesis.genesis,
          pairingSessionId: join.requestId.toBytes(),
          signingPublicKey: applicant.publicKey,
          credentialHash: Buffer.from(credentialHash, 'hex'),
          signer: applicant,
        });
        const view = Result.getOrThrow(
          verifyLedger({
            anchor: genesis.genesis,
            records: [genesis.record],
            checkpoint: { length: 1, head: hashRecordBytes(genesis.record) },
          })
        );
        const proposal = Result.getOrThrow(
          prepareLedgerCommand(view, owner.publicKey, {
            _tag: 'AdmitMember',
            membershipId: Result.getOrThrow(Bytes.membershipId(join.requestId.toBytes())),
            request: join,
          })
        );
        return {
          genesis,
          admit: yield* signLedgerRecord(proposal, owner),
          keyPackageHex: encodeMemberKeyPackage({
            request: join,
            credentialHash,
            bindingSignature: binding.toBytes(),
          }),
          credentialHash,
          requestId: hexOf(join.requestId.toBytes()),
          signingPublicKey: hexOf(applicant.publicKey.toBytes()),
        };
      })
    )
  );
  const appended: unknown[] = [];
  const memberScope = { ...scope, genesis: signed.genesis.genesis };
  const invoke = async (name: string, args: unknown) => {
    if (name === 'e2eeWorkspaces:history')
      return {
        workspaceId: scope.workspaceId,
        genesisHash: hexOf(signed.genesis.genesis.toBytes()),
        checkpoint: {
          length: 1,
          headHash: hexOf(hashRecordBytes(signed.genesis.record).toBytes()),
        },
        startIndex: 0,
        recordsHex: [hexOf(signed.genesis.record)],
        position: 'p/1',
        nextCursor: null,
      };
    if (name === 'e2eeMembers:pending')
      return {
        invitations: [],
        items: [
          {
            id: 'relay-1',
            workspaceId: scope.workspaceId,
            accountId: 'teammate',
            keyPackageHex: signed.keyPackageHex,
            signingPublicKey: signed.signingPublicKey,
            requestId: signed.requestId,
            source: 'link',
            state: 'pending',
            expiresAt: 1,
            offer: {
              version: 1,
              workspaceId: scope.workspaceId,
              genesisHash: hexOf(signed.genesis.genesis.toBytes()),
              genesisRecordHex: hexOf(signed.genesis.record),
              endorser: hash,
              token: 'dd'.repeat(32),
              mode: 'link',
              expiresAt: 1,
            },
            applicantName: 'Riley',
            applicantEmail: 'r@example.test',
          },
        ],
        hasMore: false,
        seatPreview: { status: 'not_billed', reason: 'free' },
      };
    if (name === 'e2eeWorkspaces:appendRecord') {
      appended.push(args);
      return {
        status: 'committed',
        recordHash: hexOf(hashRecordBytes(signed.admit).toBytes()),
      };
    }
    throw new Error('unexpected ' + name);
  };
  const client = {
    query: (ref: Parameters<typeof getFunctionName>[0], args: unknown) =>
      invoke(getFunctionName(ref), args),
    mutation: (ref: Parameters<typeof getFunctionName>[0], args: unknown) =>
      invoke(getFunctionName(ref), args),
    action: (ref: Parameters<typeof getFunctionName>[0], args: unknown) =>
      invoke(getFunctionName(ref), args),
  } as unknown as PersonalCloudConnection['client'];
  const network = makePersonalCloudNetwork({
    scope: memberScope,
    client,
    currentAccount: () => Effect.succeed(scope.accountId),
  });
  const append = () =>
    Effect.runPromiseExit(
      network
        .ledger('cc'.repeat(32))
        .log.appendCas(
          signed.genesis.genesis,
          { length: 1, head: hashRecordBytes(signed.genesis.record) },
          signed.admit
        )
    );
  // Never listed by the relay: no credential is known, so nothing is appended unbound.
  expect(Exit.isFailure(await append())).toBe(true);
  expect(appended).toEqual([]);
  await Effect.runPromise(
    network.members.pending({ workspaceId: scope.workspaceId, credential: 'cc'.repeat(32) })
  );
  expect(Exit.isSuccess(await append())).toBe(true);
  expect(appended).toEqual([
    expect.objectContaining({
      workspaceId: scope.workspaceId,
      recordHex: hexOf(signed.admit),
      credentialHash: signed.credentialHash,
    }),
  ]);
});

/** The backend's ConvexError shape: the SDK exposes `errorData` as `data`. */
const refusal = (code: string) =>
  Object.assign(new Error('synthetic-private-message'), { data: { code } });
const page = (recordsHex: string[]) => ({
  workspaceId: scope.workspaceId,
  genesisHash: hash,
  checkpoint: { length: recordsHex.length, headHash: hash },
  startIndex: 0,
  recordsHex,
  position: 'opaque/1',
  nextCursor: null,
});
const failureOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : null;
const causeOf = (exit: Exit.Exit<unknown, unknown>) =>
  (failureOf(exit) as { cause?: unknown } | null)?.cause;

it('a revoked credential still reads the ledger under the account login, so the revocation can be verified', async () => {
  const seen: unknown[] = [];
  const { network } = fixture(async (name, args) => {
    expect(name).toBe('e2eeWorkspaces:history');
    seen.push(args);
    if ((args as { credential?: string }).credential) throw refusal('e2ee_device_revoked');
    return page(['aa', 'bb']);
  });
  const ledger = network.ledger('ab'.repeat(32));
  const read = await Effect.runPromise(ledger.source.readAfter('opaque/0'));
  expect(read.records.map((record) => Buffer.from(record).toString('hex'))).toEqual(['aa', 'bb']);
  // The same page request, first with the credential, then under the account login only.
  expect(seen).toEqual([
    { workspaceId: scope.workspaceId, credential: 'ab'.repeat(32), after: 'opaque/0' },
    { workspaceId: scope.workspaceId, after: 'opaque/0' },
  ]);
  seen.length = 0;
  const log = await Effect.runPromise(ledger.log.read(scope.genesis));
  expect(log.records).toHaveLength(2);
  expect(seen).toEqual([
    { workspaceId: scope.workspaceId, credential: 'ab'.repeat(32) },
    { workspaceId: scope.workspaceId },
  ]);
});

it.each([
  ['a removed membership', 'e2ee_member_removed', true],
  ['a non-terminal refusal', 'e2ee_mailbox_ledger_stale', false],
] as const)(
  '%s never falls back to the account login and keeps only an access refusal as its cause',
  async (_label, code, access) => {
    const seen: unknown[] = [];
    const { network } = fixture(async (_name, args) => {
      seen.push(args);
      throw refusal(code);
    });
    const exit = await Effect.runPromiseExit(
      network.ledger('ab'.repeat(32)).source.readAfter('-1')
    );
    expect(seen).toHaveLength(1);
    expect(failureOf(exit)).toMatchObject({ _tag: 'LedgerFeedError', code: 'native-unavailable' });
    expect(causeOf(exit) instanceof E2eeAccessRefusal).toBe(access);
  }
);

it('keeps the credential refusal when the account-login read also fails', async () => {
  const { network } = fixture(async (_name, args) => {
    if ((args as { credential?: string }).credential) throw refusal('e2ee_device_revoked');
    throw new Error('synthetic offline');
  });
  const exit = await Effect.runPromiseExit(network.ledger('ab'.repeat(32)).source.readAfter('-1'));
  expect(causeOf(exit)).toBeInstanceOf(E2eeAccessRefusal);
  expect(causeOf(exit)).toMatchObject({ code: 'e2ee_device_revoked' });
});

it('only a credential-bound call types its refusal as access loss, and only for the same account', async () => {
  let fail = refusal('e2ee_device_revoked');
  const { network, switchAccount } = fixture(async () => {
    throw fail;
  });
  const grant = () => Effect.runPromiseExit(network.contentToken('ab'.repeat(32), {}));
  const bound = await grant();
  expect(failureOf(bound)).toMatchObject({ _tag: 'BackendError', reason: 'unavailable' });
  expect(causeOf(bound)).toBeInstanceOf(E2eeAccessRefusal);
  const mailbox = await Effect.runPromiseExit(
    network.mailbox('ab'.repeat(32)).read('cd'.repeat(16))
  );
  expect(causeOf(mailbox)).toBeInstanceOf(E2eeAccessRefusal);
  // The same code from an account-login endpoint is a plain refusal.
  const join = await Effect.runPromiseExit(network.remote.exchange(request));
  expect(causeOf(join)).toBeInstanceOf(BackendRefusal);
  expect(causeOf(join)).not.toBeInstanceOf(E2eeAccessRefusal);
  const history = await Effect.runPromiseExit(network.allHistory());
  expect(causeOf(history)).not.toBeInstanceOf(E2eeAccessRefusal);
  // A message that merely says so is not a parsed refusal.
  fail = new Error('e2ee_device_revoked') as typeof fail;
  expect(causeOf(await grant())).toBeUndefined();
  // A login switch while the refusal arrives proves nothing about this device.
  fail = refusal('e2ee_device_revoked');
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const switching = fixture(async () => {
    await held;
    throw fail;
  });
  const pending = Effect.runPromiseExit(switching.network.contentToken('ab'.repeat(32), {}));
  switching.switchAccount('account-B');
  release();
  const switched = await pending;
  expect(failureOf(switched)).toMatchObject({ reason: 'unauthorized' });
  expect(causeOf(switched)).toBeUndefined();
  switchAccount(scope.accountId);
});

it.each(['query', 'mutation', 'action'] as const)(
  'an unanswered %s fails as retryable unavailable within thirty seconds and the retry succeeds',
  async (kind) => {
    const clock = ManagedRuntime.make(TestClock.layer({ warningDelay: '1 hour' }));
    try {
      await clock.context();
      let hang = true,
        entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const answer = async (): Promise<unknown> => {
        if (!hang) return kind === 'action' ? page(['aa']) : null;
        entered();
        return new Promise(() => {});
      };
      const client = {
        query: answer,
        mutation: answer,
        action: answer,
      } as unknown as PersonalCloudConnection['client'];
      const network = makePersonalCloudNetwork({
        scope,
        client,
        currentAccount: () => Effect.succeed(scope.accountId),
      });
      const call = () =>
        kind === 'query'
          ? network.mailbox('ab'.repeat(32)).read('cd'.repeat(16))
          : kind === 'mutation'
            ? network.mailbox('ab'.repeat(32)).put('cd'.repeat(16), new Uint8Array(8))
            : network.allHistory('ab'.repeat(32));
      const pending = clock.runPromiseExit(call());
      await started;
      await clock.runPromise(TestClock.adjust(29_999));
      // Still waiting just short of the bound: give an early timeout a full task turn to land.
      const early = await Promise.race([
        pending.then(() => 'settled'),
        new Promise((resolve) => setTimeout(resolve, 0)).then(() => 'waiting'),
      ]);
      expect(early).toBe('waiting');
      await clock.runPromise(TestClock.adjust(1));
      const exit = await pending;
      expect(failureOf(exit)).toMatchObject({ _tag: 'BackendError', reason: 'unavailable' });
      // Outcome unknown: never access loss, so the pairing and originals stay as they were.
      expect(causeOf(exit)).toBeUndefined();
      hang = false;
      expect(Exit.isSuccess(await clock.runPromiseExit(call()))).toBe(true);
    } finally {
      await clock.dispose();
    }
  }
);

/** Real signed originals keep this transport test at the public ledger boundary. */
async function appendOriginal() {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* importBrowserDevice({
          signingPrivate: new Uint8Array(32).fill(10),
          encryptionPrivate: new Uint8Array(32).fill(9),
        });
        const genesis = yield* signGenesisRecord({
          signer: owner,
          encryptionPublicKey: owner.enc,
          initialKey: Result.getOrThrow(Bytes.epochKey(new Uint8Array(32).fill(7))),
          membershipId: Result.getOrThrow(Bytes.membershipId(new Uint8Array(16).fill(10))),
          userId: Result.getOrThrow(accountUserId('abc')),
        });
        const expected = { length: 1, head: hashRecordBytes(genesis.record) };
        const view = Result.getOrThrow(
          verifyLedger({ anchor: genesis.genesis, records: [genesis.record], checkpoint: expected })
        );
        const proposal = Result.getOrThrow(
          prepareLedgerCommand(view, owner.publicKey, {
            _tag: 'DeclareCapabilities',
            capabilities: [1],
          })
        );
        const record = yield* signLedgerRecord(proposal, owner);
        const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
        return {
          scope: { ...scope, genesis: genesis.genesis },
          expected,
          record,
          genesisRecord: genesis.record,
          genesisRecordHex: hex(genesis.record),
          id: hex(hashRecordBytes(record).toBytes()),
          inline: {
            workspaceId: scope.workspaceId,
            genesisHash: hex(genesis.genesis.toBytes()),
            checkpoint: { length: 2, headHash: hex(hashRecordBytes(record).toBytes()) },
            startIndex: 1,
            recordsHex: [hex(record)],
            position: `p1:${scope.workspaceId}:2:tail:0`,
            nextCursor: null,
            ledgerCapacity: { limitBytes: 8388608 },
          },
        };
      })
    )
  );
}

it.each([true, false])(
  'governance verifies only the suffix after its feed checkpoint and reuses the append page (inline=%s)',
  async (inline) => {
    const f = await appendOriginal();
    const calls: Array<{ name: string; args: unknown }> = [];
    let appended = false;
    const position = `p1:${scope.workspaceId}:1:genesis-tail:0`;
    const { network, switchAccount } = fixture(async (name, args) => {
      calls.push({ name, args });
      if (name === 'e2eeWorkspaces:appendRecord') {
        appended = true;
        return {
          status: 'committed',
          recordHash: f.id,
          ...(inline ? { historyPage: f.inline } : {}),
        };
      }
      if (appended) {
        expect(args).toMatchObject({ after: position });
        return f.inline;
      }
      return {
        ...f.inline,
        startIndex: 0,
        recordsHex: [f.genesisRecordHex],
        position,
        checkpoint: { length: 1, headHash: Buffer.from(f.expected.head.toBytes()).toString('hex') },
      };
    }, f.scope);
    const ledger = network.ledger('cc'.repeat(32));
    await Effect.runPromise(ledger.source.readAfter('-1'));
    const base = Result.getOrThrow(
      verifyLedger({ anchor: f.scope.genesis, records: [f.genesisRecord], checkpoint: f.expected })
    );
    await Effect.runPromise(ledger.log.appendCas(f.scope.genesis, f.expected, f.record));
    const suffix = await Effect.runPromise(ledger.log.readFrom!(f.scope.genesis, base));
    const verified = Result.getOrThrow(
      verifyLedger({
        anchor: f.scope.genesis,
        records: [f.genesisRecord, ...suffix.records],
        checkpoint: suffix.checkpoint,
      })
    );
    expect(verified.length).toBe(2);
    expect(verified.head.equals(hashRecordBytes(f.record))).toBe(true);
    const fed = await Effect.runPromise(ledger.source.readAfter(position));
    expect(fed.records).toEqual([f.record]);
    expect(calls).toHaveLength(inline ? 2 : 3);
    switchAccount('account-B');
    expect(
      Exit.isFailure(await Effect.runPromiseExit(ledger.log.readFrom!(f.scope.genesis, base)))
    ).toBe(true);
  }
);

it.each([
  [1_800_000_000_000, { reason: 'self-service-rate-limited', retryAt: 1_800_000_000_000 }],
  ['soon', {}],
] as const)(
  'maps the ledger self-service quota refusal to its core reason (retryAt=%j)',
  async (retryAt, expected) => {
    const f = await appendOriginal();
    const calls: string[] = [];
    const { network } = fixture(async (name) => {
      calls.push(name);
      throw Object.assign(new Error('synthetic-private-cause'), {
        data: { code: 'e2ee_self_service_rate_limited', retryAt },
      });
    }, f.scope);
    const exit = await Effect.runPromiseExit(
      network.ledger('cc'.repeat(32)).log.appendCas(f.scope.genesis, f.expected, f.record)
    );
    const failure = failureOf(exit) as { _tag?: string; reason?: string; retryAt?: number };
    expect(failure._tag).toBe('LedgerLogError');
    expect({ reason: failure.reason, retryAt: failure.retryAt }).toEqual({
      reason: undefined,
      retryAt: undefined,
      ...expected,
    });
    expect(calls).toEqual(['e2eeWorkspaces:appendRecord']);
  }
);

it.each(['committed', 'conflict'] as const)(
  '%s append skips the genesis prefetch and supplies one signed inline page to the next matching feed read',
  async (status) => {
    const f = await appendOriginal();
    const calls: { name: string; args: unknown }[] = [];
    const { network } = fixture(async (name, args) => {
      calls.push({ name, args });
      if (name === 'e2eeWorkspaces:appendRecord')
        return { status, recordHash: f.id, historyPage: f.inline };
      return { ...f.inline, startIndex: 2, recordsHex: [], position: 'remote-tail' };
    }, f.scope);
    const ledger = network.ledger('cc'.repeat(32));
    const appended = await Effect.runPromiseExit(
      ledger.log.appendCas(f.scope.genesis, f.expected, f.record)
    );
    expect(Exit.isSuccess(appended)).toBe(status === 'committed');
    if (status === 'conflict')
      expect(failureOf(appended)).toMatchObject({ _tag: 'LedgerLogError' });
    expect(calls.map((call) => call.name)).toEqual(['e2eeWorkspaces:appendRecord']);
    const offset = `p1:${scope.workspaceId}:1:original-tail:0`;
    const inline = await Effect.runPromise(ledger.source.readAfter(offset));
    expect(inline).toEqual({
      requestOffset: offset,
      nextOffset: f.inline.position,
      records: [f.record],
      upToDate: true,
    });
    expect(calls).toHaveLength(1);
    // Consumed pages are not replayed, even if the caller asks for the same position.
    const remote = await Effect.runPromise(ledger.source.readAfter(offset));
    expect(remote.nextOffset).toBe('remote-tail');
    expect(calls[1]).toEqual({
      name: 'e2eeWorkspaces:history',
      args: { workspaceId: scope.workspaceId, credential: 'cc'.repeat(32), after: offset },
    });
  }
);

it.each([
  'missing',
  'malformed',
  'workspace',
  'genesis',
  'empty',
  'start',
  'offset',
  'recordHash',
] as const)(
  'an unusable %s inline hint preserves the append verdict and falls back to credential-bound history',
  async (variant) => {
    const f = await appendOriginal();
    const inline =
      variant === 'missing'
        ? undefined
        : variant === 'malformed'
          ? { ...f.inline, recordsHex: ['zz'] }
          : variant === 'workspace'
            ? { ...f.inline, workspaceId: 'workspace-B' }
            : variant === 'genesis'
              ? { ...f.inline, genesisHash: 'ff'.repeat(32) }
              : variant === 'empty'
                ? { ...f.inline, recordsHex: [] }
                : variant === 'start'
                  ? { ...f.inline, startIndex: 0 }
                  : f.inline;
    const calls: string[] = [];
    const { network } = fixture(async (name) => {
      calls.push(name);
      return name === 'e2eeWorkspaces:appendRecord'
        ? {
            status: 'committed',
            recordHash: variant === 'recordHash' ? 'ff'.repeat(32) : f.id,
            historyPage: inline,
          }
        : { ...f.inline, position: 'remote-tail' };
    }, f.scope);
    const ledger = network.ledger('cc'.repeat(32));
    const appended = await Effect.runPromiseExit(
      ledger.log.appendCas(f.scope.genesis, f.expected, f.record)
    );
    expect(Exit.isSuccess(appended)).toBe(variant !== 'recordHash');
    const offset = `p1:${scope.workspaceId}:${variant === 'offset' ? 0 : 1}:original-tail:0`;
    const read = await Effect.runPromise(ledger.source.readAfter(offset));
    expect(read.nextOffset).toBe('remote-tail');
    expect(calls).toEqual(['e2eeWorkspaces:appendRecord', 'e2eeWorkspaces:history']);
    if (variant === 'offset') {
      // A mismatch consumes the hint too; it cannot leak into a later matching read.
      await Effect.runPromise(ledger.source.readAfter(`p1:${scope.workspaceId}:1:original-tail:0`));
      expect(calls).toHaveLength(3);
    }
  }
);

it('cached inline history still rejects an account switch before any record leaves the transport', async () => {
  const f = await appendOriginal();
  const { network, switchAccount } = fixture(
    async () => ({ status: 'committed', recordHash: f.id, historyPage: f.inline }),
    f.scope
  );
  const ledger = network.ledger('cc'.repeat(32));
  await Effect.runPromise(ledger.log.appendCas(f.scope.genesis, f.expected, f.record));
  switchAccount('account-B');
  const read = await Effect.runPromiseExit(
    ledger.source.readAfter(`p1:${scope.workspaceId}:1:original-tail:0`)
  );
  expect(failureOf(read)).toMatchObject({ _tag: 'LedgerFeedError', code: 'native-unavailable' });
});

function syntheticStagedGroup() {
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.alloc(32, 17),
    ]),
    format: 'der',
    type: 'pkcs8',
  });
  const signer = new Uint8Array(
    createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32)
  );
  const commitment = '44'.repeat(32);
  const body = [
    new Uint8Array(32).fill(2),
    signer,
    [7, 1, new Uint8Array(32).fill(0x44), new Uint8Array(72).fill(5)],
  ];
  const record = Result.getOrThrow(
    encodeCbor([
      body,
      new Uint8Array(
        sign(null, recordSigningBytes(Result.getOrThrow(encodeCbor(body))), privateKey)
      ),
    ])
  );
  const aad = Result.getOrThrow(encodeCbor([new Uint8Array(32).fill(0x11), 1, signer, signer]));
  const envelope = Buffer.concat([aad, Buffer.alloc(80, 6)]);
  const frame = new Uint8Array(
    Buffer.concat([
      envelope,
      sign(null, Buffer.concat([Buffer.from('lody-e2ee/epoch-env/v1\0'), envelope]), privateKey),
    ])
  );
  return {
    genesis: hash,
    epoch: 1,
    commitment,
    recordHash: Buffer.from(hashRecordBytes(record).toBytes()).toString('hex'),
    record,
    envelopes: [{ recipient: Buffer.from(signer).toString('hex'), frame }],
  };
}

it('consumes inline mailbox put and epoch staging readbacks once, falls back on older backends, and still guards account switches', async () => {
  const group = syntheticStagedGroup();
  const dto = encodeEpochStagedGroup(group);
  const frame = new Uint8Array([1, 2, 3, 4]);
  const frameHex = '01020304';
  const id = 'ab'.repeat(16);
  const target = { genesis: hash, epoch: 0, recipient: '22'.repeat(32) };

  for (const deployed of [true, false]) {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const { network, switchAccount } = fixture(async (name, rawArgs) => {
      const args = rawArgs as Record<string, unknown>;
      calls.push({ name, args });
      if (name === 'e2eeMailbox:put') {
        if (args.includeReceipt && !deployed)
          throw new Error(
            'ArgumentValidationError: Object contains extra field `includeReceipt` that is not in the validator.'
          );
        return deployed
          ? { frameHex, slot: { ...target, revision: 0, status: 'EnvelopeStored' } }
          : null;
      }
      if (name === 'e2eeMailbox:read') return frameHex;
      if (name === 'e2eeMailbox:status')
        return { ...target, revision: 0, status: 'EnvelopeStored' };
      if (name === 'e2eeEpochStaging:stageGroup') {
        if (args.includeReadback && !deployed)
          throw new Error(
            'ArgumentValidationError: Object contains extra field `includeReadback` that is not in the validator.'
          );
        return deployed ? { ok: true, group: dto } : { ok: true };
      }
      if (name === 'e2eeEpochStaging:readGroup') return dto;
      throw new Error(`unexpected call ${name}`);
    });

    const mailbox = network.mailbox('cc'.repeat(32));
    await Effect.runPromise(mailbox.put(id, frame));
    expect(await Effect.runPromise(mailbox.read(id))).toEqual(frame);
    expect(await Effect.runPromise(mailbox.status(target))).toEqual({
      ...target,
      revision: 0,
      status: 'EnvelopeStored',
    });
    // Single-use: second read and status go back to the server.
    expect(await Effect.runPromise(mailbox.read(id))).toEqual(frame);
    expect(await Effect.runPromise(mailbox.status(target))).toEqual({
      ...target,
      revision: 0,
      status: 'EnvelopeStored',
    });
    await Effect.runPromise(mailbox.put(id, frame));

    await Effect.runPromise(network.staging('cc'.repeat(32)).stageGroup(group));
    const read1 = await Effect.runPromise(network.staging('cc'.repeat(32)).readGroup(dto));
    expect(read1 && encodeEpochStagedGroup(read1)).toEqual(dto);
    const read2 = await Effect.runPromise(network.staging('cc'.repeat(32)).readGroup(dto));
    expect(read2 && encodeEpochStagedGroup(read2)).toEqual(dto);
    await Effect.runPromise(network.staging('cc'.repeat(32)).stageGroup(group));

    if (deployed) {
      expect(calls.map((c) => c.name)).toEqual([
        'e2eeMailbox:put',
        'e2eeMailbox:read',
        'e2eeMailbox:status',
        'e2eeMailbox:put',
        'e2eeEpochStaging:stageGroup',
        'e2eeEpochStaging:readGroup',
        'e2eeEpochStaging:stageGroup',
      ]);
      // Cached receipt from the second put still enforces the account guard.
      switchAccount('account-B');
      const guardedRead = await Effect.runPromiseExit(mailbox.read(id));
      expect(failureOf(guardedRead)).toMatchObject({ reason: 'unauthorized' });
    } else {
      expect(
        calls.filter((c) => c.name === 'e2eeMailbox:put').map((c) => c.args.includeReceipt ?? null)
      ).toEqual([true, null, null]);
      expect(
        calls
          .filter((c) => c.name === 'e2eeEpochStaging:stageGroup')
          .map((c) => c.args.includeReadback ?? null)
      ).toEqual([true, null, null]);
    }
  }
});

it('primes self mailbox status from fetch inline slot, invalidates on report/repair/put, and ignores invalid slots', async () => {
  const selfSlot = { genesis: hash, epoch: 1, recipient: '22'.repeat(32) };
  const otherGenesisSlot = { genesis: '99'.repeat(32), epoch: 1, recipient: '22'.repeat(32) };
  const wrongEpochSlot = { genesis: hash, epoch: 2, recipient: '22'.repeat(32) };
  const id = 'ab'.repeat(16);
  const frame = new Uint8Array([1, 2, 3, 4]);
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let fetchMode: 'valid' | 'malformed' | 'wrong-epoch' | 'wrong-genesis' | 'unsupported' = 'valid';
  let statusCalls = 0;

  const { network, switchAccount } = fixture(async (name, rawArgs) => {
    const args = rawArgs as Record<string, unknown>;
    calls.push({ name, args });
    if (name === 'e2eeMailbox:fetch') {
      if (fetchMode === 'unsupported' && args.includeSlot) {
        throw new Error(
          'ArgumentValidationError: Object contains extra field `includeSlot` that is not in the validator.'
        );
      }
      if (fetchMode === 'malformed') {
        return { items: [], next: null, slot: { invalid: true } };
      }
      if (fetchMode === 'wrong-epoch') {
        return {
          items: [],
          next: null,
          slot: { ...wrongEpochSlot, revision: 0, status: 'NeedsEnvelope' },
        };
      }
      if (fetchMode === 'wrong-genesis') {
        return {
          items: [],
          next: null,
          slot: { ...otherGenesisSlot, revision: 0, status: 'NeedsEnvelope' },
        };
      }
      return {
        items: [{ sender: '11'.repeat(32), frameHex: '01020304' }],
        next: null,
        ...(args.includeSlot
          ? { slot: { ...selfSlot, revision: 3, status: 'EnvelopeStored' } }
          : {}),
      };
    }
    if (name === 'e2eeMailbox:status') {
      statusCalls += 1;
      return { ...selfSlot, revision: 3 + statusCalls, status: 'EnvelopeStored' };
    }
    if (name === 'e2eeMailbox:report') return null;
    if (name === 'e2eeMailbox:repair') return null;
    if (name === 'e2eeMailbox:put') return null;
    throw new Error(`unexpected call ${name}`);
  });

  const mailbox = network.mailbox('cc'.repeat(32));

  // Malformed, wrong-epoch, and wrong-genesis inline slots are ignored without failing fetch.
  for (const mode of ['malformed', 'wrong-epoch', 'wrong-genesis'] as const) {
    fetchMode = mode;
    await Effect.runPromise(mailbox.fetch(1, null, 10));
  }
  const missAfterInvalid = await Effect.runPromise(mailbox.status(selfSlot));
  expect(missAfterInvalid.revision).toBe(4);
  expect(statusCalls).toBe(1);

  // Put (null receipt) invalidates cache.
  await Effect.runPromise(mailbox.put(id, frame));

  // Valid fetch primes selfStatusCache: status hits cache with 0 server queries.
  fetchMode = 'valid';
  const fetched = await Effect.runPromise(mailbox.fetch(1, null, 10));
  expect(fetched.items).toHaveLength(1);
  expect(await Effect.runPromise(mailbox.status(selfSlot))).toEqual({
    ...selfSlot,
    revision: 3,
    status: 'EnvelopeStored',
  });
  expect(statusCalls).toBe(1);

  // Account switch still blocks cached status.
  switchAccount('account-B');
  const blocked = await Effect.runPromiseExit(mailbox.status(selfSlot));
  expect(failureOf(blocked)).toMatchObject({ reason: 'unauthorized' });
  switchAccount('account-A');

  // Report invalidates selfStatusCache.
  await Effect.runPromise(mailbox.report(new Uint8Array([9, 9])));
  const afterReport = await Effect.runPromise(mailbox.status(selfSlot));
  expect(afterReport.revision).toBe(5);
  expect(statusCalls).toBe(2);

  // Repair invalidates selfStatusCache / withinRoundCache.
  await Effect.runPromise(mailbox.fetch(1, null, 10));
  expect((await Effect.runPromise(mailbox.status(selfSlot))).revision).toBe(3);
  await Effect.runPromise(mailbox.repair(selfSlot, id));
  const afterRepair = await Effect.runPromise(mailbox.status(selfSlot));
  expect(afterRepair.revision).toBe(6);
  expect(statusCalls).toBe(3);

  // Older backends rejecting includeSlot fall back cleanly and remember unsupported.
  fetchMode = 'unsupported';
  await Effect.runPromise(mailbox.fetch(1, null, 10));
  await Effect.runPromise(mailbox.fetch(1, null, 10));
  const fetchArgs = calls
    .filter((c) => c.name === 'e2eeMailbox:fetch')
    .map((c) => c.args.includeSlot ?? null);
  expect(fetchArgs.slice(-3)).toEqual([true, null, null]);
});

it('coalesces concurrent mailbox status calls via batchStatus, preserves errors, and falls back when unsupported', async () => {
  const targetA = { genesis: hash, epoch: 1, recipient: '22'.repeat(32) };
  const targetB = { genesis: hash, epoch: 1, recipient: '33'.repeat(32) };
  const targetC = { genesis: hash, epoch: 1, recipient: '44'.repeat(32) };

  // Supported backend: concurrent calls batch, single call uses status.
  {
    const calls: string[] = [];
    const { network } = fixture(async (name, rawArgs) => {
      calls.push(name);
      const args = rawArgs as Record<string, unknown>;
      if (name === 'e2eeMailbox:batchStatus') {
        const slots = args.slots as Array<typeof targetA>;
        return slots.map((s, index) => ({ ...s, revision: index + 1, status: 'NeedsEnvelope' }));
      }
      if (name === 'e2eeMailbox:status') {
        const s = args.slot as typeof targetC;
        return { ...s, revision: 9, status: 'NeedsEnvelope' };
      }
      throw new Error(`unexpected call ${name}`);
    });
    const mailbox = network.mailbox('cc'.repeat(32));
    const [resA, resB] = await Promise.all([
      Effect.runPromise(mailbox.status(targetA)),
      Effect.runPromise(mailbox.status(targetB)),
    ]);
    expect(resA).toEqual({ ...targetA, revision: 1, status: 'NeedsEnvelope' });
    expect(resB).toEqual({ ...targetB, revision: 2, status: 'NeedsEnvelope' });
    const resC = await Effect.runPromise(mailbox.status(targetC));
    expect(resC).toEqual({ ...targetC, revision: 9, status: 'NeedsEnvelope' });
    expect(calls).toEqual(['e2eeMailbox:batchStatus', 'e2eeMailbox:status']);
  }

  // Access refusal from batchStatus preserves E2eeAccessRefusal instead of falling back.
  {
    const calls: string[] = [];
    const { network } = fixture(async (name) => {
      calls.push(name);
      if (name === 'e2eeMailbox:batchStatus') {
        throw Object.assign(new Error('device revoked'), { data: { code: 'e2ee_device_revoked' } });
      }
      throw new Error(`unexpected call ${name}`);
    });
    const mailbox = network.mailbox('cc'.repeat(32));
    const [exitA, exitB] = await Promise.all([
      Effect.runPromiseExit(mailbox.status(targetA)),
      Effect.runPromiseExit(mailbox.status(targetB)),
    ]);
    expect(failureOf(exitA)).toMatchObject({
      reason: 'unavailable',
      cause: { code: 'e2ee_device_revoked' },
    });
    expect(failureOf(exitB)).toMatchObject({
      reason: 'unavailable',
      cause: { code: 'e2ee_device_revoked' },
    });
    expect(calls).toEqual(['e2eeMailbox:batchStatus']);
  }

  // Unsupported backend: batchStatus is tried once then subsequent concurrent calls use status directly.
  {
    const calls: string[] = [];
    const { network } = fixture(async (name, rawArgs) => {
      calls.push(name);
      const args = rawArgs as Record<string, unknown>;
      if (name === 'e2eeMailbox:batchStatus') {
        throw new Error(
          '[Request ID: 1] Could not find public function for e2eeMailbox:batchStatus'
        );
      }
      if (name === 'e2eeMailbox:status') {
        const s = args.slot as typeof targetA;
        return { ...s, revision: 7, status: 'NeedsEnvelope' };
      }
      throw new Error(`unexpected call ${name}`);
    });
    const mailbox = network.mailbox('cc'.repeat(32));
    const [r1, r2] = await Promise.all([
      Effect.runPromise(mailbox.status(targetA)),
      Effect.runPromise(mailbox.status(targetB)),
    ]);
    expect(r1.revision).toBe(7);
    expect(r2.revision).toBe(7);
    await Promise.all([
      Effect.runPromise(mailbox.status(targetA)),
      Effect.runPromise(mailbox.status(targetC)),
    ]);
    expect(calls).toEqual([
      'e2eeMailbox:batchStatus',
      'e2eeMailbox:status',
      'e2eeMailbox:status',
      'e2eeMailbox:status',
    ]);
  }
});

it('accepts https and loopback http content gateway URLs while rejecting remote plain http', async () => {
  for (const [gatewayBaseUrl, ok] of [
    ['https://streams.example.test', true],
    ['http://127.0.0.1:25081', true],
    ['http://localhost:8787', true],
    ['http://[::1]:8787', true],
    ['http://streams.example.test', false],
  ] as const) {
    const { network } = fixture(async () => ({
      token: 'ordinary',
      bucketId: 'ws-bucket-1',
      gatewayBaseUrl,
      expiresAt: 1000,
      expiresIn: 900,
    }));
    const exit = await Effect.runPromiseExit(network.contentToken('ab'.repeat(32), {}));
    expect(Exit.isSuccess(exit)).toBe(ok);
  }
});

it('after workspace creation, appendCas then readAfter(-1) consumes inline record 1 with pinned genesis without a history action', async () => {
  const f = await appendOriginal();
  const calls: string[] = [];
  const { network } = fixture(
    async (name) => {
      calls.push(name);
      return { status: 'committed', recordHash: f.id, historyPage: f.inline };
    },
    f.scope,
    { genesisRecordHex: f.genesisRecordHex }
  );
  const ledger = network.ledger('cc'.repeat(32));
  await Effect.runPromise(ledger.log.appendCas(f.scope.genesis, f.expected, f.record));
  const page = await Effect.runPromise(ledger.source.readAfter('-1'));
  expect(page.records).toEqual([f.genesisRecord, f.record]);
  expect(page.requestOffset).toBe('-1');
  expect(page.nextOffset).toBe(f.inline.position);
  expect(
    Result.isSuccess(
      verifyLedger({
        anchor: f.scope.genesis,
        records: page.records,
        checkpoint: { length: 2, head: hashRecordBytes(f.record) },
      })
    )
  ).toBe(true);
  expect(calls).toEqual(['e2eeWorkspaces:appendRecord']);
});

it.each([undefined, 'zz', 'ordinary', 'wrong-pin'])(
  'missing or invalid pinned genesis %s keeps bootstrap history fallback',
  async (genesisRecordHex) => {
    const f = await appendOriginal();
    const calls: string[] = [];
    const { network } = fixture(
      async (name) => {
        calls.push(name);
        return name === 'e2eeWorkspaces:appendRecord'
          ? { status: 'committed', recordHash: f.id, historyPage: f.inline }
          : {
              ...f.inline,
              startIndex: 0,
              recordsHex: [f.genesisRecordHex, ...f.inline.recordsHex],
            };
      },
      f.scope,
      {
        genesisRecordHex:
          genesisRecordHex === 'ordinary'
            ? Buffer.from(f.record).toString('hex')
            : genesisRecordHex === 'wrong-pin'
              ? f.genesisRecordHex.slice(0, -2) + (f.genesisRecordHex.endsWith('00') ? '01' : '00')
              : genesisRecordHex,
      }
    );
    const ledger = network.ledger('cc'.repeat(32));
    await Effect.runPromise(ledger.log.appendCas(f.scope.genesis, f.expected, f.record));
    expect((await Effect.runPromise(ledger.source.readAfter('-1'))).records).toEqual([
      f.genesisRecord,
      f.record,
    ]);
    expect(calls).toEqual(['e2eeWorkspaces:appendRecord', 'e2eeWorkspaces:history']);
  }
);
