import { Clock, Effect, Result, Semaphore } from 'effect';
import { z } from 'zod';
import {
  Bytes,
  decodeRecord,
  hashRecordBytes,
  hasVerifiedRecordHash,
  recordSigningBytes,
  prepareLedgerCommand,
  signLedgerRecord,
  signVerified,
  verifySignature,
  possessionSigningBytes,
  verifyDeviceCredentialBinding,
  type DeviceSigner,
  type LedgerView,
} from '@lody/e2ee-core/protocol';
import type { E2eeAppendRecordRequest, E2eeMachinePairingRequests } from '@lody/cloud-api';
import {
  RemoteMachineOfferSchema,
  RemoteMachineStatusSchema,
  remoteMachineOfferBytes,
  remoteMachineSummary,
  type RemoteMachineStatus,
} from '@lody/shared/e2ee-remote-pairing';
import { LocalE2eePrepareResponseSchema } from '@lody/shared/e2ee-local-pairing';
import { base64, fromHex, toHex } from './bytes';

/** Durable command and admission originals. A terminal receipt archives rather than erases them. */
export const remoteMachineJournalSchema = z
  .object({
    offer: RemoteMachineOfferSchema,
    material: LocalE2eePrepareResponseSchema.nullable(),
    request: z
      .object({
        requestId: z.string().min(1),
        recordHex: z
          .string()
          .regex(/^(?:[0-9a-f]{2})+$/)
          .max(32768),
      })
      .nullable(),
    retired: z.boolean(),
  })
  .strict();
/** One incarnation's remote-machine approval original. Never evidence of authority. */
export type RemoteMachineJournal = z.infer<typeof remoteMachineJournalSchema>;
/** Atomic original storage; CAS failure must reject, and retirement must retain the old row. */
export interface RemoteMachineStore {
  read(): Effect.Effect<RemoteMachineJournal | null, unknown>;
  save(
    previous: RemoteMachineJournal | null,
    next: RemoteMachineJournal
  ): Effect.Effect<void, unknown>;
}
/** Authenticated, bounded relay calls. Replies remain hints until verified ledger readback. */
export interface RemoteMachineRelay {
  begin(input: E2eeMachinePairingRequests['begin']): Effect.Effect<RemoteMachineStatus, unknown>;
  inspect(
    input: E2eeMachinePairingRequests['inspect']
  ): Effect.Effect<RemoteMachineStatus, unknown>;
  authorizeExisting(
    input: E2eeMachinePairingRequests['inspect']
  ): Effect.Effect<RemoteMachineStatus, unknown>;
  cancel(input: E2eeMachinePairingRequests['cancel']): Effect.Effect<RemoteMachineStatus, unknown>;
  append(input: E2eeAppendRecordRequest): Effect.Effect<unknown, unknown>;
}
/** Platform ports for a single retained installation. No key or signing capability leaves the session. */
export interface PersonalRemoteMachinePorts {
  readonly endpoints: { deploymentUrl: string; ingressUrl: string };
  readonly store: RemoteMachineStore;
  readonly relay: RemoteMachineRelay;
  /** Locally verified originals bounded to the supplied current view. */
  records(view: LedgerView): Effect.Effect<readonly Uint8Array[], unknown>;
}
const fail = (code = 'conflict') => new Error(`e2ee_${code}`);
const attempt = <A>(work: () => A) => Effect.try({ try: work, catch: () => fail() });
const staged = new Set(['claimed', 'admitting', 'admitted', 'ready']);
/** Portable approval workflow. The owning session fences account/identity, serializes local
 * signing and retains native lifetimes; this owner serializes pairing operations only. */
