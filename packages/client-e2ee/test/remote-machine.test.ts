import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { Effect, Exit, Result, Scope } from 'effect';
import { IDBFactory } from 'fake-indexeddb';
import { getFunctionName } from 'convex/server';
import {
  Bytes,
  hashRecordBytes,
  prepareDeviceAdmission,
  signDeviceCredentialBinding,
  signGenesisRecord,
  signLedgerRecord,
  prepareLedgerCommand,
  prepareJoinRequest,
  prepareEpochEnvelope,
  openEpochEnvelope,
  commitEpochKey,
  verifyLedger,
  type LedgerView,
} from '@lody/e2ee-core/protocol';
import { importBrowserDevice } from '@lody/e2ee-core/adapters/browser-crypto';
import {
  makeRemoteMachinePairing,
  type RemoteMachineJournal,
} from '@lody/e2ee-client/remote-machine';
import type { LocalE2eePrepareResponse } from '@lody/shared/e2ee-local-pairing';
import type { RemoteMachineStatus, RemoteMachineOffer } from '@lody/shared/e2ee-remote-pairing';
import { remoteMachineStore } from '../src/remote-machine-store';
import { makePersonalCloudNetwork, hex, raw, type PersonalCloudConnection } from '../src/network';

beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()));
afterEach(() => vi.unstubAllGlobals());
const run = Effect.runPromise;
async function fixture() {
  const scope = await run(Scope.make());
  const device = await run(
    Scope.provide(
      importBrowserDevice({
        signingPrivate: new Uint8Array(32).fill(10),
        encryptionPrivate: new Uint8Array(32).fill(11),
      }),
      scope
    )
  );
  const machine = await run(
    Scope.provide(
      importBrowserDevice({
        signingPrivate: new Uint8Array(32).fill(12),
        encryptionPrivate: new Uint8Array(32).fill(13),
      }),
      scope
    )
  );
  const membershipId = Result.getOrThrow(Bytes.membershipId(new Uint8Array(16).fill(10)));
  const initialKey = Result.getOrThrow(Bytes.epochKey(new Uint8Array(32).fill(42)));
  const signed = await run(
    signGenesisRecord({
      signer: device,
      encryptionPublicKey: device.enc,
      initialKey,
      membershipId,
      userId: Result.getOrThrow(Bytes.userId(new Uint8Array(32).fill(8))),
    })
  );
  let approver = device;
  const records: Uint8Array[] = [signed.record];
  const verify = (): LedgerView =>
    Result.getOrThrow(
      verifyLedger({
        anchor: signed.genesis,
        records,
        checkpoint: { head: hashRecordBytes(records[records.length - 1]!), length: records.length },
      })
    );
  let view = verify();
  let backendRecords: Uint8Array[] = [...records];
  let offer: RemoteMachineOffer | undefined;
  let material: LocalE2eePrepareResponse | null = null;
  let phase: RemoteMachineStatus['status'] = 'pending';
  let appendGate: { entered(): void; wait: Promise<void>; done(): void } | undefined;
  let lostAck = false;
  let distributionFailure = false;
  let revokedRefusal = false;
  let wrongSession = false;
  let account: string | null = 'account-A';
  const sent: { recordHex: string; requestId: string }[] = [];
  const mailbox: { recipient: string; epoch: number }[] = [];
  const reply = (): RemoteMachineStatus => ({
    pairingSessionId: wrongSession ? 'ff'.repeat(16) : offer!.pairingSessionId,
    status: phase,
    expiresAt: offer!.expiresAt,
    material,
    location: { city: 'Test City', country: 'Test Country' },
    ...(['cancelled', 'expired'].includes(phase) ? { noAdmissionReserved: sent.length === 0 } : {}),
  });
  const invoke = async (
    ref: Parameters<typeof getFunctionName>[0],
    input: unknown
  ): Promise<unknown> => {
    const name = getFunctionName(ref);
    const args = input as Record<string, unknown>;
    if (args.workspaceId !== 'workspace-A') throw new Error('wrong workspace');
    if (revokedRefusal) throw { data: { code: 'e2ee_pairing_key_revoked' } };
    if (name === 'e2eeMachinePairing:begin') {
      offer = args.offer as RemoteMachineOffer;
      return reply();
    }
    if (name === 'e2eeMachinePairing:inspect' || name === 'e2eeMachinePairing:authorizeExisting')
      return reply();
    if (name === 'e2eeMachinePairing:cancel') {
      if (phase === 'admitting' || phase === 'admitted') return reply();
      phase = 'cancelled';
      return reply();
    }
    if (name === 'e2eeWorkspaces:appendRecord') {
      sent.push({ recordHex: args.recordHex as string, requestId: args.requestId as string });
      const held = appendGate;
      if (held) {
        phase = 'admitting';
        held.entered();
        await held.wait;
      }
      const record = raw(args.recordHex as string);
      if (!backendRecords.some((r) => hex(r) === hex(record))) backendRecords.push(record);
      phase = 'admitted';
      held?.done();
      if (lostAck) throw new Error('lost acknowledgement');
      return { status: 'committed' };
    }
    throw new Error(`unexpected endpoint ${name}`);
  };
  const network = makePersonalCloudNetwork({
    scope: { accountId: 'account-A', workspaceId: 'workspace-A', genesis: signed.genesis },
    client: {
      query: invoke,
      mutation: invoke,
      action: invoke,
    } as PersonalCloudConnection['client'],
    currentAccount: () => Effect.succeed(account),
  });
  const store = remoteMachineStore('test-remote-machine');
  let unauthorized = false;
  const make = () =>
    makeRemoteMachinePairing({
      accountId: 'account-A',
      workspaceId: 'workspace-A',
      genesisRecordHex: hex(signed.record),
      credential: 'credential',
      signer: approver,
      endpoints: {
        deploymentUrl: 'https://deployment.example',
        ingressUrl: 'https://ingress.example',
      },
      relay: network.remoteMachine,
      store,
      current: () =>
        unauthorized ? Effect.fail(new Error('e2ee_device_revoked')) : Effect.succeed(view),
      local: (work) => work,
      records: () => Effect.succeed(records),
      refresh: () =>
        Effect.sync(() => {
          records.splice(0, records.length, ...backendRecords);
          view = verify();
        }),
      keyRound: (recipient) =>
        distributionFailure
          ? Effect.fail(new Error('mailbox unavailable'))
          : Effect.gen(function* () {
              expect(view.inspectState().devices.has(recipient)).toBe(true);
              const context = {
                genesis: signed.genesis,
                epoch: Result.getOrThrow(Bytes.epochNumber(0)),
                sender: approver.publicKey,
                recipient: machine.publicKey,
              };
              const frame = yield* prepareEpochEnvelope({
                context,
                key: initialKey,
                signer: approver,
                ledger: () => Effect.succeed(view),
              });
              const installed = yield* openEpochEnvelope({
                context,
                pair: machine.encryption,
                frame,
                ledger: () => Effect.succeed(view),
              });
              expect(Result.getOrThrow(commitEpochKey(signed.genesis, 0, installed))).toEqual(
                Result.getOrThrow(commitEpochKey(signed.genesis, 0, initialKey))
              );
              mailbox.push({ recipient, epoch: view.inspectState().epoch.number });
              phase = 'ready';
            }),
    });
  const claim = async () => {
    const proof = await run(
      prepareDeviceAdmission({
        genesis: signed.genesis,
        membershipId: Result.getOrThrow(Bytes.membershipId(raw(offer!.membershipId))),
        kind: 'machine',
        machineId: 'machine-A',
        signer: machine,
        encryptionPublicKey: machine.enc,
      })
    );
    const credentialHash = new Uint8Array(32).fill(0x73);
    const bound = await run(
      signDeviceCredentialBinding({
        genesis: signed.genesis,
        pairingSessionId: raw(offer!.pairingSessionId),
        signingPublicKey: machine.publicKey,
        credentialHash,
        signer: machine,
      })
    );
    material = {
      ok: true,
      type: 'prepare',
      machineId: 'machine-A',
      pairingSessionId: offer!.pairingSessionId,
      signingPublicKey: hex(machine.publicKey.toBytes()),
      encryptionPublicKey: hex(machine.enc.toBytes()),
      possessionSignature: hex(proof.possessionSignature.toBytes()),
      credentialHash: hex(credentialHash),
      bindingSignature: hex(bound.toBytes()),
      protection: 'file',
    };
    phase = 'claimed';
  };
  const command = async (command: Parameters<typeof prepareLedgerCommand>[2]) => {
    const proposal = Result.getOrThrow(prepareLedgerCommand(view, device.publicKey, command));
    backendRecords.push(await run(signLedgerRecord(proposal, device)));
    records.splice(0, records.length, ...backendRecords);
    view = verify();
  };
  const addMember = async (role: 'admin' | 'member' | 'guest') => {
    const personal = await run(
      Scope.provide(
        importBrowserDevice({
          signingPrivate: new Uint8Array(32).fill(20),
          encryptionPrivate: new Uint8Array(32).fill(21),
        }),
        scope
      )
    );
    const membership = Result.getOrThrow(Bytes.membershipId(new Uint8Array(16).fill(20)));
    const request = await run(
      prepareJoinRequest({
        genesis: signed.genesis,
        requestId: Result.getOrThrow(Bytes.requestId(membership.toBytes())),
        userId: Result.getOrThrow(Bytes.userId(new Uint8Array(32).fill(20))),
        encryptionPublicKey: personal.enc,
        expiresAt: 9000000000000,
        signer: personal,
      })
    );
    await command({ _tag: 'AdmitMember', membershipId: membership, request });
    if (role !== 'member') await command({ _tag: 'SetRole', membershipId: membership, role });
    approver = personal;
    return membership;
  };
  return {
    make,
    holdAppend: () => {
      let entered!: () => void, release!: () => void, done!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const settled = new Promise<void>((resolve) => {
        done = resolve;
      });
      appendGate = { entered, wait, done };
      return {
        started,
        settled,
        release: () => {
          appendGate = undefined;
          release();
        },
      };
    },
    store,
    claim,
    sent,
    mailbox,
    command,
    addMember,
    membershipId,
    device,
    machine,
    set lostAck(value: boolean) {
      lostAck = value;
    },
    set distributionFailure(value: boolean) {
      distributionFailure = value;
    },
    set revokedRefusal(value: boolean) {
      revokedRefusal = value;
    },
    set wrongSession(value: boolean) {
      wrongSession = value;
    },
    set unauthorized(value: boolean) {
      unauthorized = value;
    },
    set account(value: string | null) {
      account = value;
    },
    get view() {
      return view;
    },
    get material() {
      return material!;
    },
    close: () => run(Scope.close(scope, Exit.void)),
  };
}
it('runs the portable command, fingerprint, admission and key delivery lifecycle through the public cloud DTOs', async () => {
  const f = await fixture();
  try {
    const workflow = f.make();
    const begin = await run(workflow.begin());
    expect(begin.status).toBe('pending');
    const encoded = begin.command.split('--offer ')[1]!;
    const offer = JSON.parse(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')));
    expect(offer.workspaceId).toBe('workspace-A');
    await f.claim();
    const preview = await run(workflow.inspect(begin.pairingSessionId));
    expect(preview.summary).toMatch(/^[0-9a-f]{8}( [0-9a-f]{8}){7}$/);
    expect(preview.location?.city).toBe('Test City');
    await expect(
      run(workflow.approve(begin.pairingSessionId, 'wrong fingerprint'))
    ).rejects.toThrow('e2ee_conflict');
    expect(f.sent).toEqual([]);
    expect(await run(workflow.approve(begin.pairingSessionId, preview.summary!))).toEqual({
      admitted: true,
      ready: true,
    });
    expect(f.view.inspectState().devices.get(f.material.signingPublicKey)?.kind).toBe('machine');
    expect(f.mailbox).toEqual([{ recipient: f.material.signingPublicKey, epoch: 0 }]);
    expect((await run(workflow.inspect(begin.pairingSessionId))).status).toBe('ready');
  } finally {
    await f.close();
  }
});
it('reopens retained command and approval after a committed append loses its acknowledgement and delivery fails', async () => {
  const f = await fixture();
  try {
    const first = f.make();
    const begin = await run(first.begin());
    await f.claim();
    const preview = await run(first.inspect(begin.pairingSessionId));
    f.lostAck = true;
    f.distributionFailure = true;
    await expect(run(first.approve(begin.pairingSessionId, preview.summary!))).rejects.toThrow(
      'mailbox unavailable'
    );
    const original = await run(f.store.read());
    expect(original?.request).not.toBeNull();
    await expect(run(first.cancel(begin.pairingSessionId))).rejects.toThrow('e2ee_conflict');
    expect(await run(f.store.read())).toEqual(original);
    f.distributionFailure = false;
    const reopened = f.make();
    expect((await run(reopened.begin())).command).toBe(begin.command);
    expect(await run(reopened.approve(begin.pairingSessionId, preview.summary!))).toEqual({
      admitted: true,
      ready: true,
    });
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]).toEqual(f.sent[0]);
    expect(f.view.length).toBe(2);
  } finally {
    await f.close();
  }
});
it('cancels before signing and creates a fresh command while retaining the archived original', async () => {
  const f = await fixture();
  try {
    const first = await run(f.make().begin());
    expect((await run(f.make().cancel(first.pairingSessionId))).status).toBe('cancelled');
    const old = await run(f.store.read());
    expect(old?.retired).toBe(true);
    const next = await run(f.make().begin());
    expect(next.pairingSessionId).not.toBe(first.pairingSessionId);
    expect(f.sent).toEqual([]);
    expect(f.mailbox).toEqual([]);
    const archived = await new Promise<RemoteMachineJournal>((resolve, reject) => {
      const request = indexedDB.open('test-remote-machine');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('originals');
        const read = tx.objectStore('originals').get(first.pairingSessionId);
        tx.oncomplete = () => {
          db.close();
          resolve(read.result);
        };
      };
    });
    expect(archived).toEqual(old);
  } finally {
    await f.close();
  }
});
it('rejects a claimed identity once its signing key has been revoked, even on approval resume', async () => {
  const f = await fixture();
  try {
    const w = f.make();
    const first = await run(w.begin());
    await f.claim();
    const preview = await run(w.inspect(first.pairingSessionId));
    await run(w.approve(first.pairingSessionId, preview.summary!));
    await f.command({ _tag: 'RevokeDevice', target: f.machine.publicKey });
    await expect(run(f.make().approve(first.pairingSessionId, preview.summary!))).rejects.toThrow(
      'e2ee_pairing_key_revoked'
    );
    expect(f.sent).toHaveLength(1);
  } finally {
    await f.close();
  }
});
it('fails closed on loss of the approving device, mismatched relay session and account changes', async () => {
  const f = await fixture();
  try {
    const w = f.make();
    const first = await run(w.begin());
    await f.claim();
    f.wrongSession = true;
    await expect(run(w.inspect(first.pairingSessionId))).rejects.toThrow('e2ee_conflict');
    f.wrongSession = false;
    f.unauthorized = true;
    await expect(run(w.begin())).rejects.toThrow('e2ee_device_revoked');
    await expect(run(w.approve(first.pairingSessionId, 'anything'))).rejects.toThrow(
      'e2ee_device_revoked'
    );
    f.unauthorized = false;
    f.account = 'account-B';
    await expect(run(w.inspect(first.pairingSessionId))).rejects.toThrow();
    expect(f.sent).toEqual([]);
    expect(f.mailbox).toEqual([]);
  } finally {
    await f.close();
  }
});

