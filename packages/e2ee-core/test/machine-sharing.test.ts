import { afterEach, describe, expect, it, vi } from 'vitest';
import { Deferred, Effect, Fiber, Result } from 'effect';
import * as P from '@lody/e2ee-core/protocol';
import { admitMachineSharingFrame } from '@lody/e2ee-core/host';
import { envelopeFixture } from './keys/fixture';
import { disposeEpochKey } from '../src/internal/foundation/epoch-key';
import {
  decodeMachineSharingCbor,
  encodeMachineSharingCbor,
} from '../src/internal/foundation/cbor';

const ok = Result.getOrThrow;
const hex = (value: { toBytes(): Uint8Array }) => Buffer.from(value.toBytes()).toString('hex');
const filled = (n: number, size = 32) => new Uint8Array(size).fill(n);
const failure = (value: Result.Result<unknown, { code: string }>) =>
  Result.isFailure(value) ? value.failure.code : 'accepted';
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((f) => f());
  vi.restoreAllMocks();
});

async function fixture() {
  let nonce = 0;
  vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((out) => {
    (out as Uint8Array).fill(++nonce);
    return out;
  });
  const f = envelopeFixture(1);
  cleanup.push(() => disposeEpochKey(f.secret));
  let view = f.view();
  const command = async (intent: P.LedgerCommand, signer = f.owner.signer) => {
    const prepared = ok(P.prepareLedgerCommand(view, signer.publicKey, intent));
    const original = await Effect.runPromise(P.signLedgerRecord(prepared, signer));
    view = ok(
      P.extendLedger(view, [original], {
        head: P.hashRecordBytes(original),
        length: view.length + 1,
      })
    );
  };
  const bob = f.ed(20),
    second = f.ed(21),
    recovery = f.ed(22);
  const bobMembership = ok(P.Bytes.membershipId(filled(20, 16)));
  const request = await Effect.runPromise(
    P.prepareJoinRequest({
      genesis: view.genesis,
      requestId: ok(P.Bytes.requestId(filled(20, 16))),
      userId: ok(P.Bytes.userId(filled(20))),
      encryptionPublicKey: ok(P.Bytes.encryptionPublicKey(filled(120))),
      expiresAt: null,
      signer: bob.signer,
    })
  );
  await command({ _tag: 'AdmitMember', membershipId: bobMembership, request });
  for (const [target, kind, n] of [
    [second, 'personal', 121],
    [recovery, 'recovery', 122],
  ] as const) {
    await command(
      await Effect.runPromise(
        P.prepareDeviceAdmission({
          genesis: view.genesis,
          membershipId: view.inspectState().owner,
          encryptionPublicKey: ok(P.Bytes.encryptionPublicKey(filled(n))),
          kind,
          signer: target.signer,
        })
      )
    );
  }
  const binding: P.MachineSharingBinding = {
    workspaceId: 'workspace-a',
    genesisHash: hex(view.genesis),
    machineId: 'fixture-machine',
    ownerMembershipId: hex(view.inspectState().owner),
  };
  const scope = ok(P.machineSharingContentScope(binding, 0));
  const key = ok(P.deriveDocumentKey(scope, f.secret));
  cleanup.push(() => P.disposeDocumentKey(key));
  const policy: P.MachineSharingPolicy = {
    ...binding,
    revision: 1,
    previousDigest: null,
    requestId: '31'.repeat(16),
    sharedWithTeam: true,
    projects: ['project-a'],
    signer: hex(f.owner.publicKey),
    issuedAt: 1234,
  };
  const seal = (body = policy, signer = f.owner.signer) =>
    Effect.runPromise(
      P.sealMachineSharingPolicy({
        policy: body,
        epoch: 0,
        documentKey: key,
        signer,
        ledger: () => Effect.succeed(view),
      })
    );
  const open = (frame: Uint8Array, previous: P.MachineSharingHead | null = null, revision = 1) =>
    P.openMachineSharingPolicy({
      ledger: view,
      binding,
      epoch: 0,
      documentKey: key,
      frame,
      expectedHead: { revision, digest: ok(P.machineSharingDigest(frame)) },
      previous,
    });
  const authorize = (
    evidence: P.VerifiedMachineSharingPolicy | null,
    signer = bob.publicKey,
    localProjectId?: string
  ) =>
    P.authorizeMachineExecution({
      ledger: view,
      policy: evidence,
      signer,
      target: {
        workspaceId: binding.workspaceId,
        genesisHash: binding.genesisHash,
        machineId: binding.machineId,
        device: f.phone.publicKey,
      },
      localProjectId,
    });
  return {
    ...f,
    bob,
    bobMembership,
    second,
    recovery,
    binding,
    scope,
    key,
    policy,
    seal,
    open,
    authorize,
    command,
    current: () => view,
  };
}

