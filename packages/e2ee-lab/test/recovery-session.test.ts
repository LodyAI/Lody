import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Result } from 'effect';
import { Bytes, ContentError } from '@lody/e2ee-core';
import { prepareDeviceAdmission } from '@lody/e2ee-core/protocol';
import { decodeRecord, hashRecordBytes } from '@lody/e2ee-core/protocol';
import { generateDevice, type DemoDevice } from '../src/platform/device';
import {
  openLabWorkspaceSession,
  type LabWorkspaceSessionInput,
} from '../src/platform/full-session';
import { makeLabScenarioFixture } from '../src/platform/scenario-fixture';
import { expect, it } from 'vitest';

const ok = Result.getOrThrow;
const recordDomain = new TextEncoder().encode('lody-e2ee/sig/v1\0');
const ledgerMessage = (message: Uint8Array) =>
  message.length >= recordDomain.length &&
  recordDomain.every((value, index) => message[index] === value);

it('uses an active Recovery device to durably enroll its own new personal device, resumes lost ACK originals and receives the actual content key', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lab-recovery-personal-'));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* makeLabScenarioFixture(join(root, 'fixture')),
            recovery = yield* generateDevice(),
            replacement = yield* generateDevice(),
            machine = yield* generateDevice();
          const original = ok(decodeRecord(f.records[0]!));
          if (original.body.type !== 'genesis')
            throw new Error('genuine original genesis required');
          const membershipId = original.body.membershipId;
          const owner = yield* openLabWorkspaceSession(f.input('owner', 'create'));
          const recoveryProof = yield* prepareDeviceAdmission({
            genesis: f.genesis,
            membershipId,
            encryptionPublicKey: recovery.enc,
            kind: 'recovery',
            signer: recovery,
          });
          const admitted = yield* owner.submit(recoveryProof);
          expect(admitted.outcome).toBe('Committed');
          yield* owner.acknowledge(admitted);

          const input = (
            device: DemoDevice,
            label: string,
            mode: 'create' | 'open'
          ): LabWorkspaceSessionInput => {
            const template = f.input('peer', mode);
            const file = (part: string) => join(root, `${label}-${part}.sqlite`);
            return {
              ...template,
              signer: device,
              mode,
              path: file('feed'),
              journalPath: file('journal'),
              keys: {
                ...template.keys,
                mode,
                path: file('receive'),
                pair: device.encryption,
                keyStore: { ...template.keys.keyStore, path: file('keys'), mode },
                repairStore: { path: file('repair'), mode },
                sendStore: { path: file('send'), mode },
                outboxStore: { path: file('outbox'), mode },
              },
              documents: template.documents
                .filter((document) => document.id === 'loro')
                .map((document) => ({
                  ...document,
                  mode,
                  path: file('loro'),
                })),
            };
          };
          let dropAck = false,
            blockReadback = false,
            signatures = 0;
          const captured: Uint8Array[] = [],
            statuses: number[] = [];
          const transport: typeof fetch = async (value, init) => {
            const request = new Request(value, init),
              url = new URL(request.url);
            if (blockReadback && request.method === 'GET' && url.pathname.endsWith('/control'))
              throw new Error('synthetic loss of committed ACK and immediate readback');
            const cas = request.method === 'POST' && url.pathname.endsWith('/control/append-cas');
            if (cas) captured.push(new Uint8Array(await request.clone().arrayBuffer()).slice(4));
            const response = await fetch(request);
            if (url.pathname.includes('/control')) statuses.push(response.status);
            if (dropAck && cas && response.ok) {
              dropAck = false;
              blockReadback = true;
              await response.arrayBuffer();
              throw new Error('synthetic committed ACK loss');
            }
            return response;
          };
          const recoveryInput = input(recovery, 'recovery', 'create');
          const session = yield* openLabWorkspaceSession({
            ...recoveryInput,
            fetch: transport,
            signer: {
              publicKey: recovery.publicKey,
              sign: (message) =>
                Effect.gen(function* () {
                  if (ledgerMessage(message)) signatures++;
                  return yield* recovery.sign(message);
                }),
            },
          });
          yield* owner.keyRound();
          expect((yield* session.keyRound()).reconciliation.scheduled).toBe(0);
          const rKeys = new Database(recoveryInput.keys.keyStore.path, { readonly: true });
          try {
            expect(rKeys.prepare('SELECT epoch FROM installed_epoch_keys').all()).toEqual([
              { epoch: 0 },
            ]);
          } finally {
            rKeys.close();
          }

          yield* owner.createDocument('loro');
          yield* owner.append('loro', 'recovered personal device');
          const preAdmissionStatuses: number[] = [];
          const unadmitted = yield* Effect.result(
            openLabWorkspaceSession({
              ...input(replacement, 'unadmitted', 'create'),
              fetch: async (value, init) => {
                const response = await fetch(value, init);
                preAdmissionStatuses.push(response.status);
                return response;
              },
            })
          );
          expect(Result.isFailure(unadmitted)).toBe(true);
          expect(preAdmissionStatuses).toContain(403);
          const before = f.records.map((record) => new Uint8Array(record));
          const badMembership = yield* prepareDeviceAdmission({
            genesis: f.genesis,
            membershipId: ok(Bytes.membershipId(new Uint8Array(16).fill(211))),
            encryptionPublicKey: replacement.enc,
            kind: 'personal',
            signer: replacement,
          });
          const badProof = yield* Effect.result(session.submit(badMembership));
          expect(Result.isFailure(badProof)).toBe(true);
          if (Result.isFailure(badProof))
            expect(badProof.failure).toMatchObject({ _tag: 'LedgerError', code: 'bad-proof' });
          const badKind = yield* prepareDeviceAdmission({
            genesis: f.genesis,
            membershipId,
            encryptionPublicKey: machine.enc,
            kind: 'machine',
            machineId: 'synthetic-machine',
            signer: machine,
          });
          const deniedKind = yield* Effect.result(session.submit(badKind));
          expect(Result.isFailure(deniedKind)).toBe(true);
          if (Result.isFailure(deniedKind))
            expect(deniedKind.failure).toMatchObject({ _tag: 'LedgerError', code: 'unauthorized' });
          expect(f.records).toEqual(before);
          expect(signatures).toBe(0);
          const proof = yield* prepareDeviceAdmission({
            genesis: f.genesis,
            membershipId,
            encryptionPublicKey: replacement.enc,
            kind: 'personal',
            signer: replacement,
          });
          dropAck = true;
          const lost = yield* Effect.result(session.submit(proof));
          expect(Result.isFailure(lost)).toBe(true);
          expect(signatures).toBe(1);
          expect(captured).toHaveLength(1);
          expect(f.records).toHaveLength(before.length + 1);
          expect(f.records.at(-1)).toEqual(captured[0]);
          const registration = ok(decodeRecord(captured[0]!));
          expect(registration.body.type).toBe('ordinary');
          if (registration.body.type !== 'ordinary') throw new Error('ordinary admission required');
          expect(registration.body.signer.equals(recovery.publicKey)).toBe(true);
          expect(registration.body.operation.type).toBe('admitDevice');
          if (registration.body.operation.type !== 'admitDevice')
            throw new Error('device admission required');
          expect(registration.body.operation.kind).toBe('personal');
          expect(registration.body.operation.signingPublicKey.equals(replacement.publicKey)).toBe(
            true
          );
          const local = (yield* session.current()).view;
          const journal = new Database(recoveryInput.journalPath, { readonly: true });
          try {
            const row = journal
              .prepare('SELECT pending,result_record,outcome FROM submission_journal')
              .get() as {
              pending: Uint8Array;
              result_record: Uint8Array | null;
              outcome: string | null;
            };
            expect(new Uint8Array(row.pending)).toEqual(captured[0]);
            expect(row.result_record).toBeNull();
            expect(row.outcome).toBeNull();
          } finally {
            journal.close();
          }
          yield* session.close();

          blockReadback = false;
          const reopened = yield* openLabWorkspaceSession({
            ...input(recovery, 'recovery', 'open'),
            expected: { head: local.head, length: local.length },
            fetch: transport,
            signer: {
              publicKey: recovery.publicKey,
              sign: (message) =>
                ledgerMessage(message)
                  ? Effect.fail(new ContentError({ code: 'new-signing-forbidden' }))
                  : recovery.sign(message),
            },
          });
          const resumed = yield* reopened.resume();
          expect(resumed?.outcome).toBe('Committed');
          expect(resumed?.record).toEqual(captured[0]);
          expect(captured).toHaveLength(1);
          expect(signatures).toBe(1);
          const restored = (yield* reopened.current()).view;
          expect(restored.head.equals(hashRecordBytes(captured[0]!))).toBe(true);
          const personal = restored
            .inspectState()
            .devices.get(Buffer.from(replacement.publicKey.toBytes()).toString('hex'));
          expect(personal?.kind).toBe('personal');
          expect(personal?.membershipId.equals(membershipId)).toBe(true);
          expect(
            restored.inspectState().members.get(Buffer.from(membershipId.toBytes()).toString('hex'))
              ?.role
          ).toBe('owner');
          if (!resumed) throw new Error('original result required');
          yield* reopened.acknowledge(resumed);

          const replacementInput = input(replacement, 'replacement', 'create');
          const newPersonal = yield* openLabWorkspaceSession(replacementInput);
          yield* owner.refresh();
          yield* owner.keyRound();
          yield* newPersonal.keyRound();
          yield* newPersonal.pull('loro');
          expect(yield* newPersonal.text('loro')).toBe('recovered personal device');
          const keys = new Database(replacementInput.keys.keyStore.path, { readonly: true });
          try {
            expect(keys.prepare('SELECT epoch FROM installed_epoch_keys').all()).toEqual([
              { epoch: 0 },
            ]);
          } finally {
            keys.close();
          }
          const receipt = new Database(replacementInput.keys.path, { readonly: true });
          try {
            expect(
              receipt.prepare("SELECT phase FROM receive_tasks WHERE phase='Reported'").all()
            ).toHaveLength(1);
          } finally {
            receipt.close();
          }

          const revoked = yield* owner.submit({ _tag: 'RevokeDevice', target: recovery.publicKey });
          yield* owner.acknowledge(revoked);
          const retained = f.records.map((record) => new Uint8Array(record));
          const another = yield* generateDevice();
          const afterRevocation = yield* prepareDeviceAdmission({
            genesis: f.genesis,
            membershipId,
            encryptionPublicKey: another.enc,
            kind: 'personal',
            signer: another,
          });
          statuses.length = 0;
          const beforeAttempts = captured.length;
          const refused = yield* Effect.result(reopened.submit(afterRevocation));
          expect(Result.isFailure(refused)).toBe(true);
          if (Result.isFailure(refused))
            expect(refused.failure).toMatchObject({ _tag: 'LedgerError', code: 'unauthorized' });
          expect(statuses).toEqual([200]);
          expect(captured).toHaveLength(beforeAttempts);
          expect(
            (yield* reopened.current()).view
              .inspectState()
              .devices.has(Buffer.from(recovery.publicKey.toBytes()).toString('hex'))
          ).toBe(false);
          expect(Result.isFailure(yield* Effect.result(reopened.keyRound()))).toBe(true);
          expect(f.records).toEqual(retained);
          const remains = f.view().inspectState();
          expect(
            remains.devices.has(Buffer.from(replacement.publicKey.toBytes()).toString('hex'))
          ).toBe(true);
          expect(
            remains.devices.has(Buffer.from(recovery.publicKey.toBytes()).toString('hex'))
          ).toBe(false);
        })
      )
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