it.each(['admin', 'member'] as const)(
  'allows an active %s to approve only its own machine',
  async (role) => {
    const f = await fixture();
    try {
      const member = await f.addMember(role);
      const w = f.make();
      const first = await run(w.begin());
      await f.claim();
      const preview = await run(w.inspect(first.pairingSessionId));
      expect(await run(w.approve(first.pairingSessionId, preview.summary!))).toEqual({
        admitted: true,
        ready: true,
      });
      expect(
        f.view.inspectState().devices.get(f.material.signingPublicKey)?.membershipId.equals(member)
      ).toBe(true);
    } finally {
      await f.close();
    }
  }
);
it('refuses guest begin and approval after the approver is downgraded to guest', async () => {
  const f = await fixture();
  try {
    const membership = await f.addMember('member');
    const w = f.make();
    const first = await run(w.begin());
    await f.claim();
    const preview = await run(w.inspect(first.pairingSessionId));
    await f.command({ _tag: 'SetRole', membershipId: membership, role: 'guest' });
    await expect(run(w.begin())).rejects.toThrow('e2ee_management_unauthorized');
    await expect(run(w.approve(first.pairingSessionId, preview.summary!))).rejects.toThrow(
      'e2ee_management_unauthorized'
    );
    expect(f.sent).toEqual([]);
    expect(f.mailbox).toEqual([]);
  } finally {
    await f.close();
  }
});
it('retains originals when the backend refuses a revoked pairing key', async () => {
  const f = await fixture();
  try {
    const w = f.make();
    const first = await run(w.begin());
    await f.claim();
    const preview = await run(w.inspect(first.pairingSessionId));
    const before = await run(f.store.read());
    f.revokedRefusal = true;
    await expect(run(w.approve(first.pairingSessionId, preview.summary!))).rejects.toThrow(
      'e2ee_pairing_key_revoked'
    );
    expect(await run(f.store.read())).toEqual(before);
    expect(f.sent).toEqual([]);
  } finally {
    await f.close();
  }
});
it('refuses a persisted command for another workspace and rejects a stale original writer', async () => {
  const f = await fixture();
  try {
    const w = f.make();
    await run(w.begin());
    const old = (await run(f.store.read()))!;
    await run(f.store.save(old, { ...old, offer: { ...old.offer, workspaceId: 'workspace-B' } }));
    await expect(run(w.begin())).rejects.toThrow('e2ee_conflict');
    await expect(run(f.store.save(old, { ...old, retired: true }))).rejects.toThrow(
      'e2ee_remote_pairing_storage'
    );
    expect(f.sent).toEqual([]);
    expect(f.mailbox).toEqual([]);
  } finally {
    await f.close();
  }
});