describe('owner-signed complete machine sharing policies', () => {
  it('preserves project records while applying the existing atomic switch semantics', () => {
    const privateState = { sharedWithTeam: false, projects: [] };
    const enabled = ok(
      P.updateMachineSharingState(privateState, {
        kind: 'project',
        localProjectId: 'project-a',
        sharedWithTeam: true,
      })
    );
    expect(enabled).toEqual({ sharedWithTeam: true, projects: ['project-a'] });
    const disabled = ok(
      P.updateMachineSharingState(enabled, { kind: 'machine', sharedWithTeam: false })
    );
    expect(disabled).toEqual({ sharedWithTeam: false, projects: ['project-a'] });
    expect(
      ok(
        P.updateMachineSharingState(enabled, {
          kind: 'project',
          localProjectId: 'project-a',
          sharedWithTeam: false,
        })
      )
    ).toEqual({ sharedWithTeam: true, projects: [] });
    expect(privateState).toEqual({ sharedWithTeam: false, projects: [] });
  });
  it('round trips canonical state and keeps projects independent of the machine switch', async () => {
    const f = await fixture();
    const body = { ...f.policy, projects: ['project-z', 'project-a'], sharedWithTeam: false };
    const encoded = ok(P.encodeMachineSharingPolicy(body));
    expect(ok(P.decodeMachineSharingPolicy(encoded))).toEqual({
      ...body,
      projects: ['project-a', 'project-z'],
    });
    expect(
      ok(P.encodeMachineSharingPolicy({ ...body, projects: [...body.projects].reverse() }))
    ).toEqual(encoded);
    const verified = ok(f.open(await f.seal(body)));
    expect(f.authorize(verified, f.bob.publicKey, 'project-a')).toEqual({
      allowed: false,
      reason: 'machine-not-shared',
    });
    expect(f.authorize(null, f.owner.publicKey, 'private-project')).toEqual({
      allowed: true,
      reason: 'owner',
    });
  });

  it('requires both switches for cross-member projects and accepts future qualified members', async () => {
    const f = await fixture();
    const verified = ok(f.open(await f.seal()));
    expect(f.authorize(verified)).toEqual({ allowed: true, reason: 'team' });
    expect(f.authorize(verified, f.bob.publicKey, 'project-a')).toEqual({
      allowed: true,
      reason: 'team',
    });
    expect(f.authorize(verified, f.bob.publicKey, 'project-b')).toEqual({
      allowed: false,
      reason: 'project-not-shared',
    });
    expect(f.authorize(null)).toEqual({ allowed: false, reason: 'policy-unavailable' });
    const future = f.ed(23),
      futureMembership = ok(P.Bytes.membershipId(filled(23, 16)));
    const request = await Effect.runPromise(
      P.prepareJoinRequest({
        genesis: f.current().genesis,
        requestId: ok(P.Bytes.requestId(filled(23, 16))),
        userId: ok(P.Bytes.userId(filled(23))),
        encryptionPublicKey: ok(P.Bytes.encryptionPublicKey(filled(123))),
        expiresAt: null,
        signer: future.signer,
      })
    );
    await f.command({ _tag: 'AdmitMember', membershipId: futureMembership, request });
    expect(f.authorize(verified, future.publicKey).allowed).toBe(true);
    await f.command({ _tag: 'SetRole', membershipId: f.bobMembership, role: 'admin' });
    expect(f.authorize(verified).allowed).toBe(true);
    await f.command({ _tag: 'SetRole', membershipId: f.bobMembership, role: 'guest' });
    expect(f.authorize(verified)).toEqual({ allowed: false, reason: 'requester-ineligible' });
    expect(f.authorize(verified, f.recovery.publicKey)).toEqual({
      allowed: false,
      reason: 'requester-ineligible',
    });
  });

  it('rejects workspace, genesis, machine, ownership and signer substitutions', async () => {
    const f = await fixture(),
      frame = await f.seal();
    const head = { revision: 1, digest: ok(P.machineSharingDigest(frame)) };
    for (const change of [
      { workspaceId: 'other' },
      { genesisHash: '99'.repeat(32) },
      { machineId: 'other' },
      { ownerMembershipId: '99'.repeat(16) },
    ]) {
      expect(
        Result.isFailure(
          P.openMachineSharingPolicy({
            ledger: f.current(),
            binding: { ...f.binding, ...change },
            epoch: 0,
            documentKey: f.key,
            frame,
            expectedHead: head,
            previous: null,
          })
        )
      ).toBe(true);
    }
    for (const signer of [f.bob.signer, f.phone.signer, f.recovery.signer]) {
      const outcome = await Effect.runPromise(
        Effect.result(
          P.sealMachineSharingPolicy({
            policy: { ...f.policy, signer: hex(signer.publicKey) },
            epoch: 0,
            documentKey: f.key,
            signer,
            ledger: () => Effect.succeed(f.current()),
          })
        )
      );
      expect(failure(outcome)).toBe('policy-signer-ineligible');
    }
    const verified = ok(f.open(frame));
    expect(
      P.authorizeMachineExecution({
        ledger: f.current(),
        policy: verified,
        signer: f.bob.publicKey,
        target: {
          workspaceId: 'workspace-a',
          genesisHash: f.binding.genesisHash,
          machineId: 'wrong',
          device: f.phone.publicKey,
        },
      })
    ).toEqual({ allowed: false, reason: 'target-ineligible' });
    expect(f.authorize({ ...verified } as P.VerifiedMachineSharingPolicy)).toEqual({
      allowed: false,
      reason: 'policy-unverified',
    });
  });

  it('rechecks signer revocation and never falls back to an older allow policy', async () => {
    const f = await fixture(),
      original = await f.seal({ ...f.policy, projects: ['project-a', 'project-z'] });
    const verified = ok(f.open(original));
    await f.command({ _tag: 'RevokeDevice', target: f.owner.publicKey }, f.second.signer);
    expect(f.authorize(verified)).toEqual({ allowed: false, reason: 'policy-signer-ineligible' });
    expect(failure(f.open(original))).toBe('policy-signer-ineligible');
    // A fresh machine may traverse revoked history, but that result is no execution capability.
    const historical = ok(
      P.verifyMachineSharingHistoryStep({
        ledger: f.current(),
        binding: f.binding,
        epoch: 0,
        documentKey: f.key,
        frame: original,
        expectedHead: verified.head,
        previous: null,
      })
    );
    expect(historical).toEqual(verified.head);
    expect(f.authorize(historical as unknown as P.VerifiedMachineSharingPolicy)).toEqual({
      allowed: false,
      reason: 'policy-unverified',
    });
    const historyInput = {
      ledger: f.current(),
      binding: f.binding,
      epoch: 0,
      documentKey: f.key,
      frame: original,
      expectedHead: verified.head,
      previous: null,
    };
    const history = ok(P.readMachineSharingHistoryStep(historyInput));
    expect(history).toEqual({
      _tag: 'MachineSharingHistoryStep',
      head: verified.head,
      policy: { ...f.policy, projects: ['project-a', 'project-z'] },
    });
    expect(f.authorize(history as unknown as P.VerifiedMachineSharingPolicy)).toEqual({
      allowed: false,
      reason: 'policy-unverified',
    });
    const retained = ok(P.restoreVerifiedState(ok(P.exportVerifiedState(f.current()))));
    expect(ok(P.readMachineSharingHistoryStep({ ...historyInput, ledger: retained }))).toEqual(
      history
    );
    expect(
      Result.isFailure(
        P.readMachineSharingHistoryStep({
          ...historyInput,
          binding: { ...f.binding, workspaceId: 'wrong-workspace' },
        })
      )
    ).toBe(true);
    expect(
      Result.isFailure(
        P.readMachineSharingHistoryStep({
          ...historyInput,
          expectedHead: { ...verified.head, digest: 'ff'.repeat(32) },
        })
      )
    ).toBe(true);
    const next = {
      ...history.policy,
      revision: history.head.revision + 1,
      previousDigest: history.head.digest,
      requestId: '32'.repeat(16),
      signer: hex(f.second.publicKey),
    };
    const current = ok(f.open(await f.seal(next, f.second.signer), verified.head, 2));
    expect(f.authorize(current).allowed).toBe(true);
    expect(current.inspect().projects).toEqual(['project-a', 'project-z']);
  });

  it('rejects a retired machine key while preserving policy across same-member replacement', async () => {
    const f = await fixture(),
      verified = ok(f.open(await f.seal()));
    const replacement = f.ed(24);
    const admission = await Effect.runPromise(
      P.prepareDeviceAdmission({
        genesis: f.current().genesis,
        membershipId: f.current().inspectState().owner,
        encryptionPublicKey: ok(P.Bytes.encryptionPublicKey(filled(124))),
        kind: 'machine',
        machineId: f.binding.machineId,
        signer: replacement.signer,
      })
    );
    await f.command({ ...admission, replaces: f.phone.publicKey });
    expect(f.authorize(verified)).toEqual({ allowed: false, reason: 'target-ineligible' });
    expect(
      P.authorizeMachineExecution({
        ledger: f.current(),
        policy: verified,
        signer: f.bob.publicKey,
        target: { ...f.binding, device: replacement.publicKey },
      })
    ).toEqual({ allowed: true, reason: 'team' });
  });

  it('refuses policies from a newer ledger on an older/forged view and never trusts detached state', async () => {
    const f = await fixture(),
      before = f.current();
    await f.command({ _tag: 'SetRole', membershipId: f.bobMembership, role: 'admin' });
    const verified = ok(f.open(await f.seal()));
    const input = {
      policy: verified,
      signer: f.bob.publicKey,
      target: { ...f.binding, device: f.phone.publicKey },
    };
    expect(P.authorizeMachineExecution({ ...input, ledger: before })).toEqual({
      allowed: false,
      reason: 'policy-ledger-conflict',
    });
    expect(P.authorizeMachineExecution({ ...input, ledger: { ...f.current() } })).toEqual({
      allowed: false,
      reason: 'ledger-unverified',
    });
    const detached = verified.inspect();
    (detached.projects as string[]).push('private');
    expect(f.authorize(verified, f.bob.publicKey, 'private').allowed).toBe(false);
    expect(
      P.authorizeMachineExecution({
        ...input,
        ledger: f.current(),
        target: { ...input.target, workspaceId: 'other' },
      })
    ).toEqual({ allowed: false, reason: 'policy-binding-mismatch' });
    expect(f.authorize(verified, f.bob.publicKey, '')).toEqual({
      allowed: false,
      reason: 'invalid-project',
    });
  });

  it('does not let a removed and rejoined owner inherit the old machine policy', async () => {
    const f = await fixture(),
      verified = ok(f.open(await f.seal()));
    const retiredMembership = f.current().inspectState().owner;
    await f.command({ _tag: 'TransferOwner', successorMembershipId: f.bobMembership });
    await f.command({ _tag: 'DeclareCapabilities', capabilities: [1] }, f.bob.signer);
    await f.command({ _tag: 'RemoveMember', membershipId: retiredMembership }, f.bob.signer);
    expect(f.authorize(verified)).toEqual({ allowed: false, reason: 'target-ineligible' });
    const rejoined = f.ed(25),
      machine = f.ed(26),
      newMembership = ok(P.Bytes.membershipId(filled(25, 16)));
    const request = await Effect.runPromise(
      P.prepareJoinRequest({
        genesis: f.current().genesis,
        requestId: ok(P.Bytes.requestId(filled(25, 16))),
        userId: ok(P.Bytes.userId(filled(10))),
        encryptionPublicKey: ok(P.Bytes.encryptionPublicKey(filled(125))),
        expiresAt: null,
        signer: rejoined.signer,
      })
    );
    await f.command({ _tag: 'AdmitMember', membershipId: newMembership, request }, f.bob.signer);
    const admission = await Effect.runPromise(
      P.prepareDeviceAdmission({
        genesis: f.current().genesis,
        membershipId: newMembership,
        encryptionPublicKey: ok(P.Bytes.encryptionPublicKey(filled(126))),
        kind: 'machine',
        machineId: f.binding.machineId,
        signer: machine.signer,
      })
    );
    await f.command(admission, rejoined.signer);
    const input = {
      ledger: f.current(),
      signer: f.bob.publicKey,
      target: { ...f.binding, device: machine.publicKey },
    };
    expect(P.authorizeMachineExecution({ ...input, policy: verified })).toEqual({
      allowed: false,
      reason: 'policy-binding-mismatch',
    });
    expect(P.authorizeMachineExecution({ ...input, policy: null })).toEqual({
      allowed: false,
      reason: 'policy-unavailable',
    });
    expect(
      P.authorizeMachineExecution({ ...input, policy: null, signer: rejoined.publicKey })
    ).toEqual({ allowed: true, reason: 'owner' });
  });

  it('enforces initial, consecutive, idempotent and fork/rollback version rules', async () => {
    const f = await fixture(),
      original = await f.seal(),
      first = ok(f.open(original));
    expect(Result.isSuccess(f.open(original, first.head))).toBe(true);
    const close = {
      ...f.policy,
      revision: 2,
      previousDigest: first.head.digest,
      sharedWithTeam: false,
    };
    const nextFrame = await f.seal(close),
      next = ok(f.open(nextFrame, first.head, 2));
    expect(f.authorize(next)).toEqual({ allowed: false, reason: 'machine-not-shared' });
    expect(failure(f.open(original, next.head))).toBe('policy-version-conflict');
    expect(failure(f.open(nextFrame, null, 2))).toBe('policy-version-conflict');
    expect(failure(f.open(await f.seal(), first.head))).toBe('policy-version-conflict');
    expect(
      failure(f.open(await f.seal({ ...close, previousDigest: '77'.repeat(32) }), first.head, 2))
    ).toBe('policy-version-conflict');
    expect(failure(f.open(await f.seal({ ...close, revision: 3 }), first.head, 3))).toBe(
      'policy-version-conflict'
    );
  });

  it('isolates the business purpose from ordinary documents and detects signature/AEAD damage', async () => {
    const f = await fixture(),
      plaintext = ok(P.encodeMachineSharingPolicy(f.policy));
    const ordinary = await Effect.runPromise(
      P.sealDocument({
        scope: f.scope,
        documentKey: f.key,
        signer: f.owner.signer,
        ledger: () => Effect.succeed(f.current()),
        plaintext,
      })
    );
    expect(Result.isFailure(f.open(ordinary))).toBe(true);
    const original = await f.seal();
    for (const position of [50, original.length - 1]) {
      const damaged = original.slice();
      damaged[position]! ^= 1;
      expect(Result.isFailure(f.open(damaged))).toBe(true);
    }
    const rows = ok(decodeMachineSharingCbor(plaintext)) as P.CborValue[];
    for (const [position, value] of [
      [0, 2],
      [1, 2],
      [6, 0],
      [10, filled(0)],
      [11, -1],
    ] as const) {
      const changed = [...rows];
      changed[position] = value;
      const encoded = encodeMachineSharingCbor(changed);
      expect(
        Result.isFailure(encoded) || Result.isFailure(P.decodeMachineSharingPolicy(ok(encoded)))
      ).toBe(true);
    }
    plaintext.fill(0);
  });

  it('admits opaque originals only for the authenticated current owner personal device', async () => {
    const f = await fixture(),
      frame = await f.seal();
    const input = {
      ledger: f.current(),
      binding: f.binding,
      epoch: 0,
      frame,
      authenticatedDevice: f.owner.publicKey,
    };
    expect(ok(admitMachineSharingFrame(input))).toEqual({
      digest: ok(P.machineSharingDigest(frame)),
    });
    for (const authenticatedDevice of [f.bob.publicKey, f.phone.publicKey, f.recovery.publicKey])
      expect(Result.isFailure(admitMachineSharingFrame({ ...input, authenticatedDevice }))).toBe(
        true
      );
    for (const signer of [f.bob.signer, f.phone.signer]) {
      const plaintext = ok(
        P.encodeMachineSharingPolicy({ ...f.policy, signer: hex(signer.publicKey) })
      );
      const forged = await Effect.runPromise(
        P.sealDocument({
          scope: f.scope,
          documentKey: f.key,
          signer,
          ledger: () => Effect.succeed(f.current()),
          plaintext,
          additionalData: new TextEncoder().encode('lody-e2ee/machine-sharing/v1\0'),
        })
      );
      plaintext.fill(0);
      expect(failure(f.open(forged))).toBe(
        signer === f.bob.signer ? 'policy-binding-mismatch' : 'policy-signer-ineligible'
      );
      expect(Result.isFailure(admitMachineSharingFrame({ ...input, frame: forged }))).toBe(true);
      expect(
        Result.isFailure(
          P.readMachineSharingHistoryStep({
            ledger: f.current(),
            binding: f.binding,
            epoch: 0,
            documentKey: f.key,
            frame: forged,
            previous: null,
            expectedHead: { revision: 1, digest: ok(P.machineSharingDigest(forged)) },
          })
        )
      ).toBe(true);
    }
    await f.command({ _tag: 'RevokeDevice', target: f.owner.publicKey }, f.second.signer);
    expect(failure(admitMachineSharingFrame({ ...input, ledger: f.current() }))).toBe(
      'policy-signer-ineligible'
    );
  });

  it('bounds project identities, rejects duplicates and preserves strict UTF-8 without normalization', async () => {
    const f = await fixture();
    for (const projects of [
      ['same', 'same'],
      [''],
      ['\ud800'],
      ['x'.repeat(257)],
      Array.from({ length: 4097 }, (_, n) => String(n)),
    ])
      expect(Result.isFailure(P.encodeMachineSharingPolicy({ ...f.policy, projects }))).toBe(true);
    const policy = {
      ...f.policy,
      machineId: '\ufeffé',
      projects: ['é', 'e\u0301', '\ufeffa', '\0'],
    };
    expect(
      ok(P.decodeMachineSharingPolicy(ok(P.encodeMachineSharingPolicy(policy)))).projects
    ).toHaveLength(4);
    expect(ok(P.machineSharingContentScope(policy, 0)).resource).toBe(
      `machine-access:${Buffer.from(policy.machineId).toString('base64url')}:${policy.ownerMembershipId}`
    );
    const many = { ...f.policy, projects: Array.from({ length: 100 }, (_, n) => `project-${n}`) };
    expect(
      ok(P.decodeMachineSharingPolicy(ok(P.encodeMachineSharingPolicy(many)))).projects
    ).toHaveLength(100);
    expect(
      Result.isFailure(
        P.encodeMachineSharingPolicy({
          ...f.policy,
          projects: Array.from({ length: 4096 }, (_, n) => `${n}`.padEnd(256, 'x')),
        })
      )
    ).toBe(true);
    expect(Result.isFailure(P.decodeMachineSharingPolicy(new Uint8Array(256 * 1024 + 1)))).toBe(
      true
    );
  });

  it('captures policy before native signing waits and rechecks current ownership afterwards', async () => {
    const f = await fixture();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>(),
            release = yield* Deferred.make<void>();
          const mutable = { ...f.policy, projects: ['project-a'] };
          const signer: P.DeviceSigner = {
            publicKey: f.owner.publicKey,
            sign: (message) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
                return yield* f.owner.signer.sign(message);
              }),
          };
          const fiber = yield* Effect.forkChild(
            P.sealMachineSharingPolicy({
              policy: mutable,
              epoch: 0,
              documentKey: f.key,
              signer,
              ledger: () => Effect.succeed(f.current()),
            })
          );
          yield* Deferred.await(entered);
          mutable.sharedWithTeam = false;
          mutable.projects.push('private');
          yield* Deferred.succeed(release, undefined);
          const frame = yield* Fiber.join(fiber),
            verified = ok(f.open(frame));
          expect(f.authorize(verified).allowed).toBe(true);
          expect(f.authorize(verified, f.bob.publicKey, 'private').allowed).toBe(false);
        })
      )
    );
  });

  it('rejects revocation learned while the native signer is suspended', async () => {
    const f = await fixture();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>(),
            release = yield* Deferred.make<void>();
          const signer: P.DeviceSigner = {
            publicKey: f.owner.publicKey,
            sign: (message) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
                return yield* f.owner.signer.sign(message);
              }),
          };
          const fiber = yield* Effect.forkChild(
            Effect.result(
              P.sealMachineSharingPolicy({
                policy: f.policy,
                epoch: 0,
                documentKey: f.key,
                signer,
                ledger: () => Effect.succeed(f.current()),
              })
            )
          );
          yield* Deferred.await(entered);
          yield* Effect.promise(() =>
            f.command({ _tag: 'RevokeDevice', target: f.owner.publicKey }, f.second.signer)
          );
          yield* Deferred.succeed(release, undefined);
          expect(Result.isFailure(yield* Fiber.join(fiber))).toBe(true);
        })
      )
    );
  });
});
