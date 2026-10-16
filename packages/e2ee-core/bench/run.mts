/** Manual, non-gating benchmark. All measurements are observations, not limits.
 * Developer-only Lab imports exercise native adapters; src has no Lab dependency. */
import { mkdtempSync, rmSync } from 'node:fs';
import { cpus, platform, arch, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { Effect, Result, type Scope } from 'effect';
import { Bytes } from '../src/index';
import { copyEpochKeyBytes } from '../src/epoch-key';
import { hashRecordBytes, verifyLedger, verifyLedgerEffect } from '../src/ledger';
import { prepareJoinRequest, prepareDeviceAdmission } from '../src/ledger/admission';
import { makeSqliteLedgerFeed } from '../src/ledger/feed-sqlite';
import { signLedgerSnapshot } from '../src/ledger/snapshot';
import { makeSqliteSnapshotLedgerFeed } from '../src/ledger/snapshot-feed-sqlite';
import { verifyWorkspaceInvitationSnapshot } from '../src/workspace/invitation';
import { makeStreamsUpdateBinding } from '../src/content/streams';
import { commitEpochKey, sealHistoryPacket } from '../src/keys/history';
import { prepareEpochEnvelope } from '../src/keys/envelope';
import { authenticateEpochStagedGroup, type EpochStagedGroup } from '../src/keys/staging';
import { envelopeFixture } from '../test/keys/fixture';
import { generateDevice } from '../../e2ee-lab/src/platform/device';
import { makeLabEpochStaging } from '../../e2ee-lab/src/platform/epoch-staging';
import { makeLabScenarioFixture } from '../../e2ee-lab/src/platform/scenario-fixture';
import { openLabWorkspaceSession } from '../../e2ee-lab/src/platform/full-session';

const ok = Result.getOrThrow;
const quick = process.argv.includes('--quick');
const option = (name: string, fallback: readonly number[]) => {
  const value = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (!value) return [...fallback];
  const list = value
    .slice(name.length + 3)
    .split(',')
    .map(Number);
  if (list.length < 1 || list.some((n) => !Number.isSafeInteger(n) || n < 1))
    throw new Error(`invalid ${name}`);
  return list;
};
const counts = option('records', quick ? [32] : [1000, 10000]);
const devices = option('devices', quick ? [3] : [10, 20, 100]);
const sizes = option('content', quick ? [64, 1024] : [64, 1024, 65536, 1048576]);
const iterations = option('iterations', [quick ? 1 : 3])[0]!;
if (
  counts.some((n) => n < 4 || n > 100000) ||
  devices.some((n) => n < 2 || n > 1000) ||
  iterations > 100
)
  throw new Error('bounded benchmark configuration required');
const directory = mkdtempSync(join(tmpdir(), 'lody-e2ee-bench-'));
const metrics: Record<string, unknown>[] = [];
const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect));
async function measured<A>(
  name: string,
  context: Record<string, unknown>,
  work: () => A | Promise<A>
) {
  const samplesMs: number[] = [];
  let result!: A;
  for (let index = 0; index < iterations; index++) {
    const before = performance.now();
    result = await work();
    samplesMs.push(performance.now() - before);
  }
  metrics.push({
    name,
    ...context,
    iterations,
    samplesMs,
    meanMs: samplesMs.reduce((a, b) => a + b, 0) / samplesMs.length,
  });
  return result;
}
const measuredEffect = Effect.fnUntraced(function* <A, E, R>(
  name: string,
  context: Record<string, unknown>,
  work: Effect.Effect<A, E, R>
) {
  const samplesMs: number[] = [];
  let result!: A;
  for (let index = 0; index < iterations; index++) {
    const before = performance.now();
    result = yield* work;
    samplesMs.push(performance.now() - before);
  }
  metrics.push({
    name,
    ...context,
    iterations,
    samplesMs,
    meanMs: samplesMs.reduce((a, b) => a + b, 0) / samplesMs.length,
  });
  return result;
});
async function history(count: number) {
  const f = envelopeFixture();
  const member = await Effect.runPromise(generateDevice());
  const membership = ok(Bytes.membershipId(new Uint8Array(16).fill(90)));
  const request = await Effect.runPromise(
    prepareJoinRequest({
      genesis: f.context.genesis,
      requestId: ok(Bytes.requestId(new Uint8Array(16).fill(88))),
      userId: ok(Bytes.userId(new Uint8Array(32).fill(89))),
      signer: member,
      encryptionPublicKey: member.enc,
      expiresAt: null,
    })
  );
  f.append([
    1,
    membership.toBytes(),
    [
      request.requestId.toBytes(),
      request.userId.toBytes(),
      request.signingPublicKey.toBytes(),
      request.encryptionPublicKey.toBytes(),
      null,
      request.signature.toBytes(),
    ],
  ]);
  // Alternating a settled ordinary command keeps authorized state size constant,
  // so snapshot timing measures history elimination, not growing membership data.
  let length = 3;
  while (length < count) {
    const role = length % 2 === 1 ? 1 : 2;
    f.append([3, membership.toBytes(), role]);
    length++;
  }
  const records = f.records();
  const checkpoint = { head: hashRecordBytes(records.at(-1)!), length: records.length };
  const input = { anchor: f.context.genesis, records, checkpoint };
  const view = await Effect.runPromise(verifyLedgerEffect(input));
  return { f, records, checkpoint, input, view };
}
async function ledgerBench(count: number) {
  process.stderr.write(`ledger ${count}\n`);
  const h = await history(count);
  await measured('ledger.verify.pure', { records: count }, () => ok(verifyLedger(h.input)));
  await measured('ledger.verify.native', { records: count }, () =>
    Effect.runPromise(verifyLedgerEffect(h.input))
  );
  const path = join(directory, `feed-${count}.sqlite`);
  const parameters = {
    path,
    mode: 'create' as const,
    genesis: h.f.context.genesis,
    genesisRecord: h.records[0]!,
    expected: { head: hashRecordBytes(h.records[0]!), length: 1 },
    budget: { maxRecords: 100000, maxBytes: 64 * 1024 * 1024 },
  };
  await run(
    Effect.gen(function* () {
      const feed = yield* makeSqliteLedgerFeed(parameters);
      let offset = '-1';
      for (let start = 0; start < h.records.length; start += 4096) {
        const page = h.records.slice(start, start + 4096);
        const next = `bench/${start + page.length}`;
        yield* feed.accept(
          {
            requestOffset: offset,
            nextOffset: next,
            records: page,
            upToDate: start + page.length === count,
          },
          { head: hashRecordBytes(page.at(-1)!), length: start + page.length }
        );
        offset = next;
      }
    })
  );
  await measured(
    'ledger.reopen.pure-audit',
    {
      records: count,
      path: 'read-only SQLite ordered originals + verifyLedger; not a second feed implementation',
    },
    () => {
      const db = new Database(path, { readonly: true, fileMustExist: true });
      try {
        const rows = db
          .prepare('SELECT record FROM ledger_feed_records ORDER BY position')
          .all() as { record: Uint8Array }[];
        return ok(
          verifyLedger({ ...h.input, records: rows.map((row) => new Uint8Array(row.record)) })
        );
      } finally {
        db.close();
      }
    }
  );
  await measured('ledger.reopen.native-feed', { records: count }, () =>
    run(
      Effect.gen(function* () {
        const feed = yield* makeSqliteLedgerFeed({
          ...parameters,
          mode: 'open',
          expected: h.checkpoint,
        });
        return yield* feed.current();
      })
    )
  );
  const signed = await Effect.runPromise(
    signLedgerSnapshot({ signer: h.f.owner.signer, ledger: () => Effect.succeed(h.view) })
  );
  const pin = {
    workspaceId: 'bench-workspace',
    genesis: h.f.context.genesis,
    endorser: h.f.owner.publicKey,
  };
  const receipt = {
    workspaceId: pin.workspaceId,
    snapshot: signed.snapshot,
    head: signed.head,
    length: signed.length,
    headSignature: signed.headSignature,
    offset: 'bench/snapshot',
  };
  let sequence = 0;
  await measured(
    'ledger.snapshot-first.join',
    {
      prefixRecords: count,
      snapshotBytes: signed.snapshot.length,
      suffixRecords: 0,
      includes: 'invitation pin verification + native SQLite snapshot origin creation',
    },
    () =>
      run(
        Effect.gen(function* () {
          const qualified = yield* Effect.fromResult(
            verifyWorkspaceInvitationSnapshot(pin, receipt)
          );
          const feed = yield* makeSqliteSnapshotLedgerFeed({
            path: join(directory, `snapshot-${count}-${sequence++}.sqlite`),
            mode: 'create',
            genesis: pin.genesis,
            snapshot: qualified.snapshot,
            expected: h.checkpoint,
            budget: { maxRecords: 100000, maxBytes: 64 * 1024 * 1024 },
          });
          return yield* feed.current();
        })
      )
  );
}
async function contentBench(size: number) {
  const f = envelopeFixture();
  const view = f.view();
  const body = new Uint8Array(size).fill(73);
  await run(
    Effect.gen(function* () {
      const binding = yield* makeStreamsUpdateBinding({
        genesis: f.context.genesis,
        resource: 'bench-document',
        model: 'loro',
        writeEpoch: 0,
        signer: f.owner.signer,
        ledger: () => Effect.succeed(view),
        readEpochKey: () => Effect.succeed(ok(Bytes.epochKey(copyEpochKeyBytes(f.secret)))),
      });
      const context = {
        protocol: 'loro-streams-crdt-payload-protection' as const,
        version: 2 as const,
        kind: 'update_batch' as const,
      };
      const sealed = yield* measuredEffect(
        'content.seal',
        { bytes: size },
        binding.seal({
          plaintext: body,
          context,
          additionalData: () => new Uint8Array([1, 2, 3]),
        })
      );
      yield* measuredEffect(
        'content.open',
        { bytes: size, frameBytes: sealed.sealed.length },
        binding.open({
          sealed: sealed.sealed,
          header: sealed.header,
          context,
          additionalData: new Uint8Array([1, 2, 3]),
        })
      );
    })
  );
}
async function stageBench(count: number) {
  process.stderr.write(`stage ${count}\n`);
  const f = envelopeFixture();
  const member = ok(Bytes.membershipId(new Uint8Array(16).fill(10)));
  for (let index = 2; index < count; index++) {
    const device = await Effect.runPromise(generateDevice());
    const command = await Effect.runPromise(
      prepareDeviceAdmission({
        genesis: f.context.genesis,
        membershipId: member,
        encryptionPublicKey: device.enc,
        signer: device,
        kind: 'personal',
      })
    );
    f.append([
      4,
      0,
      command.signingPublicKey.toBytes(),
      command.encryptionPublicKey.toBytes(),
      command.possessionSignature.toBytes(),
    ]);
  }
  const original = f.records();
  const before = await Effect.runPromise(
    verifyLedgerEffect({
      anchor: f.context.genesis,
      records: original,
      checkpoint: { head: hashRecordBytes(original.at(-1)!), length: original.length },
    })
  );
  const candidate = ok(Bytes.epochKey(crypto.getRandomValues(new Uint8Array(32))));
  const commitment = ok(commitEpochKey(f.context.genesis, 1, candidate));
  const packet = ok(
    sealHistoryPacket({
      genesis: f.context.genesis,
      epoch: 1,
      currentKey: candidate,
      previousKey: f.secret,
    })
  );
  f.append([7, 1, commitment.toBytes(), packet]);
  const candidateRecords = f.records();
  const record = candidateRecords.at(-1)!;
  const post = await Effect.runPromise(
    verifyLedgerEffect({
      anchor: f.context.genesis,
      records: candidateRecords,
      checkpoint: { head: hashRecordBytes(record), length: candidateRecords.length },
    })
  );
  const group = await measured('epoch.prepare-envelopes', { devices: count }, async () => {
    const envelopes = [];
    for (const [recipient] of before.inspectState().devices) {
      const publicKey = ok(Bytes.signingPublicKey(new Uint8Array(Buffer.from(recipient, 'hex'))));
      const frame = await Effect.runPromise(
        prepareEpochEnvelope({
          context: {
            genesis: f.context.genesis,
            epoch: ok(Bytes.epochNumber(1)),
            sender: f.owner.publicKey,
            recipient: publicKey,
          },
          key: candidate,
          signer: f.owner.signer,
          ledger: () => Effect.succeed(before),
          candidate: { before, record },
        })
      );
      envelopes.push({ recipient, frame });
    }
    const result: EpochStagedGroup = {
      genesis: Buffer.from(f.context.genesis.toBytes()).toString('hex'),
      epoch: 1,
      commitment: Buffer.from(commitment.toBytes()).toString('hex'),
      recordHash: Buffer.from(hashRecordBytes(record).toBytes()).toString('hex'),
      record,
      envelopes,
    };
    ok(authenticateEpochStagedGroup(post, result, true));
    return result;
  });
  let sequence = 0;
  await measured(
    'epoch.stage-and-readback',
    {
      devices: count,
      recordBytes: record.length,
      envelopeBytes: group.envelopes.reduce((sum, row) => sum + row.frame.length, 0),
      groupPayloadBytes:
        record.length + group.envelopes.reduce((sum, row) => sum + row.frame.length, 0),
    },
    () =>
      run(
        Effect.gen(function* () {
          const store = yield* makeLabEpochStaging({
            path: join(directory, `stage-${count}-${sequence++}.sqlite`),
            mode: 'create',
          });
          yield* store.stageGroup(group);
          const actual = yield* store.readGroup(group);
          if (!actual || actual.envelopes.length !== count) throw new Error('stage-readback');
        })
      )
  );
}
async function roundBench() {
  process.stderr.write('key round\n');
  await run(
    Effect.gen(function* () {
      const fixture = yield* makeLabScenarioFixture(join(directory, 'round'));
      const owner = yield* openLabWorkspaceSession({
        ...fixture.input('owner', 'create'),
        documents: [],
      });
      const peer = yield* openLabWorkspaceSession({
        ...fixture.input('peer', 'create'),
        documents: [],
      });
      const time = performance.now();
      const sent = yield* owner.keyRound();
      const received = yield* peer.keyRound();
      const elapsed = performance.now() - time;
      metrics.push({
        name: 'key-round.cold',
        devices: 2,
        elapsedMs: elapsed,
        scheduled: sent.scheduled,
        received: received.received,
        includes: 'actual SDK/HTTP/HPKE/SQLite/save-readback/reports',
      });
      yield* measuredEffect('key-round.warm', { devices: 2 }, owner.keyRound());
    })
  );
}
let status = 'completed';
try {
  for (const count of counts) await ledgerBench(count);
  for (const size of sizes) await contentBench(size);
  for (const count of devices) await stageBench(count);
  await roundBench();
} catch (cause) {
  status = 'failed';
  metrics.push({
    name: 'error',
    message: String(cause),
    stack: cause instanceof Error ? cause.stack : undefined,
  });
  process.exitCode = 1;
} finally {
  const result = {
    format: 'lody-e2ee-benchmark-v1',
    status,
    measuredAt: new Date().toISOString(),
    environment: {
      node: process.version,
      openssl: process.versions.openssl,
      platform: platform(),
      release: release(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
    },
    config: { counts, devices, sizes, iterations },
    gating: false,
    metrics,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  rmSync(directory, { recursive: true, force: true });
}