it('refuses approval after its member is removed from the verified ledger', async () => {
  const f = await fixture();
  try {
    const membership = await f.addMember('member');
    const w = f.make();
    const first = await run(w.begin());
    await f.claim();
    const preview = await run(w.inspect(first.pairingSessionId));
    await f.command({ _tag: 'DeclareCapabilities', capabilities: [1] });
    await f.command({ _tag: 'RemoveMember', membershipId: membership });
    await expect(run(w.begin())).rejects.toThrow('e2ee_management_unauthorized');
    await expect(run(w.approve(first.pairingSessionId, preview.summary!))).rejects.toThrow(
      'e2ee_management_unauthorized'
    );
    expect(f.sent).toEqual([]);
    expect(f.mailbox).toEqual([]);
  } finally {
    await f.close();
  }
});

it('resumes the same admission after its waiting caller is interrupted during dispatch', async () => {
  const f = await fixture();
  try {
    const w = f.make();
    const first = await run(w.begin());
    await f.claim();
    const preview = await run(w.inspect(first.pairingSessionId));
    const gate = f.holdAppend();
    const abort = new AbortController();
    const pending = Effect.runPromiseExit(w.approve(first.pairingSessionId, preview.summary!), {
      signal: abort.signal,
    });
    await gate.started;
    abort.abort();
    expect(Exit.isFailure(await pending)).toBe(true);
    const original = (await run(f.store.read()))!.request;
    expect(original).not.toBeNull();
    expect(f.mailbox).toEqual([]);
    gate.release();
    await gate.settled;
    expect(await run(f.make().approve(first.pairingSessionId, preview.summary!))).toEqual({
      admitted: true,
      ready: true,
    });
    expect(f.sent).toEqual([original, original]);
    expect(f.view.length).toBe(2);
  } finally {
    await f.close();
  }
});
