import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { LedgerError } from '../src/ledger';
import {
  LedgerKeyDelivery,
  MemoryLedgerKeyOutbox,
  openEpochEnvelope,
  sealEpochEnvelope,
} from '../src/ledger';
import { SqliteLedgerKeyOutbox } from '../src/ledger/node-store';
import { admitDeviceOp, append, ed25519, hex, random, signGenesis } from './ledger-fixtures';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function deliveryId(): string {
  return hex(random(16));
}

async function device() {
  const keys = await ed25519();
  const dh = (await crypto.subtle.generateKey('X25519', false, ['deriveBits'])) as CryptoKeyPair;
  const enc = new Uint8Array(await crypto.subtle.exportKey('raw', dh.publicKey));
  return { ...keys, enc, dh };
}

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(LedgerError);
  expect((error as LedgerError).code).toBe(code);
}

describe('K1 durable epoch-key delivery', () => {
  it('persists exact ciphertext, retries without re-encrypting, and refuses a revoked recipient', async () => {
    const owner = await device();
    const k0 = random(32);
    const created = await signGenesis(owner, k0);
    const phone = await device();
    const admitted = await append(
      created.ledger,
      owner,
      await admitDeviceOp(created.anchor, phone, 'personal', true)
    );
    const frame = await sealEpochEnvelope({
      state: admitted.ledger.state,
      genesis: created.anchor,
      epoch: 0,
      sender: owner.publicKey,
      recipient: phone.publicKey,
      recipientEncryptionKey: phone.enc,
      epochKey: k0,
      sign: (bytes) => owner.sign(bytes),
    });
    const sealedOnce = new Uint8Array(frame);
    let state = admitted.ledger.state;
    const authorize = async (bytes: Uint8Array) => {
      const sender = state.devices.get(hex(owner.publicKey));
      if (!sender || sender.kind !== 'personal' || !sender.canManage) {
        throw new LedgerError('unauthorized');
      }
      await openEpochEnvelope({
        state,
        genesis: created.anchor,
        epoch: 0,
        sender: owner.publicKey,
        recipient: phone.publicKey,
        recipientKeyPair: phone.dh,
        frame: bytes,
      });
    };

    const remoteFrames = new Map<string, Uint8Array>();
    let puts = 0;
    let failPut = true;
    let failRead = true;
    const remote = {
      async put(id: string, body: Uint8Array) {
        puts += 1;
        if (failPut) throw new Error('lost-ack');
        remoteFrames.set(id, new Uint8Array(body));
      },
      async read(id: string) {
        if (failRead) throw new Error('unreachable');
        const saved = remoteFrames.get(id);
        return saved === undefined ? null : new Uint8Array(saved);
      },
    };
    const outbox = new MemoryLedgerKeyOutbox();
    const delivery = new LedgerKeyDelivery(outbox, remote);
    const id = deliveryId();

    expect(await delivery.send(id, frame, authorize)).toBe('unknown');
    expect(puts).toBe(1);
    const stored = outbox.frames.get(id);
    expect(stored).toEqual(sealedOnce);
    frame.fill(0);
    expect(outbox.frames.get(id)).toEqual(sealedOnce);

    const other = new Uint8Array(sealedOnce);
    other[0] = (other[0] ?? 0) ^ 0xff;
    try {
      await delivery.send(id, other, authorize);
      throw new Error('accepted-reencrypt');
    } catch (error) {
      expectCode(error, 'replay');
    }
    expect(outbox.frames.get(id)).toEqual(sealedOnce);

    failPut = false;
    failRead = false;
    expect(await delivery.send(id, undefined, authorize)).toBe('observed');
    expect(puts).toBe(2);
    expect(remoteFrames.get(id)).toEqual(sealedOnce);
    expect(
      await openEpochEnvelope({
        state,
        genesis: created.anchor,
        epoch: 0,
        sender: owner.publicKey,
        recipient: phone.publicKey,
        recipientKeyPair: phone.dh,
        frame: remoteFrames.get(id)!,
      })
    ).toEqual(k0);

    const revoked = await append(admitted.ledger, owner, {
      type: 'revokeDevice',
      target: phone.publicKey,
    });
    state = revoked.ledger.state;
    const before = puts;
    try {
      await delivery.send(id, undefined, authorize);
      throw new Error('delivered-after-revoke');
    } catch (error) {
      expectCode(error, 'unauthorized');
    }
    expect(puts).toBe(before);
    expect(outbox.frames.get(id)).toEqual(sealedOnce);
  });

  it('Promise and Effect send persist and retry the same ciphertext', async () => {
    const owner = await device();
    const k0 = random(32);
    const created = await signGenesis(owner, k0);
    const phone = await device();
    const admitted = await append(
      created.ledger,
      owner,
      await admitDeviceOp(created.anchor, phone, 'personal', true)
    );
    const frame = await sealEpochEnvelope({
      state: admitted.ledger.state,
      genesis: created.anchor,
      epoch: 0,
      sender: owner.publicKey,
      recipient: phone.publicKey,
      recipientEncryptionKey: phone.enc,
      epochKey: k0,
      sign: (bytes) => owner.sign(bytes),
    });
    const remoteA = new Map<string, Uint8Array>();
    const remoteB = new Map<string, Uint8Array>();
    const authorize = async () => {};
    const deliveryA = new LedgerKeyDelivery(new MemoryLedgerKeyOutbox(), {
      async put(id, body) {
        remoteA.set(id, new Uint8Array(body));
      },
      async read(id) {
        return remoteA.get(id) ? new Uint8Array(remoteA.get(id)!) : null;
      },
    });
    const deliveryB = new LedgerKeyDelivery(new MemoryLedgerKeyOutbox(), {
      async put(id, body) {
        remoteB.set(id, new Uint8Array(body));
      },
      async read(id) {
        return remoteB.get(id) ? new Uint8Array(remoteB.get(id)!) : null;
      },
    });
    const id = deliveryId();
    expect(await deliveryA.send(id, new Uint8Array(frame), authorize)).toBe('observed');
    expect(
      await Effect.runPromise(deliveryB.sendEffect(id, new Uint8Array(frame), authorize))
    ).toBe('observed');
    expect(remoteA.get(id)).toEqual(frame);
    expect(remoteB.get(id)).toEqual(frame);
  });

  it('re-checks authorization after save and does not put if the second check fails', async () => {
    const owner = await device();
    const k0 = random(32);
    const created = await signGenesis(owner, k0);
    const phone = await device();
    const admitted = await append(
      created.ledger,
      owner,
      await admitDeviceOp(created.anchor, phone, 'personal', true)
    );
    const frame = await sealEpochEnvelope({
      state: admitted.ledger.state,
      genesis: created.anchor,
      epoch: 0,
      sender: owner.publicKey,
      recipient: phone.publicKey,
      recipientEncryptionKey: phone.enc,
      epochKey: k0,
      sign: (bytes) => owner.sign(bytes),
    });
    let checks = 0;
    const remotePuts: Uint8Array[] = [];
    const delivery = new LedgerKeyDelivery(new MemoryLedgerKeyOutbox(), {
      async put(_id, body) {
        remotePuts.push(new Uint8Array(body));
      },
      async read() {
        return null;
      },
    });
    try {
      await delivery.send(deliveryId(), frame, async () => {
        checks += 1;
        if (checks >= 2) throw new LedgerError('unauthorized');
      });
      throw new Error('put-after-failed-recheck');
    } catch (error) {
      expectCode(error, 'unauthorized');
    }
    expect(checks).toBe(2);
    expect(remotePuts).toEqual([]);
  });

  it('reloads the exact saved frame from sqlite after a lost ACK', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lody-ledger-key-outbox-'));
    dirs.push(dir);
    const path = join(dir, 'keys.sqlite');
    const owner = await device();
    const k0 = random(32);
    const created = await signGenesis(owner, k0);
    const phone = await device();
    const admitted = await append(
      created.ledger,
      owner,
      await admitDeviceOp(created.anchor, phone, 'personal', true)
    );
    const frame = await sealEpochEnvelope({
      state: admitted.ledger.state,
      genesis: created.anchor,
      epoch: 0,
      sender: owner.publicKey,
      recipient: phone.publicKey,
      recipientEncryptionKey: phone.enc,
      epochKey: k0,
      sign: (bytes) => owner.sign(bytes),
    });
    const sealedOnce = new Uint8Array(frame);
    const authorize = async (bytes: Uint8Array) => {
      await openEpochEnvelope({
        state: admitted.ledger.state,
        genesis: created.anchor,
        epoch: 0,
        sender: owner.publicKey,
        recipient: phone.publicKey,
        recipientKeyPair: phone.dh,
        frame: bytes,
      });
    };
    const remoteFrames = new Map<string, Uint8Array>();
    let failPut = true;
    const remote = {
      async put(id: string, body: Uint8Array) {
        if (failPut) throw new Error('lost-ack');
        remoteFrames.set(id, new Uint8Array(body));
      },
      async read(id: string) {
        const saved = remoteFrames.get(id);
        return saved === undefined ? null : new Uint8Array(saved);
      },
    };
    const id = deliveryId();
    const first = new LedgerKeyDelivery(new SqliteLedgerKeyOutbox(path), remote);
    expect(await first.send(id, frame, authorize)).toBe('unknown');

    failPut = false;
    const restarted = new LedgerKeyDelivery(new SqliteLedgerKeyOutbox(path), remote);
    expect(await restarted.send(id, undefined, authorize)).toBe('observed');
    expect(remoteFrames.get(id)).toEqual(sealedOnce);
  });

  it('does not persist when the recipient is revoked before the first authorize returns', async () => {
    const owner = await device();
    const k0 = random(32);
    const created = await signGenesis(owner, k0);
    const phone = await device();
    const admitted = await append(
      created.ledger,
      owner,
      await admitDeviceOp(created.anchor, phone, 'personal', true)
    );
    const frame = await sealEpochEnvelope({
      state: admitted.ledger.state,
      genesis: created.anchor,
      epoch: 0,
      sender: owner.publicKey,
      recipient: phone.publicKey,
      recipientEncryptionKey: phone.enc,
      epochKey: k0,
      sign: (bytes) => owner.sign(bytes),
    });
    let state = admitted.ledger.state;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const authorize = async (bytes: Uint8Array) => {
      entered();
      await blocked;
      const sender = state.devices.get(hex(owner.publicKey));
      if (!sender || sender.kind !== 'personal' || !sender.canManage) {
        throw new LedgerError('unauthorized');
      }
      await openEpochEnvelope({
        state,
        genesis: created.anchor,
        epoch: 0,
        sender: owner.publicKey,
        recipient: phone.publicKey,
        recipientKeyPair: phone.dh,
        frame: bytes,
      });
    };
    const outbox = new MemoryLedgerKeyOutbox();
    const puts: Uint8Array[] = [];
    const delivery = new LedgerKeyDelivery(outbox, {
      async put(_id, body) {
        puts.push(new Uint8Array(body));
      },
      async read() {
        return null;
      },
    });
    const id = deliveryId();
    const pending = delivery.send(id, frame, authorize);
    await started;
    const revoked = await append(admitted.ledger, owner, {
      type: 'revokeDevice',
      target: phone.publicKey,
    });
    state = revoked.ledger.state;
    release();
    try {
      await pending;
      throw new Error('persisted-after-pre-save-revoke');
    } catch (error) {
      expectCode(error, 'unauthorized');
    }
    expect(outbox.frames.size).toBe(0);
    expect(puts).toEqual([]);
  });

  it('keeps admission, outbox persist, remote observe, and local open as distinct states', async () => {
    const owner = await device();
    const k0 = random(32);
    const created = await signGenesis(owner, k0);
    const phone = await device();
    const admitted = await append(
      created.ledger,
      owner,
      await admitDeviceOp(created.anchor, phone, 'personal', true)
    );
    const frame = await sealEpochEnvelope({
      state: admitted.ledger.state,
      genesis: created.anchor,
      epoch: 0,
      sender: owner.publicKey,
      recipient: phone.publicKey,
      recipientEncryptionKey: phone.enc,
      epochKey: k0,
      sign: (bytes) => owner.sign(bytes),
    });
    const sealedOnce = new Uint8Array(frame);
    const outbox = new MemoryLedgerKeyOutbox();
    const remoteFrames = new Map<string, Uint8Array>();
    const delivery = new LedgerKeyDelivery(outbox, {
      async put(id, body) {
        remoteFrames.set(id, new Uint8Array(body));
      },
      async read(id) {
        const saved = remoteFrames.get(id);
        return saved === undefined ? null : new Uint8Array(saved);
      },
    });
    const id = deliveryId();
    expect(outbox.frames.has(id)).toBe(false);
    expect(remoteFrames.has(id)).toBe(false);
    const observed = await delivery.send(id, frame, async (bytes) => {
      await openEpochEnvelope({
        state: admitted.ledger.state,
        genesis: created.anchor,
        epoch: 0,
        sender: owner.publicKey,
        recipient: phone.publicKey,
        recipientKeyPair: phone.dh,
        frame: bytes,
      });
    });
    expect(observed).toBe('observed');
    expect(outbox.frames.get(id)).toEqual(sealedOnce);
    expect(remoteFrames.get(id)).toEqual(sealedOnce);
    const opened = await openEpochEnvelope({
      state: admitted.ledger.state,
      genesis: created.anchor,
      epoch: 0,
      sender: owner.publicKey,
      recipient: phone.publicKey,
      recipientKeyPair: phone.dh,
      frame: remoteFrames.get(id)!,
    });
    expect(opened).toEqual(k0);
    expect(admitted.ledger.state.epoch.number).toBe(0);
  });
});
