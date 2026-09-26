import { describe, expect, it } from 'vitest';
import {
  createRecoveryFile,
  createUserIdentity,
  liveCryptoPlatform,
  liveEntropy,
  openRecoveryBackup,
  parseRecoveryFile,
  sealRecoveryBackup,
  type Entropy,
} from '@lody/e2ee-core';
import { createBoundedStreamsFetch } from '@lody/e2ee-core/streams';
import {
  Ledger,
  LedgerError,
  SigningPointCache,
  createSequentialSignatureVerify,
  openHistoryPacket,
  sealHistoryPacket,
  sequentialSignatureVerify,
} from '@lody/e2ee-core/ledger';
import { createNodeSignatureVerifyExecutor } from '@lody/e2ee-core/ledger-node';
import { encodeSignedRecord } from '../src/ledger/schema';
import { admitDeviceOp, append, ed25519, random, signGenesis } from './ledger-fixtures';

function expectCode(error: unknown, code: string, position?: number): void {
  expect(error).toBeInstanceOf(LedgerError);
  expect((error as LedgerError).code).toBe(code);
  if (position !== undefined) expect((error as LedgerError).position).toBe(position);
}

function scriptedEntropy(script: Record<string, Uint8Array[]>): Entropy {
  const remaining: Record<string, Uint8Array[]> = {};
  for (const [label, values] of Object.entries(script)) {
    remaining[label] = values.map((value) => new Uint8Array(value));
  }
  return {
    fill(label, bytes) {
      const next = remaining[label]?.shift();
      if (!next || next.byteLength !== bytes.byteLength) {
        throw new Error(`entropy-mismatch:${label}:${bytes.byteLength}`);
      }
      bytes.set(next);
      return bytes;
    },
  };
}

describe('E1 pure ledger boundary', () => {
  it('does not mutate caller records or the previous ledger', async () => {
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const original = new Uint8Array(created.record);
    const input = new Uint8Array(created.record);
    const verified = await Ledger.verify({ anchor: created.anchor, records: [input] });
    expect(verified.head).toEqual(created.ledger.head);
    expect(input).toEqual(original);
    input[0] = (input[0] ?? 0) ^ 0xff;
    expect(created.ledger.head).toEqual(verified.head);
    expect(created.ledger.length).toBe(1);

    const phone = await ed25519();
    const next = await append(
      created.ledger,
      owner,
      await admitDeviceOp(created.anchor, created.membershipId, phone, 'personal')
    );
    expect(created.ledger.length).toBe(1);
    expect(created.ledger.state.devices.size).toBe(1);
    expect(next.ledger.length).toBe(2);
    expect(next.ledger.state.devices.size).toBe(2);
  });

  it('keeps verification verdicts when the point cache is disabled or isolated', async () => {
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const disabled = new SigningPointCache({ enabled: false });
    const isolated = new SigningPointCache({ maxEntries: 4 });
    const other = new SigningPointCache({ maxEntries: 4 });
    const a = await Ledger.verify({
      anchor: created.anchor,
      records: [created.record],
      pointCache: disabled,
    });
    const b = await Ledger.verify({
      anchor: created.anchor,
      records: [created.record],
      pointCache: isolated,
    });
    expect(a.head).toEqual(b.head);
    expect(a.head).toEqual(created.ledger.head);
    expect(disabled.size).toBe(0);
    expect(isolated.size).toBeGreaterThan(0);
    expect(other.size).toBe(0);

    const forged = new Uint8Array(created.record);
    forged[forged.byteLength - 1] = (forged[forged.byteLength - 1] ?? 0) ^ 0xff;
    for (const cache of [disabled, isolated, other]) {
      try {
        await Ledger.verify({ anchor: created.anchor, records: [forged], pointCache: cache });
        throw new Error('forged-accepted');
      } catch (error) {
        expectCode(error, 'bad-signature', 0);
      }
    }
  });

  it('threads the injected cache through extend/prepare/finalize without changing verdicts', async () => {
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const isolated = new SigningPointCache({ maxEntries: 16 });
    const other = new SigningPointCache({ maxEntries: 16 });
    const disabled = new SigningPointCache({ enabled: false });
    const verified = await Ledger.verify({
      anchor: created.anchor,
      records: [created.record],
      pointCache: isolated,
    });

    const phone = await ed25519();
    const operation = await admitDeviceOp(created.anchor, created.membershipId, phone, 'personal');
    const proposal = verified.prepare(operation, owner.publicKey, isolated);
    const record = encodeSignedRecord(proposal.bodyBytes, await owner.sign(proposal.signingBytes));

    // Synchronous apply path consumes the injected instance, not the process default.
    const extended = await verified.extend([record], other);
    expect(extended.length).toBe(2);
    expect(extended.state.devices.size).toBe(2);
    expect(other.size).toBeGreaterThan(0);

    const extendedDisabled = await verified.extend([record], disabled);
    expect(extendedDisabled.head).toEqual(extended.head);
    expect(disabled.size).toBe(0);

    const forged = new Uint8Array(record);
    forged[forged.byteLength - 1] = (forged[forged.byteLength - 1] ?? 0) ^ 0xff;
    for (const cache of [disabled, isolated, other]) {
      try {
        await verified.extend([forged], cache);
        throw new Error('forged-accepted');
      } catch (error) {
        expectCode(error, 'bad-signature', 1);
      }
    }
  });
});