export function makeRemoteMachinePairing(
  input: PersonalRemoteMachinePorts & {
    accountId: string;
    workspaceId: string;
    genesisRecordHex: string;
    credential: string;
    signer: DeviceSigner;
    current(): Effect.Effect<LedgerView, unknown>;
    refresh(): Effect.Effect<unknown, unknown>;
    local<A>(work: Effect.Effect<A, unknown>): Effect.Effect<A, unknown>;
    keyRound(recipient: string): Effect.Effect<unknown, unknown>;
  }
) {
  const serial = Semaphore.makeUnsafe(1);
  const access = Effect.fnUntraced(function* () {
    const view = yield* input.current();
    const state = view.inspectState();
    const device = state.devices.get(toHex(input.signer.publicKey.toBytes()));
    const member = device && state.members.get(toHex(device.membershipId.toBytes()));
    if (!device || device.kind !== 'personal' || !member || member.role === 'guest')
      return yield* Effect.fail(fail('management_unauthorized'));
    if (
      toHex(view.genesis.toBytes()) !==
      toHex(hashRecordBytes(fromHex(input.genesisRecordHex)).toBytes())
    )
      return yield* Effect.fail(fail());
    return { view, membershipId: toHex(device.membershipId.toBytes()) };
  });
  const read = Effect.fnUntraced(function* (session?: string) {
    const { view, membershipId } = yield* access();
    const saved = yield* input.store.read();
    if (!saved) return null;
    const row = yield* attempt(() => remoteMachineJournalSchema.parse(saved));
    const offer = row.offer;
    if (
      offer.accountId !== input.accountId ||
      offer.workspaceId !== input.workspaceId ||
      offer.genesisHash !== toHex(view.genesis.toBytes()) ||
      offer.genesisRecordHex !== input.genesisRecordHex ||
      offer.frontendSigningPublicKey !== toHex(input.signer.publicKey.toBytes()) ||
      offer.membershipId !== membershipId ||
      (session && (session !== offer.pairingSessionId || row.retired))
    )
      return yield* Effect.fail(fail());
    yield* Effect.fromResult(
      verifySignature(
        input.signer.publicKey.toBytes(),
        remoteMachineOfferBytes(offer),
        fromHex(offer.signature)
      )
    );
    return row;
  });
  const required = Effect.fnUntraced(function* (session: string) {
    const row = yield* read(session);
    return row ?? (yield* Effect.fail(fail()));
  });
  const deviceAccess = (session: string) => ({
    workspaceId: input.workspaceId,
    credential: input.credential,
    pairingSessionId: session,
  });
  const status = Effect.fnUntraced(function* (
    session: string,
    work: Effect.Effect<RemoteMachineStatus, unknown>
  ) {
    const result = yield* work;
    yield* access();
    const parsed = yield* attempt(() => RemoteMachineStatusSchema.parse(result));
    if (parsed.pairingSessionId !== session) return yield* Effect.fail(fail());
    return parsed;
  });
  const check = Effect.fnUntraced(function* (row: RemoteMachineJournal) {
    const { view, membershipId } = yield* access();
    const material = row.material;
    if (!material || material.pairingSessionId !== row.offer.pairingSessionId)
      return yield* Effect.fail(fail());
    const signingPublicKey = yield* Effect.fromResult(
      Bytes.signingPublicKey(fromHex(material.signingPublicKey))
    );
    const encryptionPublicKey = yield* Effect.fromResult(
      Bytes.encryptionPublicKey(fromHex(material.encryptionPublicKey))
    );
    yield* Effect.fromResult(
      verifyDeviceCredentialBinding(
        {
          genesis: view.genesis,
          pairingSessionId: fromHex(material.pairingSessionId),
          signingPublicKey,
          credentialHash: fromHex(material.credentialHash),
        },
        fromHex(material.bindingSignature)
      )
    );
    const proof = yield* Effect.fromResult(
      possessionSigningBytes({
        genesis: view.genesis,
        targetMembershipId: Result.getOrThrow(Bytes.membershipId(fromHex(membershipId))),
        signingPublicKey,
        encryptionPublicKey,
        kind: 'machine',
        machineId: material.machineId,
      })
    );
    yield* Effect.fromResult(
      verifySignature(signingPublicKey.toBytes(), proof, fromHex(material.possessionSignature))
    );
    if (row.request) {
      const signed = yield* Effect.fromResult(decodeRecord(fromHex(row.request.recordHex)));
      const body = signed.body;
      if (
        body.type !== 'ordinary' ||
        !body.signer.equals(input.signer.publicKey) ||
        body.operation.type !== 'admitDevice' ||
        body.operation.kind !== 'machine' ||
        body.operation.machineId !== material.machineId ||
        !body.operation.signingPublicKey.equals(signingPublicKey) ||
        !body.operation.encryptionPublicKey.equals(encryptionPublicKey) ||
        toHex(body.operation.possessionSignature.toBytes()) !== material.possessionSignature ||
        !Result.getOrElse(hasVerifiedRecordHash(view, body.previousHash), () => false)
      )
        return yield* Effect.fail(fail('local-evidence-conflict'));
      yield* Effect.fromResult(
        verifySignature(
          body.signer.toBytes(),
          recordSigningBytes(signed.bodyBytes),
          signed.signature.toBytes()
        )
      );
    }
    const admitted = view.inspectState().devices.get(material.signingPublicKey);
    if (admitted) {
      if (
        admitted.kind !== 'machine' ||
        admitted.machineId !== material.machineId ||
        toHex(admitted.membershipId.toBytes()) !== membershipId ||
        !admitted.encryptionPublicKey.equals(encryptionPublicKey)
      )
        return yield* Effect.fail(fail());
      return { view, admitted: true, proposal: null };
    }
    const previous = [...view.inspectState().devices].find(
      ([, d]) => d.kind === 'machine' && d.machineId === material.machineId
    )?.[0];
    const proposal = prepareLedgerCommand(view, input.signer.publicKey, {
      _tag: 'AdmitDevice',
      kind: 'machine',
      machineId: material.machineId,
      replaces: previous ? Result.getOrThrow(Bytes.signingPublicKey(fromHex(previous))) : null,
      signingPublicKey,
      encryptionPublicKey,
      possessionSignature: Result.getOrThrow(
        Bytes.signature(fromHex(material.possessionSignature))
      ),
    });
    if (Result.isFailure(proposal))
      return yield* Effect.fail(
        fail(proposal.failure.code === 'replay' ? 'pairing_key_revoked' : 'invalid-input')
      );
    return { view, admitted: false, proposal: proposal.success };
  });
  const inspect = Effect.fnUntraced(function* (session: string) {
    const row = yield* input.local(required(session));
    const result = yield* status(session, input.relay.inspect(deviceAccess(session)));
    let summary: string | null = null;
    if (result.material && staged.has(result.status)) {
      yield* input.local(
        Effect.gen(function* () {
          const current = yield* required(session);
          const material = result.material!;
          if (current.material && JSON.stringify(current.material) !== JSON.stringify(material))
            return yield* Effect.fail(fail());
          const next = { ...current, material };
          yield* check(next);
          if (!current.material) yield* input.store.save(current, next);
        })
      );
      summary = yield* Effect.tryPromise({
        try: () => remoteMachineSummary(row.offer, result.material!),
        catch: () => fail(),
      });
    }
    return { ...result, summary };
  });
  const begin = Effect.fnUntraced(function* () {
    const row = yield* input.local(
      Effect.gen(function* () {
        const old = yield* read();
        if (old && !old.retired) return old;
        const { view, membershipId } = yield* access();
        const now = yield* Clock.currentTimeMillis;
        const unsigned = yield* attempt(() =>
          RemoteMachineOfferSchema.omit({ signature: true }).parse({
            version: 1,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            genesisHash: toHex(view.genesis.toBytes()),
            genesisRecordHex: input.genesisRecordHex,
            membershipId,
            frontendSigningPublicKey: toHex(input.signer.publicKey.toBytes()),
            pairingSessionId: toHex(crypto.getRandomValues(new Uint8Array(16))),
            token: toHex(crypto.getRandomValues(new Uint8Array(32))),
            ...input.endpoints,
            expiresAt: now + 10 * 60_000,
          })
        );
        const signature = yield* signVerified(input.signer, remoteMachineOfferBytes(unsigned));
        const next = {
          offer: { ...unsigned, signature: toHex(signature.toBytes()) },
          material: null,
          request: null,
          retired: false,
        };
        yield* input.store.save(old, next);
        return next;
      })
    );
    const result = yield* status(
      row.offer.pairingSessionId,
      input.relay.begin({
        workspaceId: input.workspaceId,
        credential: input.credential,
        offer: row.offer,
      })
    );
    const encoded = base64(new TextEncoder().encode(JSON.stringify(row.offer)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    return { ...result, command: `lody machine pair --offer ${encoded}` };
  });
  const approve = Effect.fnUntraced(function* (session: string, summary: string) {
    yield* input.refresh();
    const preview = yield* inspect(session);
    if (!preview.summary || preview.summary !== summary || !staged.has(preview.status))
      return yield* Effect.fail(fail());
    const pending = yield* input.local(
      Effect.gen(function* () {
        const row = yield* required(session);
        const checked = yield* check(row);
        if (checked.admitted) return row;
        if (row.request) return row;
        if (!checked.proposal) return yield* Effect.fail(fail());
        const record = yield* signLedgerRecord(checked.proposal, input.signer);
        const next = {
          ...row,
          request: { requestId: `remote-device-${crypto.randomUUID()}`, recordHex: toHex(record) },
        };
        yield* input.store.save(row, next);
        return next;
      })
    );
    if (pending.request) {
      // A lost acknowledgement never permits a new signature; verified readback below decides.
      const appended = yield* Effect.result(
        input.relay.append({
          workspaceId: input.workspaceId,
          ...pending.request,
          credentialHash: pending.material!.credentialHash,
          machinePairingSessionId: session,
        })
      );
      if (
        Result.isFailure(appended) &&
        appended.failure instanceof Error &&
        appended.failure.message === 'e2ee_pairing_key_revoked'
      )
        return yield* Effect.fail(appended.failure);
    } else {
      yield* status(session, input.relay.authorizeExisting(deviceAccess(session)));
    }
    yield* input.refresh();
    yield* input.local(
      Effect.gen(function* () {
        const row = yield* required(session);
        const checked = yield* check(row);
        if (!checked.admitted) return yield* Effect.fail(fail('append_unconfirmed'));
        if (row.request) {
          const records = yield* input.records(checked.view);
          if (
            !Result.getOrElse(
              hasVerifiedRecordHash(checked.view, hashRecordBytes(fromHex(row.request.recordHex))),
              () => false
            ) ||
            !records.some((record) => toHex(record) === row.request!.recordHex)
          )
            return yield* Effect.fail(fail('local-evidence-conflict'));
        }
      })
    );
    yield* input.keyRound(pending.material!.signingPublicKey);
    const result = yield* inspect(session);
    return {
      admitted: result.status === 'admitted' || result.status === 'ready',
      ready: result.status === 'ready',
    };
  });
  const cancel = Effect.fnUntraced(function* (session: string) {
    yield* input.local(required(session));
    const result = yield* status(session, input.relay.cancel(deviceAccess(session)));
    if (!['cancelled', 'expired', 'conflict', 'ready'].includes(result.status))
      return yield* Effect.fail(fail());
    if (!result.noAdmissionReserved) yield* input.refresh();
    yield* input.local(
      Effect.gen(function* () {
        const row = yield* required(session);
        if (row.request && !result.noAdmissionReserved) {
          const { view } = yield* access();
          const signed = yield* Effect.fromResult(decodeRecord(fromHex(row.request.recordHex)));
          if (signed.body.type !== 'ordinary') return yield* Effect.fail(fail());
          const parent = signed.body.previousHash;
          const originals = yield* input.records(view);
          const settled = originals.some((record) => {
            if (
              !Result.getOrElse(hasVerifiedRecordHash(view, hashRecordBytes(record)), () => false)
            )
              return false;
            const parsed = decodeRecord(record);
            return (
              toHex(record) === row.request!.recordHex ||
              (Result.isSuccess(parsed) &&
                parsed.success.body.type === 'ordinary' &&
                parsed.success.body.previousHash.equals(parent))
            );
          });
          if (!settled) return yield* Effect.fail(fail());
        }
        yield* input.store.save(row, { ...row, retired: true });
      })
    );
    return result;
  });
  return {
    begin: () => serial.withPermit(begin()),
    inspect: (session: string) => serial.withPermit(inspect(session)),
    approve: (session: string, summary: string) => serial.withPermit(approve(session, summary)),
    cancel: (session: string) => serial.withPermit(cancel(session)),
  };
}
