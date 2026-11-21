import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Effect, Exit, Result, Scope, ManagedRuntime } from 'effect';
import { TestClock } from 'effect/testing';
import { ConvexHttpClient } from 'convex/browser';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import {
  createStore,
  type PlatformSessionState,
  type E2eeWorkspaceRuntime,
  type E2eeContentSeal,
  type E2eeContentOpen,
} from '@lody/platform';
import { importBrowserDevice } from '@lody/e2ee-core/adapters/browser-crypto';
import {
  Bytes,
  signGenesisRecord,
  verifyLedger,
  hashRecordBytes,
  prepareLedgerCommand,
  signLedgerRecord,
  signLedgerSnapshot,
  prepareEpochEnvelope,
  authenticateInstallationReport,
  prepareDeviceAdmission,
  accountUserId,
  decodePairingRequest,
  derivePairingKeys,
  encodePairingApproval,
  pairingApprovalTag,
  pairingRequestDigest,
  parsePairingString,
  verifyPairingRequestTag,
} from '@lody/e2ee-core/protocol';
import {
  PersonalCloseIncomplete,
  decodePersonalRequest,
  encodePersonalInvitation,
  type PersonalPairingOffer,
} from '@lody/e2ee-client';
import { decodeE2eeIntentRecord, E2EE_INTENT_KIND, ScheduleDefinitionSchema } from '@lody/shared';
import { mobilePersonalHost } from '../../src/e2ee/mobile-host';
import { personalEntryPins } from '@lody/client-e2ee';
import { irohPort, type NativeIrohBridge } from '../../src/e2ee/iroh-bridge';
import { NativeFixture, raw } from './native-fixture';
import { hex, desktopOffer as desktopOfferWithSeed } from './desktop-fixture';
import { decodeMemberKeyPackage } from '@lody/e2ee-client/member';
import type {
  E2eeAccountPairingRequests,
  E2eeMemberOffer,
  E2eeMemberRequest,
} from '@lody/cloud-api';
import { sha256 } from '@noble/hashes/sha2.js';