describe('E2 explicit verify executor', () => {
  it('uses the injected executor and matches sequential and Node-parallel error positions', async () => {
    const owner = await ed25519();
    const created = await signGenesis(owner);
    let ledger = created.ledger;
    const records = [created.record];
    for (let i = 0; i < 31; i++) {
      const device = await ed25519();
      const next = await append(
        ledger,
        owner,
        await admitDeviceOp(created.anchor, created.membershipId, device, 'personal')
      );
      records.push(next.record);
      ledger = next.ledger;
    }
    const attacker = await ed25519();
    const forgedOp = await admitDeviceOp(
      created.anchor,
      created.membershipId,
      attacker,
      'personal'
    );
    forgedOp.possessionSignature[0] = (forgedOp.possessionSignature[0] ?? 0) ^ 0xff;
    const proposal = ledger.prepare(forgedOp, owner.publicKey);
    const forgedRecord = encodeSignedRecord(
      proposal.bodyBytes,
      await owner.sign(proposal.signingBytes)
    );
    const chain = [...records, forgedRecord];

    try {
      await Ledger.verify({
        anchor: created.anchor,
        records: chain,
        executor: sequentialSignatureVerify,
      });
      throw new Error('forged-proof-accepted-recording');
    } catch (error) {
      expectCode(error, 'bad-proof');
    }

    try {
      await Ledger.verify({
        anchor: created.anchor,
        records: chain,
        executor: { verify: async (jobs) => jobs.map(() => true) },
      });
      throw new Error('untrusted-executor-accepted');
    } catch (error) {
      expectCode(error, 'invalid-operation');
    }

    const previous = process.env.LODY_E2EE_VERIFY_WORKERS;
    process.env.LODY_E2EE_VERIFY_WORKERS = '8';
    const positions: Array<number | undefined> = [];
    for (const executor of [
      undefined,
      createSequentialSignatureVerify(),
      createNodeSignatureVerifyExecutor(),
    ]) {
      try {
        await Ledger.verify({
          anchor: created.anchor,
          records: chain,
          ...(executor ? { executor } : {}),
        });
        throw new Error('forged-proof-accepted');
      } catch (error) {
        expectCode(error, 'bad-proof');
        positions.push(error instanceof LedgerError ? error.position : undefined);
      }
    }
    expect(new Set(positions).size).toBe(1);
    if (previous === undefined) delete process.env.LODY_E2EE_VERIFY_WORKERS;
    else process.env.LODY_E2EE_VERIFY_WORKERS = previous;
  });
});

describe('E3 entropy, clock and timer ports', () => {
  it('seals a history packet from labeled entropy and still opens with real decryption', async () => {
    const owner = await ed25519();
    const k0 = random(32);
    const k1 = random(32);
    const created = await signGenesis(owner, k0);
    const nonce = new Uint8Array(24).fill(7);
    const packet = sealHistoryPacket(
      k1,
      k0,
      created.anchor,
      1,
      scriptedEntropy({ 'history-packet-nonce': [nonce] })
    );
    expect(packet.subarray(0, 24)).toEqual(nonce);
    expect(openHistoryPacket(k1, packet, created.anchor, 1)).toEqual(k0);
    const live = sealHistoryPacket(k1, k0, created.anchor, 1, liveEntropy);
    expect(live.byteLength).toBe(packet.byteLength);
    expect(openHistoryPacket(k1, live, created.anchor, 1)).toEqual(k0);
  });

  it('creates a recovery file from labeled entropy without changing open/seal', async () => {
    const created = await createUserIdentity();
    const key = new Uint8Array(32).fill(9);
    const id = new Uint8Array(16).fill(4);
    const nonce = new Uint8Array(24).fill(5);
    const entropy = scriptedEntropy({
      'recovery-file-key': [key],
      'recovery-file-id': [id],
      'recovery-backup-nonce': [nonce],
    });
    const file = createRecoveryFile(entropy);
    const parsed = parseRecoveryFile(file);
    expect(parsed.key).toEqual(key);
    const expected = { identity: created.identity.fingerprint, revision: 0 };
    const material = new Uint8Array(created.privateMaterial);
    const frame = sealRecoveryBackup(file, expected, material, entropy);
    const aadLength = new DataView(frame.buffer, frame.byteOffset, 2).getUint16(0);
    expect(frame.subarray(2 + aadLength, 2 + aadLength + 24)).toEqual(nonce);
    expect(openRecoveryBackup(file, expected, frame)).toEqual(material);
    created.privateMaterial.fill(0);
    material.fill(0);
  });

  it('schedules the original remaining lease and does not restart expiry', async () => {
    const scheduled: number[] = [];
    let fire: (() => void) | undefined;
    let now = 1_000;
    const pending = createBoundedStreamsFetch({
      fetch: () => new Promise<Response>(() => {}),
      maxResponseBytes: 1024,
      requestTimeoutMs: 5_000,
      now: () => now,
      authorize: () => ({
        expiresAt: 1_400,
        signal: new AbortController().signal,
        assertValid: () => {},
      }),
      scheduleTimer: (ms, onFire) => {
        scheduled.push(ms);
        fire = onFire;
        return {
          clear() {
            fire = undefined;
          },
        };
      },
    })('https://streams.example.test/v1');
    expect(scheduled).toEqual([400]);
    now = 1_400;
    fire?.();
    await expect(pending).rejects.toThrow('stream-request-expired');
    expect(scheduled).toEqual([400]);
  });

  it('creates a user identity through the injected platform', async () => {
    let generateKey = 0;
    const platform = {
      getRandomValues: liveCryptoPlatform.getRandomValues.bind(liveCryptoPlatform),
      subtle: new Proxy(liveCryptoPlatform.subtle, {
        get(target, property, receiver) {
          if (property === 'generateKey') generateKey += 1;
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    };
    const created = await createUserIdentity(platform);
    expect(generateKey).toBeGreaterThanOrEqual(2);
    expect(created.identity.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    created.privateMaterial.fill(0);
  });
});
