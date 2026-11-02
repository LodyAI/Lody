import { Effect, Exit } from 'effect';
import { describe, expect, it } from 'vitest';
import { hashRecordBytes } from '@lody/e2ee-core/protocol';
import { envelopeFixture } from '../../e2ee-core/test/keys/fixture';
import {
  makeAccountE2eeRuntime,
  makePortableAccountPairingRequester,
  type AccountPairingIdentityHost,
} from '../src/account-requester';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

/** A real signed ledger: the owner's genesis, then the owner admitting a personal phone. */
function fixture() {
  const f = envelopeFixture();
  const genesisHash = hex(f.context.genesis.toBytes());
  const page = {
    workspaceId: 'w1',
    genesisHash,
    checkpoint: { length: f.records().length, headHash: hex(f.view().head.toBytes()) },
    startIndex: 0,
    recordsHex: f.records().map(hex),
    position: 'opaque/final',
    nextCursor: null,
  };
  const [[membershipId, member]] = [...f.view().inspectState().members.entries()];
  const calls: { kind: string; value?: unknown }[] = [];
  let pending: { pairingSessionId: string } | null = null;
  const host: AccountPairingIdentityHost = {
    workspaceId: 'w1',
    genesisHash,
    prepareAccountIdentity: (pin) =>
      Effect.sync(() => {
        calls.push({ kind: 'prepare', value: pin });
        return {
          signingPublicKey: new Uint8Array(32).fill(1),
          encryptionPublicKey: new Uint8Array(32).fill(2),
          possessionProof: new Uint8Array(64).fill(3),
          credentialHash: new Uint8Array(32).fill(4),
        };
      }),
    pendingPersonalJoin: () => Effect.succeed(pending),
    acceptAccountInvitation: (value) =>
      Effect.sync(() => void calls.push({ kind: 'accept', value })),
    activate: () => Effect.sync(() => void calls.push({ kind: 'activate' })),
  };
  const requester = (cryptoUserId = hex(member!.userId.toBytes())) =>
    makePortableAccountPairingRequester({
      workspaces: () => [{ workspaceId: 'w1', name: 'Alpha', genesisHash }],
      host: () => Effect.succeed(host),
      history: () => Effect.succeed(page),
      accountIdentity: () => Effect.succeed({ cryptoUserId }),
    });
  return {
    f,
    calls,
    requester,
    membershipId: membershipId!,
    setPending: (value: typeof pending) => (pending = value),
  };
}

describe('portable account pairing requester', () => {
  it('proves possession for the membership the verified history gives this account', async () => {
    const { f, calls, requester, membershipId } = fixture();
    const [workspace] = await Effect.runPromise(requester()());
    await Effect.runPromise(workspace!.identity());
    expect(calls).toEqual([
      { kind: 'prepare', value: { genesisRecordHex: hex(f.genesisRecord), membershipId } },
    ]);
    // A service naming another crypto user finds no membership and prepares nothing.
    const [other] = await Effect.runPromise(requester('ff'.repeat(32))());
    const refused = await Effect.runPromiseExit(other!.identity());
    expect(Exit.isFailure(refused)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('installs with the signer of the authenticated admission record as endorser, then activates', async () => {
    const { f, calls, requester, membershipId } = fixture();
    const [workspace] = await Effect.runPromise(requester()());
    const admission = f.records().at(-1)!;
    const recordHash = hashRecordBytes(admission).toBytes();
    await Effect.runPromise(workspace!.accept(new Uint8Array([9, 9]), recordHash));
    expect(calls).toEqual([
      {
        kind: 'accept',
        value: {
          invitationHex: '0909',
          endorser: hex(f.owner.raw),
          genesisRecordHex: hex(f.genesisRecord),
          membershipId,
          pairingSessionId: hex(recordHash).slice(0, 32),
        },
      },
      { kind: 'activate' },
    ]);
  });

  it('refuses a record hash missing from the verified history and an unrelated pending join', async () => {
    const { f, calls, requester, setPending } = fixture();
    const [workspace] = await Effect.runPromise(requester()());
    const missing = await Effect.runPromiseExit(
      workspace!.accept(new Uint8Array([1]), new Uint8Array(32).fill(7))
    );
    expect(Exit.isFailure(missing)).toBe(true);
    setPending({ pairingSessionId: 'aa'.repeat(16) });
    const blocked = await Effect.runPromiseExit(
      workspace!.accept(new Uint8Array([1]), hashRecordBytes(f.records().at(-1)!).toBytes())
    );
    expect(JSON.stringify(blocked)).toContain('pairing-journal-busy');
    expect(calls).toEqual([]);
  });
});

describe('account-level runtime', () => {
  it('routes listed methods by workspace and advertises nothing else', async () => {
    const seen: string[] = [];
    const runtime = makeAccountE2eeRuntime({
      methods: ['status', 'preparePersonalJoin'],
      account: async () => null,
      runtimeFor: (workspaceId) =>
        workspaceId === 'w1'
          ? ({
              status: async (id: string) => (seen.push(`status:${id}`), { workspaceId: id }),
              preparePersonalJoin: async (offer: { workspaceId: string }) => (
                seen.push(`prepare:${offer.workspaceId}`),
                { pairingSessionId: 'p', signingPublicKey: 'k', status: 'pending' }
              ),
            } as never)
          : undefined,
    });
    await runtime.status!('w1');
    await runtime.preparePersonalJoin!({ workspaceId: 'w1' } as never);
    expect(seen).toEqual(['status:w1', 'prepare:w1']);
    await expect(runtime.status!('w2')).rejects.toMatchObject({ code: 'unsupported' });
    expect('revokeDevice' in runtime).toBe(false);
    expect('requestAccountPairing' in runtime).toBe(false);
  });
});