const boundary = vi.hoisted(() => ({
  queued: undefined as (() => void) | undefined,
  /** The inner runtime's `open` rejects with this, as a newer public runtime does. */
  openFailure: undefined as (() => unknown) | undefined,
  /** The inner runtime's `status` rejects with this instead of reading the ledger. */
  statusFailure: undefined as (() => unknown) | undefined,
  /** Each observing wrapper's real runtime, which owns its account-pairing identity. */
  wrapped: new WeakMap<object, never>(),
}));
vi.mock('@lody/e2ee-client', async (original) => {
  const real = await original<typeof import('@lody/e2ee-client')>();
  return {
    ...real,
    makePersonalWorkspaceRuntime: ((options) =>
      real.makePersonalWorkspaceRuntime(options).pipe(
        Effect.map((runtime) => {
          const observed = {
            ...runtime,
            open: (...invocation: Parameters<typeof runtime.open>) => {
              if (boundary.openFailure) return Promise.reject(boundary.openFailure());
              const work = runtime.open(...invocation);
              if (invocation[3] === 'queued-reader') boundary.queued?.();
              return work;
            },
            status: (...invocation: Parameters<typeof runtime.status>) =>
              boundary.statusFailure
                ? Promise.reject(boundary.statusFailure())
                : runtime.status(...invocation),
          };
          boundary.wrapped.set(observed, runtime as never);
          return observed;
        })
      )) as typeof real.makePersonalWorkspaceRuntime,
    personalRuntimeAccountRequester: ((runtime) =>
      real.personalRuntimeAccountRequester(
        boundary.wrapped.get(runtime) ?? runtime
      )) as typeof real.personalRuntimeAccountRequester,
  };
});
const shell = vi.hoisted(() => ({ native: true, available: false }));
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => shell.native, isPluginAvailable: () => shell.available },
  registerPlugin: () => {
    throw new Error('missing native plugin must not be registered');
  },
}));
const stops: (() => Promise<void>)[] = [];
/** The account whose ledger membership the fixture's genesis assigns (base32 account ID). */
const pairedAccount = 'acca';
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  const held = new Set<string>();
  vi.stubGlobal('navigator', {
    locks: {
      request: async (name: string, _options: unknown, callback: (lock: unknown) => unknown) => {
        if (held.has(name)) return callback(null);
        held.add(name);
        try {
          return await callback({ name });
        } finally {
          held.delete(name);
        }
      },
    },
  });
});
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  vi.unstubAllGlobals();
});
/** A backend refusal the synthetic server returns as a ConvexError payload. */
class Refusal extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  const scope = Effect.runSync(Scope.make());
  stops.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const run = <A>(work: Effect.Effect<A, unknown, Scope.Scope>) =>
    Effect.runPromise(Scope.provide(work, scope));
  const desktop = await run(
    importBrowserDevice({
      signingPrivate: new Uint8Array(32).fill(10),
      encryptionPrivate: new Uint8Array(32).fill(9),
    })
  );
  const epoch = Result.getOrThrow(Bytes.epochKey(new Uint8Array(32).fill(42)));
  const signed = await run(
    signGenesisRecord({
      signer: desktop,
      encryptionPublicKey: desktop.enc,
      initialKey: epoch,
      membershipId: Result.getOrThrow(Bytes.membershipId(new Uint8Array(16).fill(10))),
      // The ledger user of the account that signs in on a new phone (account pairing).
      userId: Result.getOrThrow(accountUserId(pairedAccount)),
    })
  );
  const offer: PersonalPairingOffer = {
    version: 1,
    workspaceId: 'workspace-A',
    genesisHash: hex(signed.genesis.toBytes()),
    genesisRecordHex: hex(signed.record),
    endorser: hex(desktop.publicKey.toBytes()),
    membershipId: '0a'.repeat(16),
    pairingSessionId: '11'.repeat(16),
  };
  const records: Uint8Array[] = [signed.record];
  let request: ReturnType<typeof decodePersonalRequest> | undefined,
    requestHex = '',
    invitation: string | null = null,
    offline = false,
    // The backend's verdict on this phone's own device credential, once revoked or removed.
    credentialRefusal: string | null = null,
    // Refusals the backend gives to one operation name regardless of credential.
    refusals = new Map<string, string>(),
    // A team join on this phone: the key package it submitted last to the relay.
    submitted: string | undefined,
    gate: { entered: ReturnType<typeof signal>; release: ReturnType<typeof signal> } | undefined,
    // Account pairing: the request a new phone submitted, and the desktop's publication.
    pairingSubmission: E2eeAccountPairingRequests['submit'] | undefined,
    pairingPublished: E2eeAccountPairingRequests['publish'] | undefined,
    pairedDevice: string | undefined;
  // Further account workspaces the service lists, and every workspace whose history was read.
  const listed: { id: string; name: string; genesisHash: string }[] = [];
  const historyReads: string[] = [];
  const workspaceListReads = { count: 0 };
  const current = () =>
    Result.getOrThrow(
      verifyLedger({
        anchor: signed.genesis,
        records,
        checkpoint: { head: hashRecordBytes(records.at(-1)!), length: records.length },
      })
    );
  const position = () => `p1:workspace-A:${records.length}:synthetic:0`;
  // Ledger user IDs are canonical base32 account IDs.
  const memberAccount = 'a1b2';
  const memberKey = () =>
    submitted
      ? hex(decodeMemberKeyPackage(submitted).request.signingPublicKey.toBytes())
      : undefined;
  const submissions: string[] = [];
  const rejected = new Set<string>();
  const memberCalls = { submit: 0, retire: 0 };
  /** What the relay records for a package; `committed` follows the ledger. */
  const memberRequest = (keyPackageHex = submitted!): E2eeMemberRequest => {
    const { request: joining } = decodeMemberKeyPackage(keyPackageHex);
    const signingPublicKey = hex(joining.signingPublicKey.toBytes());
    const requestId = hex(joining.requestId.toBytes());
    return {
      id: 'relay-join',
      workspaceId: offer.workspaceId,
      accountId: memberAccount,
      keyPackageHex,
      signingPublicKey,
      requestId,
      source: 'link',
      state: current().inspectState().devices.has(signingPublicKey)
        ? 'committed'
        : rejected.has(requestId)
          ? 'rejected'
          : 'pending',
      expiresAt: joining.expiresAt ?? 0,
      // The relay's copy of the invitation this request answered (#4287).
      offer: memberInvitation,
    };
  };
  // Calls held unanswered by name, as an unanswered socket during a network handoff.
  const held = new Map<
    string,
    { entered: ReturnType<typeof signal>; release: ReturnType<typeof signal> }
  >();
  const server = async (name: string, input: Record<string, unknown>): Promise<unknown> => {
    const hold = held.get(name);
    if (hold) {
      hold.entered.resolve();
      await hold.release.promise;
    }
    const refused = refusals.get(name) ?? (input.credential ? credentialRefusal : null);
    if (refused) throw new Refusal(refused);
    if (name === 'e2eeMembers:submit') {
      memberCalls.submit++;
      submitted = String(input.keyPackageHex);
      if (!submissions.includes(submitted)) submissions.push(submitted);
      return memberRequest();
    }
    if (name === 'e2eeMembers:claim') {
      const found = submissions.find((pkg) => memberRequest(pkg).requestId === input.requestId);
      if (!found) throw new Error('unknown request');
      return memberRequest(found);
    }
    if (name === 'e2eeMembers:retire') {
      // As the backend: a terminal request retires as cancelled; a live one stays.
      memberCalls.retire++;
      const found = memberRequest(String(input.keyPackageHex));
      const ended =
        found.state === 'rejected' || (found.state === 'pending' && found.expiresAt <= Date.now());
      return { state: ended ? 'cancelled' : found.state };
    }
    if (name === 'e2eeMembers:workspaces') {
      workspaceListReads.count += 1;
      return [{ id: offer.workspaceId, name: 'Team A', genesisHash: offer.genesisHash }, ...listed];
    }
    if (name === 'e2eeWorkspaces:history') historyReads.push(String(input.workspaceId));
    if (name === 'e2eeAccountPairing:submit') {
      pairingSubmission = input as E2eeAccountPairingRequests['submit'];
      return {
        requestId: 'account-pairing-1',
        status: 'pending',
        deviceName: input.deviceName,
        approximateLocation: null,
        requestedAt: 1,
        expiresAt: input.expiresAt,
      };
    }
    if (name === 'e2eeAccountPairing:claim') {
      if (input.lookupId !== pairingSubmission?.lookupId) return null;
      if (!pairingPublished) return { status: 'pending', approvals: [] };
      // As the backend: the approver's device credential never reaches the new device.
      return {
        status: 'approved',
        approvals: [
          {
            approvalHex: pairingPublished.approvalHex,
            approvalTagHex: pairingPublished.approvalTagHex,
            publishedAt: 2,
            invitations: pairingPublished.invitations.map((item) => ({
              workspaceId: item.workspaceId,
              genesisHash: item.genesisHash,
              invitationHex: item.invitationHex,
            })),
          },
        ],
      };
    }
    if (input.workspaceId !== offer.workspaceId) throw new Error('wrong workspace');
    if (name.startsWith('e2eeJoinMailbox:')) {
      if (name.endsWith(':begin')) {
        requestHex = String(input.requestHex);
        request = decodePersonalRequest(requestHex);
      }
      if (!request) throw new Error('missing request');
      return {
        ...request,
        accountId: 'account-A',
        requestHex,
        status: name.endsWith(':cancel') ? 'cancelled' : invitation ? 'published' : 'pending',
        invitationHex: invitation,
        publisher: invitation ? offer.endorser : null,
      };
    }
    if (name === 'e2eeWorkspaces:history') {
      const start = input.after ? Number(String(input.after).split(':')[2]) : 0;
      return {
        workspaceId: offer.workspaceId,
        genesisHash: offer.genesisHash,
        checkpoint: { headHash: hex(current().head.toBytes()), length: records.length },
        startIndex: start,
        recordsHex: records.slice(start).map(hex),
        position: position(),
        nextCursor: null,
        ledgerCapacity: {
          limitBytes: 33554432,
          observedBytes: 1,
          observedLength: records.length,
          nearLimit: false,
        },
      };
    }
    const recipient = request?.signingPublicKey ?? pairedDevice ?? memberKey();
    if (!recipient) throw new Error('missing request');
    if (name === 'e2eeMailbox:fetch') {
      if (!current().inspectState().devices.has(recipient)) throw new Error('not approved');
      const frame = await run(
        prepareEpochEnvelope({
          context: {
            genesis: signed.genesis,
            epoch: Result.getOrThrow(Bytes.epochNumber(0)),
            sender: desktop.publicKey,
            recipient: Result.getOrThrow(Bytes.signingPublicKey(raw(recipient))),
          },
          key: epoch,
          signer: desktop,
          ledger: () => Effect.succeed(current()),
        })
      );
      return { items: [{ sender: offer.endorser, frameHex: hex(frame) }], next: null };
    }
    if (name === 'e2eeMailbox:report') {
      await run(
        Effect.fromResult(
          authenticateInstallationReport({
            view: current(),
            genesis: signed.genesis,
            authenticatedRecipient: Result.getOrThrow(Bytes.signingPublicKey(raw(recipient))),
            report: raw(String(input.reportHex)),
          })
        )
      );
      return null;
    }
    if (name === 'e2eeMailbox:status')
      return { ...(input.slot as object), revision: 1, status: 'InstallationReported' };
    if (name === 'e2eeEpochStaging:readGroup') return null;
    if (name === 'e2eeContent:contentStreamsToken') {
      if (gate) {
        gate.entered.resolve();
        await gate.release.promise;
      }
      return {
        token: 'synthetic-protected-grant',
        attachmentToken: '44'.repeat(32),
        bucketId: 'protected',
        gatewayBaseUrl: 'https://streams.example.test',
        expiresIn: 900,
        expiresAt: 9000000000000,
      };
    }
    throw new Error('unexpected synthetic operation ' + name);
  };
  const client = new ConvexHttpClient('https://synthetic.example.test', {
    fetch: async (_url, init) => {
      if (offline) throw new Error('synthetic offline');
      const body = JSON.parse(String(init?.body)) as {
        path: string;
        args: Record<string, unknown>[];
      };
      let reply: unknown;
      try {
        reply = { status: 'success', value: await server(body.path, body.args[0]) };
      } catch (error) {
        if (!(error instanceof Refusal)) throw error;
        // The backend's ConvexError shape: the SDK exposes `errorData` as `data`.
        reply = { status: 'error', errorMessage: 'refused', errorData: { code: error.code } };
      }
      return new Response(JSON.stringify(reply), {
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  client.setAuth('synthetic-auth');
  const plugin = new NativeFixture(),
    session = createStore<PlatformSessionState>({
      status: 'authenticated',
      user: { id: 'account-A', name: 'A', email: 'a@example.test' },
    });
  const boot = (
    execute?: Parameters<typeof mobilePersonalHost>[1],
    account: typeof session = session
  ) => {
    const owner = mobilePersonalHost(client, execute ?? Effect.runPromise, plugin);
    stops.push(() => owner.close());
    return { owner, runtime: owner.createRuntime({ session: account })! };
  };
  const approve = async () => {
    if (!request) throw new Error('missing request');
    const r = request;
    const proposal = Result.getOrThrow(
      prepareLedgerCommand(current(), desktop.publicKey, {
        _tag: 'AdmitDevice',
        kind: 'personal',
        signingPublicKey: Result.getOrThrow(Bytes.signingPublicKey(raw(r.signingPublicKey))),
        encryptionPublicKey: Result.getOrThrow(
          Bytes.encryptionPublicKey(raw(r.encryptionPublicKey))
        ),
        possessionSignature: Result.getOrThrow(Bytes.signature(raw(r.possessionSignature))),
      })
    );
    records.push(await run(signLedgerRecord(proposal, desktop)));
    const receipt = await run(
      signLedgerSnapshot({ signer: desktop, ledger: () => Effect.succeed(current()) })
    );
    invitation = encodePersonalInvitation({
      ...receipt,
      workspaceId: offer.workspaceId,
      offset: position(),
    });
  };
  /** The desktop approves the new phone's account-pairing request for the code it shows:
   * it checks the request tag, signs the personal `AdmitDevice`, and publishes the tagged
   * approval with a signed snapshot invitation, or none (`history`, a Member approver). */
  const approveAccountPairing = async (pairingString: string, delivery: 'snapshot' | 'history') => {
    const submitted = pairingSubmission!;
    const keys = Result.getOrThrow(
      derivePairingKeys(Result.getOrThrow(parsePairingString(pairingString)))
    );
    const pairing = Result.getOrThrow(decodePairingRequest(raw(submitted.requestHex)));
    Result.getOrThrow(verifyPairingRequestTag(keys, pairing, raw(submitted.requestTagHex)));
    const row = pairing.rows.find((item) => hex(item.genesis) === offer.genesisHash)!;
    const proposal = Result.getOrThrow(
      prepareLedgerCommand(current(), desktop.publicKey, {
        _tag: 'AdmitDevice',
        kind: 'personal',
        signingPublicKey: Result.getOrThrow(Bytes.signingPublicKey(row.signingPublicKey)),
        encryptionPublicKey: Result.getOrThrow(Bytes.encryptionPublicKey(row.encryptionPublicKey)),
        possessionSignature: Result.getOrThrow(Bytes.signature(row.possessionProof)),
      })
    );
    const record = await run(signLedgerRecord(proposal, desktop));
    records.push(record);
    pairedDevice = hex(row.signingPublicKey);
    let invitationBytes = Uint8Array.of(0);
    if (delivery === 'snapshot') {
      const receipt = await run(
        signLedgerSnapshot({ signer: desktop, ledger: () => Effect.succeed(current()) })
      );
      invitationBytes = raw(
        encodePersonalInvitation({ ...receipt, workspaceId: offer.workspaceId, offset: position() })
      );
    }
    const approval = {
      requestDigest: Result.getOrThrow(pairingRequestDigest(pairing)),
      approverSigningPublicKey: desktop.publicKey.toBytes(),
      rows: [
        {
          genesis: row.genesis,
          admissionRecordHash: hashRecordBytes(record).toBytes(),
          invitationDigest: delivery === 'snapshot' ? sha256(invitationBytes) : new Uint8Array(32),
        },
      ],
    };
    pairingPublished = {
      lookupId: submitted.lookupId,
      approvalHex: hex(Result.getOrThrow(encodePairingApproval(approval))),
      approvalTagHex: hex(Result.getOrThrow(pairingApprovalTag(keys, approval))),
      invitations: [
        {
          workspaceId: offer.workspaceId,
          credential: 'synthetic-desktop-credential',
          genesisHash: offer.genesisHash,
          invitationHex: hex(invitationBytes),
        },
      ],
    };
  };
  /** The desktop revokes this phone in the signed ledger; the backend then refuses its
   * credential with `e2ee_device_revoked` on every credential-bound endpoint. */
  const revokePhone = async () => {
    if (!request) throw new Error('missing request');
    const proposal = Result.getOrThrow(
      prepareLedgerCommand(current(), desktop.publicKey, {
        _tag: 'RevokeDevice',
        target: Result.getOrThrow(Bytes.signingPublicKey(raw(request.signingPublicKey))),
      })
    );
    records.push(await run(signLedgerRecord(proposal, desktop)));
    credentialRefusal = 'e2ee_device_revoked';
  };
  /** Admits a synthetic machine device; returns its ledger key (the iroh EndpointId). */
  const addMachine = async (machineId: string) => {
    const machine = await run(
      importBrowserDevice({
        signingPrivate: new Uint8Array(32).fill(12),
        encryptionPrivate: new Uint8Array(32).fill(13),
      })
    );
    const proof = await run(
      prepareDeviceAdmission({
        genesis: signed.genesis,
        membershipId: Result.getOrThrow(Bytes.membershipId(new Uint8Array(16).fill(10))),
        encryptionPublicKey: machine.enc,
        kind: 'machine',
        machineId,
        signer: machine,
      })
    );
    const proposal = Result.getOrThrow(
      prepareLedgerCommand(current(), desktop.publicKey, {
        _tag: 'AdmitDevice',
        kind: 'machine',
        machineId,
        replaces: null,
        signingPublicKey: machine.publicKey,
        encryptionPublicKey: machine.enc,
        possessionSignature: proof.possessionSignature,
      })
    );
    records.push(await run(signLedgerRecord(proposal, desktop)));
    return hex(machine.publicKey.toBytes());
  };
  /** A link invitation from the genesis owner for this account to join the team. */
  const memberInvitation: E2eeMemberOffer = {
    version: 1,
    workspaceId: offer.workspaceId,
    genesisHash: offer.genesisHash,
    genesisRecordHex: offer.genesisRecordHex,
    endorser: offer.endorser,
    token: 'cd'.repeat(32),
    mode: 'link',
    expiresAt: 9000000000000,
  };
  /** The genesis owner signs the real AdmitMember for exactly the submitted package. */
  const admitMember = async () => {
    const { request: joining } = decodeMemberKeyPackage(submitted!);
    const proposal = Result.getOrThrow(
      prepareLedgerCommand(current(), desktop.publicKey, {
        _tag: 'AdmitMember',
        membershipId: Result.getOrThrow(Bytes.membershipId(joining.requestId.toBytes())),
        request: joining,
      })
    );
    records.push(await run(signLedgerRecord(proposal, desktop)));
  };
  return {
    client,
    offer,
    plugin,
    session,
    boot,
    approve,
    approveAccountPairing,
    /** The account-pairing request the new phone submitted to the relay, if any. */
    pairingSubmission: () => pairingSubmission,
    /** The service also lists another encrypted workspace of the account. */
    listWorkspace: (workspace: { id: string; name: string; genesisHash: string }) => {
      listed.push(workspace);
    },
    historyReads,
    workspaceListReads,
    /** A new phone of the account that owns this workspace's ledger membership. */
    pairedSession: createStore<PlatformSessionState>({
      status: 'authenticated',
      user: { id: pairedAccount, name: 'A', email: 'a@example.test' },
    }),
    revokePhone,
    /** The backend refuses this phone's credential without a ledger record (yet). */
    refuseCredential: (code: string | null) => {
      credentialRefusal = code;
    },
    /** The backend refuses one operation by name, whatever it sends. */
    refuse: (name: string, code: string) => {
      refusals.set(name, code);
    },
    addMachine,
    invitation: memberInvitation,
    /** A link that expires one minute after the fixture starts. */
    shortInvitation: {
      ...memberInvitation,
      token: 'aa'.repeat(32),
      expiresAt: Date.now() + 60_000,
    },
    /** A second link from the admin after the first request ended. */
    secondInvitation: { ...memberInvitation, token: 'ef'.repeat(32) },
    admitMember,
    /** The admin rejects the request this phone submitted last. */
    rejectMember: () => {
      rejected.add(memberRequest().requestId);
    },
    memberCalls,
    /** The joining account's own login, separate from the desktop-paired account. */
    memberSession: createStore<PlatformSessionState>({
      status: 'authenticated',
      user: { id: memberAccount, name: 'M', email: 'm@example.test' },
    }),
    offline: () => {
      offline = true;
    },
    /** The next calls of `name` stay unanswered until released. */
    hold: (name: string) => {
      const hold = { entered: signal(), release: signal() };
      held.set(name, hold);
      return {
        entered: hold.entered.promise,
        release: () => {
          held.delete(name);
          hold.release.resolve();
        },
      };
    },
    holdGrant: () => {
      gate = { entered: signal(), release: signal() };
      return gate;
    },
  };
}
it('assembles the real public host with native custody through approval, keys, ciphertext and offline reopen', async () => {
  const f = await fixture(),
    first = f.boot(),
    id = f.offer.workspaceId;
  await expect(first.runtime.open(id)).rejects.toMatchObject({ code: 'approval-required' });
  await expect(first.runtime.preparePersonalJoin!(f.offer)).resolves.toMatchObject({
    status: 'pending',
  });
  expect(f.plugin.wraps).toBe(3);
  await expect(first.runtime.open(id)).rejects.toBeDefined();
  await f.approve();
  await expect(
    first.runtime.claimPersonalJoin!(id, f.offer.pairingSessionId)
  ).resolves.toMatchObject({ ready: true });
  await first.runtime.open(id, undefined, 'account-A', 'reader-1');
  await expect(first.runtime.open('workspace-B')).rejects.toMatchObject({
    code: 'approval-required',
  });
  await expect(first.runtime.ledgerView('workspace-B')).rejects.toMatchObject({
    code: 'approval-required',
  });
  await expect(first.runtime.refresh(id, { keyMode: 'full' })).resolves.toMatchObject({
    hasCurrentKey: true,
  });
  const room = { kind: 'doc' as const, docId: 'doc-A' },
    context = {
      protocol: 'loro-streams-crdt-payload-protection' as const,
      version: 2 as const,
      kind: 'update_batch' as const,
    },
    body = new TextEncoder().encode('synthetic mobile secret'),
    additionalData = Uint8Array.of(3, 4);
  const sealed = await first.runtime.seal(id, {
    epoch: 0,
    room,
    context,
    plaintext: body,
    additionalData,
  });
  expect(Buffer.from(sealed.sealed).includes(Buffer.from(body))).toBe(false);
  const opened = await first.runtime.openContent(id, { room, context, ...sealed, additionalData });
  try {
    expect(opened).toEqual(body);
  } finally {
    opened.fill(0);
  }
  await expect(first.runtime.contentStreamsToken(id)).resolves.toMatchObject({
    bucketId: 'protected',
  });
  // An encrypted schedule saved on this phone carries this device's signed declaration;
  // without it the shared schedule save refuses with e2ee_signature_unavailable.
  const declaration = decodeE2eeIntentRecord(
    await first.runtime.signScheduleDeclaration!(id, {
      definition: ScheduleDefinitionSchema.parse({
        scheduleId: 'schedule-A',
        title: 'Nightly',
        ownerId: 'account-A',
        machineId: 'machine-A',
        enabled: true,
        activationId: 'activation-A',
        activeFrom: 0,
        trigger: { kind: 'interval', everyMs: 60_000, anchorAt: '2026-01-01T00:00:00Z' },
        misfirePolicy: { kind: 'skip' },
        overlapPolicy: 'queue_one',
        agent: { agentConfigId: 'agent', modeId: 'safe' },
        project: { kind: 'github', repoFullName: 'loro-dev/lody', branch: 'main' },
        retryPolicy: { dispatchMaxAttempts: 5, dispatchMaxAgeMs: 86_400_000 },
        createdAt: 0,
        updatedAt: 0,
        createdBy: 'account-A',
      }),
      prompt: 'synthetic schedule prompt',
    })
  );
  expect(declaration?.kind).toBe(E2EE_INTENT_KIND.scheduleDeclaration);
  expect(declaration?.signature).toHaveLength(64);
  // Machine sharing is the shared host every Web/mobile runtime carries (#4303, #4306).
  expect(first.runtime.readMachineSharing).toBeTypeOf('function');
  // Without a native iroh port the facade offers no route, so sends stay on Streams.
  expect(first.runtime.irohReady).toBeUndefined();
  expect(first.runtime.irohCall).toBeUndefined();
  await first.owner.close();
  f.offline();
  const reopened = f.boot();
  await expect(reopened.runtime.open(id)).resolves.toMatchObject({ hasCurrentKey: true });
  expect(f.plugin.wraps).toBe(4);
  const offlinePlain = await reopened.runtime.openContent(id, {
    room,
    context,
    ...sealed,
    additionalData,
  });
  try {
    expect(offlinePlain).toEqual(body);
  } finally {
    offlinePlain.fill(0);
  }
  await reopened.owner.close();
  f.plugin.fail = 'LOCKED';
  const locked = f.boot();
  await expect(locked.runtime.open(id)).rejects.toMatchObject({
    _tag: 'ClientCustodyError',
    reason: 'locked',
  });
  await locked.owner.close();
  f.plugin.fail = '';
  f.plugin.keys.clear();
  const lost = f.boot();
  await expect(lost.runtime.open(id)).rejects.toMatchObject({
    _tag: 'ClientCustodyError',
    reason: 'identity-lost',
  });
  expect(f.plugin.keys.size).toBe(0);
});
it('forwards the native iroh route through the application facade to the machine device', async () => {
  const f = await fixture(),
    id = f.offer.workspaceId;
  const crossed: { method: string; input: Record<string, unknown> }[] = [];
  const reply = (frame: string) =>
    Buffer.from(JSON.stringify({ id: 'request-1', frame })).toString('base64');
  const replies = [reply('ab'), null];
  const bridge = Object.fromEntries(
    ['open', 'hasConnection', 'connectionPath', 'warm', 'call', 'nextReply', 'cancel', 'close'].map(
      (method) => [
        method,
        async (input: Record<string, unknown>) => {
          crossed.push({ method, input });
          if (method === 'open') return { handle: 'endpoint-1' };
          if (method === 'hasConnection') return { value: true };
          if (method === 'connectionPath') return { value: 'direct' };
          if (method === 'call') return { call: 'call-1' };
          if (method === 'nextReply') return { reply: replies.shift() ?? null };
          return {};
        },
      ]
    )
  ) as unknown as NativeIrohBridge;
  const owner = mobilePersonalHost(
    f.client,
    Effect.runPromise,
    f.plugin,
    {},
    irohPort(bridge, { urls: ['https://relay.example.test/'] })
  );
  stops.push(() => owner.close());
  const runtime = owner.createRuntime({ session: f.session })!;
  await runtime.preparePersonalJoin!(f.offer);
  await f.approve();
  await runtime.claimPersonalJoin!(id, f.offer.pairingSessionId);
  const machineKey = await f.addMachine('machine-M');
  await runtime.open(id);
  await runtime.refresh(id, { keyMode: 'full' });

  await expect(runtime.irohPath!(id, 'machine-M')).resolves.toBe('none');
  expect(crossed.filter((c) => c.method === 'open')).toHaveLength(0);
  await expect(runtime.irohReady!(id, 'machine-M')).resolves.toBe(true);
  await expect(runtime.irohPath!(id, 'machine-M')).resolves.toBe('direct');
  await expect(
    runtime.irohCall!(id, 'machine-M', { id: 'request-1', frame: '00' }, 5_000)
  ).resolves.toEqual(['ab']);
  // The seed crossed once; status and the call addressed the machine's ledger key.
  expect(crossed.filter((c) => c.method === 'open')).toHaveLength(1);
  expect(crossed.find((c) => c.method === 'hasConnection')?.input.endpointId).toBe(machineKey);
  expect(crossed.find((c) => c.method === 'call')?.input.endpointId).toBe(machineKey);
  expect(crossed.find((c) => c.method === 'connectionPath')?.input.endpointId).toBe(machineKey);
  // An unknown machine has no route: "not ready", never an error.
  await expect(runtime.irohReady!(id, 'machine-unknown')).resolves.toBe(false);
  await expect(runtime.irohPath!(id, 'machine-unknown')).resolves.toBe('none');
});
it.each(['seal', 'open'] as const)(
  'captures %s bytes and framing before asynchronous host lookup',
  async (operation) => {
    const f = await fixture(),
      app = f.boot(),
      id = f.offer.workspaceId;
    await app.runtime.preparePersonalJoin!(f.offer);
    await f.approve();
    await app.runtime.claimPersonalJoin!(id, f.offer.pairingSessionId);
    await app.runtime.open(id);
    await app.runtime.refresh(id, { keyMode: 'full' });
    const input: E2eeContentSeal = {
      epoch: 0,
      room: { kind: 'doc', docId: 'captured-doc' },
      context: {
        protocol: 'loro-streams-crdt-payload-protection',
        version: 2,
        kind: 'update_batch',
      },
      plaintext: Uint8Array.of(11, 22, 33),
      additionalData: Uint8Array.of(4, 5),
    };
    const sealing = app.runtime.seal(id, input);
    if (operation === 'seal') {
      input.plaintext.fill(0);
      input.additionalData.fill(0);
      input.room = { kind: 'doc', docId: 'after-call' };
      input.context.kind = 'snapshot';
    }
    const sealed = await sealing;
    const frame: E2eeContentOpen = {
      ...sealed,
      room: { kind: 'doc', docId: 'captured-doc' },
      context: {
        protocol: 'loro-streams-crdt-payload-protection',
        version: 2,
        kind: 'update_batch',
      },
      additionalData: Uint8Array.of(4, 5),
    };
    const opening = app.runtime.openContent(id, frame);
    if (operation === 'open') {
      frame.sealed.fill(0);
      frame.header.fill(0);
      frame.additionalData.fill(0);
      frame.room = { kind: 'doc', docId: 'after-call' };
      frame.context.kind = 'snapshot';
    }
    const body = await opening;
    try {
      expect(body).toEqual(Uint8Array.of(11, 22, 33));
    } finally {
      body.fill(0);
    }
  }
);

it('fences a real late cloud grant after account replacement while another account stays uninitialized', async () => {
  const f = await fixture(),
    first = f.boot(),
    id = f.offer.workspaceId;
  await first.runtime.preparePersonalJoin!(f.offer);
  await f.approve();
  await first.runtime.claimPersonalJoin!(id, f.offer.pairingSessionId);
  await first.runtime.open(id);
  await first.runtime.refresh(id, { keyMode: 'full' });
  const gate = f.holdGrant(),
    pending = first.runtime.contentStreamsToken(id).then(
      () => 'leaked',
      () => 'refused'
    );
  await gate.entered.promise;
  f.session.set({
    status: 'authenticated',
    user: { id: 'account-B', name: 'B', email: 'b@example.test' },
  });
  gate.release.resolve();
  expect(await pending).toBe('refused');
  await expect(first.runtime.open(id)).rejects.toMatchObject({ code: 'approval-required' });
});
it('reopens immediately after a pending native reader is confirmed closed without reusing its retired host', async () => {
  const f = await fixture(),
    first = f.boot(),
    id = f.offer.workspaceId;
  await first.runtime.preparePersonalJoin!(f.offer);
  await f.approve();
  await first.runtime.claimPersonalJoin!(id, f.offer.pairingSessionId);
  await first.owner.close();
  const entered = signal(),
    release = signal(),
    native = f.plugin.unwrap.bind(f.plugin);
  let pause = true;
  f.plugin.unwrap = async (input) => {
    if (pause) {
      pause = false;
      entered.resolve();
      await release.promise;
    }
    return native(input);
  };
  const reopened = f.boot();
  const opening = reopened.runtime.open(id, undefined, 'account-A', 'pending-reader').then(
    () => 'stale',
    () => 'closed'
  );
  await entered.promise;
  const closing = reopened.runtime.close(id, 'account-A', 'pending-reader');
  release.resolve();
  await closing;
  expect(await opening).toBe('closed');
  await expect(
    reopened.runtime.open(id, undefined, 'account-A', 'new-reader')
  ).resolves.toMatchObject({ workspaceId: id });
  expect(f.plugin.wraps).toBe(3);
});

it('keeps an incomplete native-close owner until actual drain and then allows the exact scope to reopen', async () => {
  const f = await fixture(),
    first = f.boot(),
    id = f.offer.workspaceId;
  await first.runtime.preparePersonalJoin!(f.offer);
  await f.approve();
  await first.runtime.claimPersonalJoin!(id, f.offer.pairingSessionId);
  await first.owner.close();
  const entered = signal(),
    release = signal(),
    native = f.plugin.unwrap.bind(f.plugin);
  let pause = true;
  f.plugin.unwrap = async (input) => {
    if (pause) {
      pause = false;
      entered.resolve();
      await release.promise;
    }
    return native(input);
  };
  const clock = ManagedRuntime.make(TestClock.layer({ warningDelay: '1 hour' }));
  stops.push(() => clock.dispose());
  await clock.context();
  const reopened = f.boot((program) => clock.runPromise(program)),
    opening = reopened.runtime.open(id, undefined, 'account-A', 'long-native').then(
      () => 'stale',
      () => 'closed'
    );
  await entered.promise;

  try {
    const closing = reopened.runtime.close(id, 'account-A', 'long-native').then(
      () => null,
      (error) => error as unknown
    );
    await clock.runPromise(TestClock.adjust(5000));
    const incomplete = await closing;
    expect(incomplete).toBeInstanceOf(PersonalCloseIncomplete);
    if (!(incomplete instanceof PersonalCloseIncomplete)) throw new Error('missing close owner');
    expect(await Effect.runPromise(incomplete.owner.settled())).toBe(false);
    await expect(
      reopened.runtime.open(id, undefined, 'account-A', 'too-early')
    ).rejects.toBeInstanceOf(PersonalCloseIncomplete);
    release.resolve();
    await Effect.runPromise(incomplete.owner.awaitSettled());
    await reopened.owner.awaitRetirements();
    expect(await opening).toBe('closed');
    await expect(
      reopened.runtime.open(id, undefined, 'account-A', 'after-drain')
    ).resolves.toMatchObject({ workspaceId: id });
  } finally {
    release.resolve();
  }
});
it('forgets a fenced reader after incomplete close and can reopen after a later pending-reader cancellation', async () => {
  const f = await fixture(),
    first = f.boot(),
    id = f.offer.workspaceId;
  await first.runtime.preparePersonalJoin!(f.offer);
  await f.approve();
  await first.runtime.claimPersonalJoin!(id, f.offer.pairingSessionId);
  await first.owner.close();
  const clock = ManagedRuntime.make(TestClock.layer({ warningDelay: '1 hour' }));
  stops.push(() => clock.dispose());
  await clock.context();
  let nextExecution: (() => void) | undefined;
  const app = f.boot((program) =>
    clock.runPromise(
      Effect.suspend(() => {
        const entered = nextExecution;
        nextExecution = undefined;
        entered?.();
        return program;
      })
    )
  );
  const epochEntered = signal(),
    epochRelease = signal(),
    signingEntered = signal(),
    signingRelease = signal(),
    native = f.plugin.unwrap.bind(f.plugin);
  let holdEpoch = false,
    holdSigning = false;
  f.plugin.unwrap = async (input) => {
    if (holdEpoch && input.purpose === 'installed-epoch-key') {
      holdEpoch = false;
      epochEntered.resolve();
      await epochRelease.promise;
    }
    if (holdSigning && input.purpose === 'signing-private-key') {
      holdSigning = false;
      signingEntered.resolve();
      await signingRelease.promise;
    }
    return native(input);
  };
  await app.runtime.open(id, undefined, 'account-A', 'reader-A');
  await app.runtime.refresh(id, { keyMode: 'full' });
  holdEpoch = true;
  const sealing = app.runtime
    .seal(id, {
      epoch: 0,
      room: { kind: 'doc', docId: 'closing-native' },
      context: {
        protocol: 'loro-streams-crdt-payload-protection',
        version: 2,
        kind: 'update_batch',
      },
      plaintext: new TextEncoder().encode('synthetic closing body'),
      additionalData: new Uint8Array(),
    })
    .then(
      () => 'stale',
      () => 'closed'
    );
  try {
    await epochEntered.promise;
    const closeAStarted = signal();
    nextExecution = closeAStarted.resolve;
    const closingA = app.runtime.close(id, 'account-A', 'reader-A').then(
      () => null,
      (error) => error as unknown
    );
    await closeAStarted.promise;
    await clock.runPromise(TestClock.adjust(5000));
    const incomplete = await closingA;
    expect(incomplete).toBeInstanceOf(PersonalCloseIncomplete);
    if (!(incomplete instanceof PersonalCloseIncomplete)) throw new Error('missing close owner');
    epochRelease.resolve();
    await Effect.runPromise(incomplete.owner.awaitSettled());
    expect(await sealing).toBe('closed');
    await app.runtime.open(id, undefined, 'account-A', 'reader-B');
    await app.runtime.close(id, 'account-A', 'reader-B');
    holdSigning = true;
    const openingC = app.runtime.open(id, undefined, 'account-A', 'reader-C').then(
      () => 'stale',
      () => 'closed'
    );
    await signingEntered.promise;
    const closeCStarted = signal();
    nextExecution = closeCStarted.resolve;
    const closingC = app.runtime.close(id, 'account-A', 'reader-C');
    await closeCStarted.promise;
    signingRelease.resolve();
    await closingC;
    expect(await openingC).toBe('closed');
    await expect(app.runtime.open(id, undefined, 'account-A', 'reader-D')).resolves.toMatchObject({
      workspaceId: id,
    });
    expect(f.plugin.wraps).toBe(4);
  } finally {
    epochRelease.resolve();
    signingRelease.resolve();
  }
});

it('closing a second queued reader preserves the first actual native owner', async () => {
  const f = await fixture(),
    first = f.boot(),
    id = f.offer.workspaceId;
  await first.runtime.preparePersonalJoin!(f.offer);
  await f.approve();
  await first.runtime.claimPersonalJoin!(id, f.offer.pairingSessionId);
  await first.owner.close();
  const entered = signal(),
    release = signal(),
    native = f.plugin.unwrap.bind(f.plugin);
  let pause = true;
  f.plugin.unwrap = async (input) => {
    if (pause) {
      pause = false;
      entered.resolve();
      await release.promise;
    }
    return native(input);
  };
  const reopened = f.boot(),
    a = reopened.runtime.open(id, undefined, 'account-A', 'native-owner');
  await entered.promise;
  const secondEntered = signal();
  boundary.queued = secondEntered.resolve;
  const b = reopened.runtime.open(id, undefined, 'account-A', 'queued-reader').then(
    () => 'stale',
    () => 'closed'
  );
  await secondEntered.promise;
  boundary.queued = undefined;
  const closed = reopened.runtime.close(id, 'account-A', 'queued-reader');
  release.resolve();
  await closed;
  await expect(a).resolves.toMatchObject({ workspaceId: id });
  expect(await b).toBe('closed');
  await expect(reopened.runtime.status(id)).resolves.toMatchObject({ workspaceId: id });
});
it('an authentication refresh holds the public account guard and resumes the same account without poisoning its host', async () => {
  const f = await fixture(),
    first = f.boot(),
    id = f.offer.workspaceId;
  await first.runtime.preparePersonalJoin!(f.offer);
  await f.approve();
  await first.runtime.claimPersonalJoin!(id, f.offer.pairingSessionId);
  await first.owner.close();
  const entered = signal(),
    release = signal(),
    native = f.plugin.unwrap.bind(f.plugin);
  let pause = true;
  f.plugin.unwrap = async (input) => {
    if (pause) {
      pause = false;
      entered.resolve();
      await release.promise;
    }
    return native(input);
  };
  const reopened = f.boot(),
    opening = reopened.runtime.open(id, undefined, 'account-A', 'refreshing-reader');
  await entered.promise;
  f.session.set({ status: 'loading' });
  const unknownRead = signal(),
    originalGet = f.session.get;
  const reading = vi.spyOn(f.session, 'get').mockImplementation(() => {
    const state = originalGet();
    if (state.status === 'loading') unknownRead.resolve();
    return state;
  });
  release.resolve();
  await unknownRead.promise;
  f.session.set({
    status: 'authenticated',
    user: { id: 'account-A', name: 'A', email: 'a@example.test' },
  });
  reading.mockRestore();
  await expect(opening).resolves.toMatchObject({ workspaceId: id });
  await expect(reopened.runtime.status(id)).resolves.toMatchObject({ workspaceId: id });
});

it('reacquires only after confirmed close when a queued reader becomes the next physical open', async () => {
  const f = await fixture(),
    first = f.boot(),
    id = f.offer.workspaceId;
  await first.runtime.preparePersonalJoin!(f.offer);
  await f.approve();
  await first.runtime.claimPersonalJoin!(id, f.offer.pairingSessionId);
  await first.owner.close();
  const aEntered = signal(),
    aRelease = signal(),
    bEntered = signal(),
    bRelease = signal(),
    native = f.plugin.unwrap.bind(f.plugin);
  let signing = 0;
  f.plugin.unwrap = async (input) => {
    if (input.purpose === 'signing-private-key') {
      signing++;
      if (signing === 1) {
        aEntered.resolve();
        await aRelease.promise;
      }
      if (signing === 2) {
        bEntered.resolve();
        await bRelease.promise;
      }
    }
    return native(input);
  };
  const reopened = f.boot();
  const a = reopened.runtime
    .open(
      id,
      { genesisHash: f.offer.genesisHash, headHash: 'ff'.repeat(32), length: 2 },
      'account-A',
      'bad-checkpoint'
    )
    .then(
      () => 'invalid',
      () => 'refused'
    );
  await aEntered.promise;
  const secondEntered = signal();
  boundary.queued = secondEntered.resolve;
  const b = reopened.runtime.open(id, undefined, 'account-A', 'queued-reader').then(
    () => 'stale',
    () => 'closed'
  );
  await secondEntered.promise;
  boundary.queued = undefined;
  aRelease.resolve();
  await bEntered.promise;
  const closing = reopened.runtime.close(id, 'account-A', 'queued-reader');
  bRelease.resolve();
  await closing;
  expect(await a).toBe('refused');
  expect(await b).toBe('closed');
  await expect(
    reopened.runtime.open(id, undefined, 'account-A', 'after-queued-close')
  ).resolves.toMatchObject({ workspaceId: id });
});

it.each(['old-shell', 'browser'])(
  'refuses %s protection before allocating an installation while retaining the public request',
  async (kind) => {
    shell.native = kind === 'old-shell';
    shell.available = false;
    const f = await fixture(),
      owner = mobilePersonalHost(f.client, Effect.runPromise);
    stops.push(() => owner.close());
    const runtime = owner.createRuntime({ session: f.session })!;
    await expect(runtime.account()).resolves.toMatchObject({ userId: 'account-A' });
    await expect(runtime.preparePersonalJoin!(f.offer)).rejects.toMatchObject({
      _tag: 'ClientCustodyError',
      reason: 'unavailable',
    });
    const databases = (await indexedDB.databases()).map((row) => row.name);
    expect(databases).toEqual(['lody-e2ee:mobile:v1:entry-pins']);
    await expect(runtime.pendingPersonalJoin!(f.offer.workspaceId)).resolves.toMatchObject({
      offer: f.offer,
    });
  }
);
it('rejects a different ready-device offer without retiring its working readers or changing the pin', async () => {
  const f = await fixture(),
    first = f.boot(),
    id = f.offer.workspaceId;
  await first.runtime.preparePersonalJoin!(f.offer);
  await f.approve();
  await first.runtime.claimPersonalJoin!(id, f.offer.pairingSessionId);
  await first.runtime.open(id);
  await expect(
    first.runtime.preparePersonalJoin!({ ...f.offer, pairingSessionId: '99'.repeat(16) })
  ).rejects.toMatchObject({ code: 'conflict' });
  await expect(first.runtime.status(id)).resolves.toMatchObject({ workspaceId: id });
});

it('reloading the join page after a completed team join resumes as joined instead of asking to submit again', async () => {
  const f = await fixture(),
    id = f.offer.workspaceId;
  const first = f.boot(undefined, f.memberSession);
  const submitted = await first.runtime.prepareMemberJoin!(f.invitation);
  await f.admitMember();
  // The join page claims until this device holds the current key.
  await expect(first.runtime.claimMemberJoin!(id, submitted.requestId)).resolves.toEqual({
    ready: true,
    state: 'committed',
  });
  await first.owner.close();
  // A reload is a new app owner over the same device. The page resumes from the
  // retained join rather than offering a new request, and is ready at once.
  const reloaded = f.boot(undefined, f.memberSession);
  const pending = await reloaded.runtime.pendingMemberJoin!(id);
  expect(pending).toMatchObject({ requestId: submitted.requestId, offer: f.invitation });
  await expect(reloaded.runtime.claimMemberJoin!(id, pending!.requestId!)).resolves.toEqual({
    ready: true,
    state: 'committed',
  });
});

it.each([
  'after the join page showed the rejection',
  'without opening the earlier join page again',
])('a rejected team join lets a new invitation submit a new request (%s)', async (path) => {
  const f = await fixture(),
    id = f.offer.workspaceId;
  const app = f.boot(undefined, f.memberSession);
  const first = await app.runtime.prepareMemberJoin!(f.invitation);
  f.rejectMember();
  if (path === 'after the join page showed the rejection')
    await expect(app.runtime.claimMemberJoin!(id, first.requestId)).resolves.toEqual({
      ready: false,
      state: 'rejected',
    });
  // The new link retires the ended request through the relay and submits a new one.
  const second = await app.runtime.prepareMemberJoin!(f.secondInvitation);
  expect(second.requestId).not.toBe(first.requestId);
  expect(second.state).toBe('pending');
  expect(f.memberCalls).toEqual({ submit: 2, retire: 1 });
  await expect(app.runtime.pendingMemberJoin!(id)).resolves.toMatchObject({
    requestId: second.requestId,
    offer: f.secondInvitation,
  });
});

it('an expired team join lets a new invitation submit a new request', async () => {
  const f = await fixture(),
    id = f.offer.workspaceId;
  const app = f.boot(undefined, f.memberSession);
  const first = await app.runtime.prepareMemberJoin!(f.shortInvitation);
  // The relay still lists the request as pending; its invitation has expired.
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);
  try {
    const second = await app.runtime.prepareMemberJoin!(f.secondInvitation);
    expect(second.requestId).not.toBe(first.requestId);
    expect(f.memberCalls).toEqual({ submit: 2, retire: 1 });
    await expect(app.runtime.pendingMemberJoin!(id)).resolves.toMatchObject({
      requestId: second.requestId,
    });
  } finally {
    clock.mockRestore();
  }
});

/** A team join this phone completed: admitted, with the current key installed. */
async function joined() {
  const f = await fixture(),
    id = f.offer.workspaceId;
  const first = f.boot(undefined, f.memberSession);
  const submitted = await first.runtime.prepareMemberJoin!(f.invitation);
  await f.admitMember();
  await expect(first.runtime.claimMemberJoin!(id, submitted.requestId)).resolves.toEqual({
    ready: true,
    state: 'committed',
  });
  await first.owner.close();
  return { f, id, requestId: submitted.requestId };
}
it('a join link opened while the login is still loading waits for the account and finds the saved join', async () => {
  const { f, id, requestId } = await joined();
  const loading = createStore<PlatformSessionState>({ status: 'loading' });
  const reloaded = f.boot(undefined, loading);
  // The page asks once, during app start; the login resolves afterwards.
  const pending = reloaded.runtime.pendingMemberJoin!(id);
  loading.set(f.memberSession.get());
  await expect(pending).resolves.toMatchObject({ requestId, offer: f.invitation });
});
it('a joined phone reopening its join page is joined at once, without another key round', async () => {
  const { f, id, requestId } = await joined();
  f.offline();
  const reloaded = f.boot(undefined, f.memberSession);
  await expect(reloaded.runtime.pendingMemberJoin!(id)).resolves.toMatchObject({ requestId });
  await expect(reloaded.runtime.claimMemberJoin!(id, requestId)).resolves.toEqual({
    ready: true,
    state: 'committed',
  });
});
it('a pairing page opened while the login is still loading waits for the account and finds the saved request', async () => {
  const f = await fixture(),
    id = f.offer.workspaceId;
  const first = f.boot();
  await expect(first.runtime.preparePersonalJoin!(f.offer)).resolves.toMatchObject({
    status: 'pending',
  });
  await first.owner.close();
  const loading = createStore<PlatformSessionState>({ status: 'loading' });
  const reloaded = f.boot(undefined, loading);
  // The page asks once, during app start; the login resolves afterwards.
  const pending = reloaded.runtime.pendingPersonalJoin!(id);
  loading.set(f.session.get());
  await expect(pending).resolves.toEqual({
    pairingSessionId: f.offer.pairingSessionId,
    offer: f.offer,
  });
});

/** A desktop-approved new phone holds the current key and opens sealed content. */
async function expectUnlocked(runtime: E2eeWorkspaceRuntime, id: string) {
  await expect(runtime.open(id, undefined, pairedAccount, 'reader-1')).resolves.toMatchObject({
    deviceKind: 'personal',
  });
  await expect(runtime.refresh(id, { keyMode: 'full' })).resolves.toMatchObject({
    hasCurrentKey: true,
  });
  const room = { kind: 'doc' as const, docId: 'doc-A' },
    context = {
      protocol: 'loro-streams-crdt-payload-protection' as const,
      version: 2 as const,
      kind: 'update_batch' as const,
    },
    body = new TextEncoder().encode('synthetic paired secret'),
    additionalData = Uint8Array.of(5);
  const sealed = await runtime.seal(id, {
    epoch: 0,
    room,
    context,
    plaintext: body,
    additionalData,
  });
  const opened = await runtime.openContent(id, { room, context, ...sealed, additionalData });
  try {
    expect(opened).toEqual(body);
  } finally {
    opened.fill(0);
  }
}

it('a new phone requests account pairing for every account workspace, and a desktop approval with a snapshot unlocks it', async () => {
  const f = await fixture(),
    id = f.offer.workspaceId;
  const phone = f.boot(undefined, f.pairedSession);
  const requested = await phone.runtime.requestAccountPairing!({});
  expect(requested).toMatchObject({
    status: 'waiting',
    direction: 'requester-shows',
    workspaces: [{ workspaceId: id, name: 'Team A', state: 'pending' }],
  });
  // The relay received the request, so a desktop can inspect it under the shown code.
  expect(f.pairingSubmission()?.workspaces).toEqual([
    { workspaceId: id, genesisHash: f.offer.genesisHash },
  ]);
  await expect(phone.runtime.accountPairingRequest!()).resolves.toMatchObject({
    status: 'waiting',
  });
  await f.approveAccountPairing(requested.pairingString!.replaceAll('-', ''), 'snapshot');
  await expect(phone.runtime.accountPairingRequest!()).resolves.toMatchObject({
    status: 'joined',
    workspaces: [{ workspaceId: id, state: 'joined' }],
  });
  await expectUnlocked(phone.runtime, id);
});

it('a new phone pairing for one named workspace joins through a history-only approval', async () => {
  const f = await fixture(),
    id = f.offer.workspaceId;
  f.listWorkspace({ id: 'workspace-B', name: 'Team B', genesisHash: '22'.repeat(32) });
  const phone = f.boot(undefined, f.pairedSession);
  const requested = await phone.runtime.requestAccountPairing!({
    workspace: { workspaceId: id, name: 'Team A', genesisHash: f.offer.genesisHash },
  });
  expect(requested.workspaces.map((workspace) => workspace.workspaceId)).toEqual([id]);
  // Only the named workspace prepares an identity; the other listed one is never touched.
  expect(f.historyReads).not.toContain('workspace-B');
  await f.approveAccountPairing(requested.pairingString!.replaceAll('-', ''), 'history');
  await expect(phone.runtime.accountPairingRequest!()).resolves.toMatchObject({
    status: 'joined',
  });
  await expectUnlocked(phone.runtime, id);
});

it('a pairing request naming a workspace with a different genesis is refused before anything reaches the relay', async () => {
  const f = await fixture();
  const phone = f.boot(undefined, f.pairedSession);
  await expect(
    phone.runtime.requestAccountPairing!({
      workspace: { workspaceId: f.offer.workspaceId, name: 'Team A', genesisHash: '00'.repeat(32) },
    })
  ).rejects.toMatchObject({ code: 'pairing-tampered' });
  expect(f.pairingSubmission()).toBeUndefined();
});

it('cancelling another request by its lookup ID keeps the waiting pairing request; its own ID ends it', async () => {
  const f = await fixture();
  const phone = f.boot(undefined, f.pairedSession);
  const requested = await phone.runtime.requestAccountPairing!({});
  await phone.runtime.cancelAccountPairing!({ expectedLookupId: 'ff'.repeat(16) });
  await expect(phone.runtime.accountPairingRequest!()).resolves.toMatchObject({
    status: 'waiting',
  });
  await phone.runtime.cancelAccountPairing!({ expectedLookupId: requested.lookupId! });
  await expect(phone.runtime.accountPairingRequest!()).resolves.toMatchObject({
    status: 'expired',
  });
});

it.each(['e2eeMembers:workspaces', 'e2eeWorkspaces:history'])(
  'an unanswered %s call fails the pairing request at its bound, and the next request succeeds',
  async (name) => {
    const f = await fixture();
    const clock = ManagedRuntime.make(TestClock.layer({ warningDelay: '1 hour' }));
    stops.push(() => clock.dispose());
    await clock.context();
    const phone = f.boot((program) => clock.runPromise(program), f.pairedSession);
    const hold = f.hold(name);
    const first = phone.runtime.requestAccountPairing!({}).then(
      () => null,
      (error: unknown) => error
    );
    await hold.entered;
    await clock.runPromise(TestClock.adjust(30_000));
    const failure = await first;
    expect(failure).toBeInstanceOf(Error);
    // An unanswered call proves nothing about access.
    expect(failure).not.toSatisfy(exactLoss('e2ee_device_revoked'));
    expect(f.pairingSubmission()).toBeUndefined();
    // The network recovers: the pairing lock was released, so the next request goes through.
    hold.release();
    await expect(phone.runtime.requestAccountPairing!({})).resolves.toMatchObject({
      status: 'waiting',
    });
  }
);

/** The shared providers recognise access loss only by these exact plain messages. */
const exactLoss = (code: 'e2ee_device_revoked' | 'e2ee_member_removed') => (error: unknown) =>
  error instanceof Error && error.constructor === Error && error.message === code;
const pinOf = (id: string) =>
  Effect.runPromise(personalEntryPins('lody-e2ee:mobile:v1:entry-pins').read('account-A', id));
async function pairedPhone() {
  const f = await fixture(),
    first = f.boot(),
    id = f.offer.workspaceId;
  await first.runtime.preparePersonalJoin!(f.offer);
  await f.approve();
  await first.runtime.claimPersonalJoin!(id, f.offer.pairingSessionId);
  await expect(first.runtime.open(id, undefined, 'account-A', 'reader-1')).resolves.toMatchObject({
    deviceKind: 'personal',
  });
  await first.runtime.refresh(id, { keyMode: 'full' });
  return { f, first, id };
}

it('a revoked phone reads the signed revocation despite its refused credential, stops routing its pairing and refuses with the exact code', async () => {
  const { f, first, id } = await pairedPhone();
  await f.revokePhone();
  // The credential-bound history is refused; the same history under the account login still
  // delivers the desktop-signed record, verified against the pinned genesis.
  const refreshed = await first.runtime.refresh(id).then(
    () => null,
    (error: unknown) => error
  );
  expect(refreshed).toSatisfy(exactLoss('e2ee_device_revoked'));
  // Same offer and genesis, no longer routed as ready: never deleted, never swapped.
  expect(await pinOf(id)).toEqual({
    version: 1,
    accountId: 'account-A',
    offer: f.offer,
    phase: 'cancelled',
  });
  // A relaunched app finds the verified revocation in its own ledger and refuses at once.
  await first.owner.close();
  const relaunched = f.boot();
  const reopened = await relaunched.runtime.open(id).then(
    () => null,
    (error: unknown) => error
  );
  expect(reopened).toSatisfy(exactLoss('e2ee_device_revoked'));
  // Another genesis is still refused for this workspace after revocation.
  const forged = await desktopOfferWithSeed(12);
  await expect(relaunched.runtime.preparePersonalJoin!(forged)).rejects.toMatchObject({
    code: 'conflict',
  });
  expect((await pinOf(id))?.offer).toEqual(f.offer);
});

it('an exact refusal of the content grant is access loss even before the ledger shows it', async () => {
  const { f, first, id } = await pairedPhone();
  f.refuse('e2eeContent:contentStreamsToken', 'e2ee_member_removed');
  const refused = await first.runtime.contentStreamsToken(id).then(
    () => null,
    (error: unknown) => error
  );
  expect(refused).toSatisfy(exactLoss('e2ee_member_removed'));
  expect((await pinOf(id))?.phase).toBe('cancelled');
});

it.each([
  ['an offline network', 'offline'],
  ['a non-terminal refusal', 'stale'],
  ['a matching code from an account-session endpoint', 'account-endpoint'],
  ['an uncertain login', 'uncertain'],
] as const)('%s never reports access loss or stops routing the pairing', async (_label, kind) => {
  const { f, first, id } = await pairedPhone();
  if (kind === 'offline') f.offline();
  if (kind === 'stale') f.refuse('e2eeContent:contentStreamsToken', 'e2ee_mailbox_ledger_stale');
  if (kind === 'account-endpoint') f.refuse('e2eeJoinMailbox:claim', 'e2ee_device_revoked');
  if (kind === 'uncertain') {
    f.refuseCredential('e2ee_device_revoked');
    f.session.set({ status: 'unauthenticated', uncertain: true });
  }
  const outcomes = await Promise.all(
    [
      () => first.runtime.refresh(id),
      () => first.runtime.contentStreamsToken(id),
      () => first.runtime.claimPersonalJoin!(id, f.offer.pairingSessionId),
    ].map((work) =>
      work().then(
        () => null,
        (error: unknown) => error
      )
    )
  );
  for (const outcome of outcomes) {
    expect(outcome).not.toSatisfy(exactLoss('e2ee_device_revoked'));
    expect(outcome).not.toSatisfy(exactLoss('e2ee_member_removed'));
  }
  expect((await pinOf(id))?.phase).toBe('ready');
});

it('a pairing cancelled before admission is never reported as revoked', async () => {
  const f = await fixture(),
    first = f.boot(),
    id = f.offer.workspaceId;
  await first.runtime.preparePersonalJoin!(f.offer);
  await first.runtime.cancelPersonalJoin!(id, f.offer.pairingSessionId);
  f.refuseCredential('e2ee_device_revoked');
  for (const work of [
    () => first.runtime.open(id),
    () => first.runtime.refresh(id),
    () => first.runtime.contentStreamsToken(id),
  ]) {
    const outcome = await work().then(
      () => null,
      (error: unknown) => error
    );
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).not.toSatisfy(exactLoss('e2ee_device_revoked'));
  }
});

it('a phone revoked while the app was closed reports the loss on its first cold read and stops routing its pairing', async () => {
  const { f, first, id } = await pairedPhone();
  await first.owner.close();
  await f.revokePhone();
  const cold = f.boot();
  // A runtime that verifies the ledger on open refuses there; one that opens from its local
  // ledger refuses on the first refresh, the provider's next call. Either way, exactly once.
  const opened = await cold.runtime.open(id).then(
    () => null,
    (error: unknown) => error
  );
  const loss =
    opened ??
    (await cold.runtime.refresh(id).then(
      () => null,
      (error: unknown) => error
    ));
  expect(loss).toSatisfy(exactLoss('e2ee_device_revoked'));
  expect(await pinOf(id)).toEqual({
    version: 1,
    accountId: 'account-A',
    offer: f.offer,
    phase: 'cancelled',
  });
});

it.each(['e2ee_device_revoked', 'e2ee_member_removed'] as const)(
  "the public runtime's exact %s from open stops routing the ready pairing",
  async (code) => {
    const { f, first, id } = await pairedPhone();
    await first.owner.close();
    const cold = f.boot();
    // The newer public runtime projects its verified-ledger loss as `Error(code)` with a code.
    boundary.openFailure = () => Object.assign(new Error(code), { code });
    try {
      const opened = await cold.runtime.open(id).then(
        () => null,
        (error: unknown) => error
      );
      expect(opened).toSatisfy(exactLoss(code));
    } finally {
      boundary.openFailure = undefined;
    }
    expect(await pinOf(id)).toMatchObject({ offer: f.offer, phase: 'cancelled' });
  }
);

it('a phone revoked while closed, asked to approve a new device before opening the workspace, stops offering it', async () => {
  const { f, first, id } = await pairedPhone();
  await first.owner.close();
  await f.revokePhone();
  const cold = f.boot();
  // The approver's first steps on an unopened workspace: acquire the session, then refresh.
  const loss = await cold.runtime.accountApproval!(id).then(
    async (approval) => {
      try {
        await approval.refresh();
        return null;
      } catch (error) {
        return error;
      } finally {
        await approval.release().catch(() => {});
      }
    },
    (error: unknown) => error
  );
  expect(loss).toSatisfy(exactLoss('e2ee_device_revoked'));
  expect((await pinOf(id))?.phase).toBe('cancelled');
});
it('only the exact plain loss result from the runtime is trusted, never a look-alike', async () => {
  const { f, first, id } = await pairedPhone();
  await first.owner.close();
  const cold = f.boot();
  for (const failure of [
    () => new TypeError('e2ee_device_revoked'),
    () => new Error('e2ee_device_revoked: synthetic detail'),
    () => ({ message: 'e2ee_device_revoked' }),
  ]) {
    boundary.openFailure = failure;
    try {
      const opened = await cold.runtime.open(id).then(
        () => null,
        (error: unknown) => error
      );
      expect(opened).not.toSatisfy(exactLoss('e2ee_device_revoked'));
    } finally {
      boundary.openFailure = undefined;
    }
  }
  expect((await pinOf(id))?.phase).toBe('ready');
});
it('approval treats only the exact status loss as access loss: a transient or look-alike status failure keeps the pairing, and the next session proceeds', async () => {
  const { f, first, id } = await pairedPhone();
  await first.owner.close();
  const cold = f.boot();
  for (const failure of [
    () => Object.assign(new Error('synthetic timeout'), { code: 'network' }),
    () => new TypeError('e2ee_device_revoked'),
    () => new Error('e2ee_member_removed: synthetic detail'),
  ]) {
    boundary.statusFailure = failure;
    try {
      const approval = await cold.runtime.accountApproval!(id);
      try {
        await approval.refresh();
      } finally {
        await approval.release();
      }
    } finally {
      boundary.statusFailure = undefined;
    }
    expect((await pinOf(id))?.phase).toBe('ready');
  }
  // Once the status read answers again, the same device approves as before.
  const approval = await cold.runtime.accountApproval!(id);
  try {
    await approval.refresh();
    expect(approval.device).toMatch(/^[0-9a-f]{64}$/);
  } finally {
    await approval.release();
  }
  expect((await pinOf(id))?.phase).toBe('ready');
});

it('finishes a retained account request and installs its key while workspace directory queries are unavailable', async () => {
  const f = await fixture(),
    id = f.offer.workspaceId;
  const phone = f.boot(undefined, f.pairedSession);
  f.workspaceListReads.count = 0;
  const requested = await phone.runtime.requestAccountPairing!({
    workspace: { workspaceId: id, name: 'Team A', genesisHash: f.offer.genesisHash },
  });
  expect(f.workspaceListReads.count).toBe(1);
  await f.approveAccountPairing(requested.pairingString!.replaceAll('-', ''), 'history');
  f.workspaceListReads.count = 0;
  f.refuse('e2eeMembers:workspaces', 'directory_unavailable');
  await expect(phone.runtime.accountPairingRequest!()).resolves.toMatchObject({
    status: 'joined',
  });
  expect(f.workspaceListReads.count).toBe(0);
  const installed = await phone.runtime.open(id);
  expect(installed.hasCurrentKey).toBe(true);
});
