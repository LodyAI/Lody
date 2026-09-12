import { mkdtempSync, rmSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { deferred } from './control-fixtures';
import { SqliteEpochControlStore } from '../src/node-epoch-store';
import { SqliteControlStore } from '../src/node-store';
import { SqliteHistoryPublicationStore } from '../src/node-history-store';
import { MemoryStore } from './control-fixtures';
import { HistoryPublisher, ContentCipher, sealEpochHistory } from '../src';
import { commitEpochKey, VerifiedEpochKeys } from '../src/epoch-keys';
import {
  ControlLogClient,
  EpochPublisher,
  WebCryptoControl,
  toHex,
  deriveTeamAnchor,
  decodeRecord,
  encodeTeamAction,
  ownerManagedTeamPolicy,
  type ControlStream,
  type ControlEvent,
  type EpochPublicationStore,
} from '../src';
import {
  createLocalEpochProtection,
  createLocalDeviceProtection,
  createLocalUserProtection,
} from '../../../apps/electron/src/main/services/e2ee-key-protection-core';
import { SqliteDeviceIdentityStore } from '../src/node-device-store';
import { SqliteUserIdentityStore } from '../src/node-user-store';
import { createRecoveryFile, openRecoveryBackup } from '../src/recovery-file';
import { restoreUserIdentity } from '../src/user-identity';
import {
  saveRecoveryFile,
  readRecoveryFile,
} from '../../../apps/electron/src/main/services/e2ee-recovery-file-io';
import { E2eeUserService } from '../../../apps/electron/src/main/services/e2ee-user-service';
it('restores a recovery file into a new device account without replacing an existing identity', async () => {
  let generation = 0;
  const options = {
    enabled: true,
    authOrigin: 'https://auth.example.test',
    account: async () => {
      const captured = generation;
      return {
        userId: 'alice',
        assertCurrent() {
          if (captured !== generation) throw new Error('e2ee-account-changed');
        },
      };
    },
    protection: protection().user,
  };
  const source = new E2eeUserService({ ...options, directory: join(location(), '..', 'source') });
  const identity = await source.create();
  let saved!: Uint8Array;
  const backup = await source.exportRecoveryBackup(0, async (file) => {
    saved = new Uint8Array(file);
    return true;
  });
  if (!backup) throw new Error('missing backup');
  const target = new E2eeUserService({ ...options, directory: join(location(), '..', 'target') });
  let selected!: Uint8Array;
  const select = async () => {
    selected = new Uint8Array(saved);
    return selected;
  };
  expect(await target.selectRecoveryBackup(select)).toEqual({
    accountId: 'alice',
    backupId: backup.backupId,
  });
  expect(selected.every((byte) => byte === 0)).toBe(true);
  await expect(target.load()).rejects.toThrow('user-identity-missing');
  expect(await target.restoreRecoveryBackup(backup, async () => null)).toBeNull();
  await expect(
    target.restoreRecoveryBackup(backup, async () => {
      generation++;
      return select();
    })
  ).rejects.toThrow('e2ee-account-changed');
  expect(selected.every((byte) => byte === 0)).toBe(true);
  await expect(target.load()).rejects.toThrow('user-identity-missing');
  await expect(
    target.restoreRecoveryBackup({ ...backup, accountId: 'bob' }, select)
  ).rejects.toThrow('recovery-account-mismatch');
  await expect(
    target.restoreRecoveryBackup(backup, async () => createRecoveryFile())
  ).rejects.toThrow('recovery-file-mismatch');
  const corrupt = new Uint8Array(backup.ciphertext);
  corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
  await expect(
    target.restoreRecoveryBackup({ ...backup, ciphertext: corrupt }, select)
  ).rejects.toThrow();
  expect(selected.every((byte) => byte === 0)).toBe(true);
  await expect(target.load()).rejects.toThrow('user-identity-missing');
  expect(await target.restoreRecoveryBackup(backup, select)).toEqual({
    accountId: 'alice',
    fingerprint: identity.fingerprint,
  });
  expect(selected.every((byte) => byte === 0)).toBe(true);
  expect(await target.load()).toEqual(identity);
  await expect(target.restoreRecoveryBackup(backup, select)).rejects.toThrow(
    'user-identity-exists'
  );
  expect(await target.load()).toEqual(identity);
  saved.fill(0);
});

it('exports only encrypted backup after a real exclusive file save, and preserves existing files', async () => {
  const path = location();
  const service = new E2eeUserService({
    enabled: true,
    directory: join(path, '..', 'users'),
    authOrigin: 'https://auth.example.test',
    account: async () => ({ userId: 'alice', assertCurrent() {} }),
    protection: protection().user,
  });
  const identity = await service.create();
  let held: Uint8Array | undefined;
  expect(
    await service.exportRecoveryBackup(0, async (file) => {
      held = file;
      return false;
    })
  ).toBeNull();
  expect(held?.every((byte) => byte === 0)).toBe(true);
  const backup = await service.exportRecoveryBackup(0, async (file, _id, guard) => {
    held = file;
    await saveRecoveryFile(path, file, guard);
    return true;
  });
  expect(held?.every((byte) => byte === 0)).toBe(true);
  expect(backup).not.toBeNull();
  if (!backup) throw new Error('missing backup');
  expect(Object.keys(backup).sort()).toEqual([
    'accountId',
    'backupId',
    'ciphertext',
    'identity',
    'revision',
  ]);
  const saved = readFileSync(path);
  let selected: Uint8Array | undefined;
  const select = async (guard: () => void) => {
    selected = await readRecoveryFile(path, guard);
    return selected;
  };
  expect(await service.verifyRecoveryBackup(0, backup.ciphertext, select)).toEqual({
    backupId: backup.backupId,
    identity: identity.fingerprint,
    revision: 0,
  });
  expect(selected?.every((byte) => byte === 0)).toBe(true);
  expect(await service.verifyRecoveryBackup(0, backup.ciphertext, async () => null)).toBeNull();
  await expect(service.verifyRecoveryBackup(1, backup.ciphertext, select)).rejects.toThrow();
  expect(selected?.every((byte) => byte === 0)).toBe(true);
  const corrupt = new Uint8Array(backup.ciphertext);
  corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
  await expect(service.verifyRecoveryBackup(0, corrupt, select)).rejects.toThrow();
  expect(selected?.every((byte) => byte === 0)).toBe(true);
  await expect(
    service.verifyRecoveryBackup(0, backup.ciphertext, async () => createRecoveryFile())
  ).rejects.toThrow();
  const material = openRecoveryBackup(saved, backup, backup.ciphertext);
  try {
    expect((await restoreUserIdentity(material, identity.fingerprint)).fingerprint).toBe(
      identity.fingerprint
    );
  } finally {
    material.fill(0);
  }
  await expect(
    service.exportRecoveryBackup(1, async (file, _id, guard) => {
      await saveRecoveryFile(path, file, guard);
      return true;
    })
  ).rejects.toThrow('EEXIST');
  expect(readFileSync(path)).toEqual(saved);
  expect(await service.load()).toEqual(identity);
});

it('does not return a recovery backup after the account changes during the native dialog', async () => {
  let generation = 0;
  const service = new E2eeUserService({
    enabled: true,
    directory: join(location(), '..', 'users'),
    authOrigin: 'https://auth.example.test',
    account: async () => {
      const captured = generation;
      return {
        userId: 'alice',
        assertCurrent() {
          if (captured !== generation) throw new Error('e2ee-account-changed');
        },
      };
    },
    protection: protection().user,
  });
  const identity = await service.create();
  let held: Uint8Array | undefined;
  await expect(
    service.exportRecoveryBackup(0, async (file) => {
      held = file;
      generation++;
      return true;
    })
  ).rejects.toThrow('e2ee-account-changed');
  expect(held?.every((byte) => byte === 0)).toBe(true);
  expect(await service.load()).toEqual(identity);
  const backup = await service.exportRecoveryBackup(0, async (file) => {
    held = new Uint8Array(file);
    return true;
  });
  if (!backup || !held) throw new Error('missing backup');
  await expect(
    service.verifyRecoveryBackup(0, backup.ciphertext, async () => {
      generation++;
      return held!;
    })
  ).rejects.toThrow('e2ee-account-changed');
  expect(held.every((byte) => byte === 0)).toBe(true);
  expect(await service.load()).toEqual(identity);
});

it('bounds selected recovery files and refuses directories and symbolic links', async () => {
  const path = location();
  writeFileSync(path, new Uint8Array(257));
  await expect(readRecoveryFile(path, () => {})).rejects.toThrow('invalid-recovery-file');
  writeFileSync(path, new Uint8Array());
  await expect(readRecoveryFile(path, () => {})).rejects.toThrow('invalid-recovery-file');
  await expect(readRecoveryFile(join(path, '..'), () => {})).rejects.toThrow();
  const alias = `${path}-link`;
  symlinkSync(path, alias);
  await expect(readRecoveryFile(alias, () => {})).rejects.toThrow();
});
it('main user service returns public identity only and isolates accounts and auth domains', async () => {
  const directory = join(location(), '..', 'devices'),
    p = protection();
  let userId = 'alice';
  const options = {
    enabled: true,
    directory,
    authOrigin: 'https://auth.example.test',
    account: async () => ({ userId, assertCurrent() {} }),
    protection: p.user,
  };
  const service = new E2eeUserService(options);
  const alice = await service.create();
  expect(Object.keys(alice).sort()).toEqual([
    'encryptionPublicKey',
    'fingerprint',
    'signingPublicKey',
  ]);
  expect(await new E2eeUserService(options).load()).toEqual(alice);
  await expect(service.create()).rejects.toThrow('user-identity-exists');
  userId = 'bob';
  await expect(service.load()).rejects.toThrow('user-identity-missing');
  await expect(service.load()).rejects.toThrow('user-identity-missing');
  const bob = await service.create();
  expect(bob.fingerprint).not.toBe(alice.fingerprint);
  userId = 'alice';
  expect(await service.load()).toEqual(alice);
  await expect(
    new E2eeUserService({ ...options, authOrigin: 'https://other.example.test' }).load()
  ).rejects.toThrow('user-identity-missing');
});

it('main user service withholds an in-flight result when the account lease expires', async () => {
  const directory = join(location(), '..', 'devices'),
    p = protection();
  let generation = 0;
  let expire = true;
  const options = {
    enabled: true,
    directory,
    authOrigin: 'https://auth.example.test',
    account: async () => {
      const captured = generation;
      return {
        userId: 'alice',
        assertCurrent() {
          if (captured !== generation) throw new Error('e2ee-account-changed');
        },
      };
    },
    protection: {
      ...p.user,
      seal(binding: string, plaintext: Uint8Array) {
        const wrapped = p.user.seal(binding, plaintext);
        if (expire) generation++;
        return wrapped;
      },
    },
  };
  await expect(new E2eeUserService(options).create()).rejects.toThrow('e2ee-account-changed');
  expire = false;
  const restored = await new E2eeUserService(options).load();
  expect(restored.fingerprint).toHaveLength(64);
  await expect(new E2eeUserService(options).create()).rejects.toThrow('user-identity-exists');
});
import { E2eeDeviceService } from '../../../apps/electron/src/main/services/e2ee-device-service';

it('local-mode user identity rejects before resolving any cloud account', async () => {
  const service = new E2eeUserService({
    enabled: false,
    directory: join(location(), '..', 'users'),
    authOrigin: 'https://auth.example.test',
    account: async () => {
      throw new Error('must-not-resolve-cloud-account');
    },
    protection: protection().user,
  });
  await expect(service.create()).rejects.toThrow('e2ee-user-unavailable');
  await expect(service.load()).rejects.toThrow('e2ee-user-unavailable');
});

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function location() {
  const dir = mkdtempSync(join(tmpdir(), 'lody-epoch-store-'));
  dirs.push(dir);
  return join(dir, 'epochs.sqlite');
}
function protection() {
  // Test OS wrapping only. Run the actual desktop boundary with a synthetic
  // authenticated native-crypto provider, not an identity/plaintext stub.
  const osKey = randomBytes(32);
  const state = { available: true };
  const runtime = {
    platform: 'darwin',
    isReady: () => true,
    isPlaintextAuthEnabled: () => false,
    safeStorage: {
      isEncryptionAvailable: () => state.available,
      getSelectedStorageBackend: () => 'unknown',
      encryptString(text: string) {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', osKey, iv);
        const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
      },
      decryptString(bytes: Buffer) {
        const cipher = createDecipheriv('aes-256-gcm', osKey, bytes.subarray(0, 12));
        cipher.setAuthTag(bytes.subarray(12, 28));
        return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
      },
    },
  };
  return {
    value: createLocalEpochProtection(runtime),
    device: createLocalDeviceProtection(runtime),
    user: createLocalUserProtection(runtime),
    state,
  };
}

it('persists a separately OS-wrapped user identity and recovers only into an empty store', async () => {
  const os = protection();
  const path = location();
  const binding = '21'.repeat(32);
  let privateHex = '';
  const store = new SqliteUserIdentityStore(path, binding, {
    ...os.user,
    seal(account, bytes) {
      privateHex = toHex(bytes);
      return os.user.seal(account, bytes);
    },
  });
  const created = await store.create();
  expect(privateHex.length).toBeGreaterThan(0);
  expect(readFileSync(path).includes(Buffer.from(privateHex, 'hex'))).toBe(false);
  expect(readFileSync(path).includes(Buffer.from(privateHex))).toBe(false);
  const reopened = new SqliteUserIdentityStore(path, binding, os.user);
  expect((await reopened.load()).fingerprint).toBe(created.fingerprint);
  await expect(reopened.create()).rejects.toThrow('user-identity-exists');
  const file = createRecoveryFile();
  const context = { identity: created.fingerprint, revision: 0 };
  const frame = await reopened.sealBackup(file, context);
  const target = new SqliteUserIdentityStore(location(), binding, os.user);
  const recovered = await target.recover(file, context, frame);
  expect(recovered.fingerprint).toBe(created.fingerprint);
  expect((await target.load()).fingerprint).toBe(created.fingerprint);
  expect(recovered.signing.privateKey.extractable).toBe(false);
  await expect(target.recover(file, context, frame)).rejects.toThrow('user-identity-exists');
  await expect(
    reopened.sealBackup(file, { ...context, identity: '22'.repeat(32) })
  ).rejects.toThrow('user-identity-mismatch');
  await expect(new SqliteUserIdentityStore(path, '23'.repeat(32), os.user).load()).rejects.toThrow(
    'user-store-binding-mismatch'
  );
});

it('keeps user and device storage/wrapping domains distinct and fails closed when locked', async () => {
  const os = protection();
  const binding = '31'.repeat(32);
  const bytes = new Uint8Array([1, 2, 3]);
  expect(() => os.device.open(binding, os.user.seal(binding, bytes))).toThrow();
  expect(() => os.user.open(binding, os.device.seal(binding, bytes))).toThrow();
  const path = location();
  const store = new SqliteUserIdentityStore(path, binding, os.user);
  await expect(store.load()).rejects.toThrow('user-identity-missing');
  const created = await store.create();
  await expect(new SqliteDeviceIdentityStore(path, binding, os.device).load()).rejects.toThrow(
    'unsupported-journal-database'
  );
  os.state.available = false;
  await expect(store.load()).rejects.toThrow('secure-key-storage-unavailable');
  await expect(store.create()).rejects.toThrow('user-identity-exists');
  os.state.available = true;
  expect((await store.load()).fingerprint).toBe(created.fingerprint);
});

it('does not persist or replace a user identity when its protected roundtrip fails', async () => {
  const os = protection();
  const path = location();
  const binding = '41'.repeat(32);
  const broken = new SqliteUserIdentityStore(path, binding, {
    ...os.user,
    open() {
      return new Uint8Array([1]);
    },
  });
  await expect(broken.create()).rejects.toThrow('user-protection-roundtrip-mismatch');
  const real = new SqliteUserIdentityStore(path, binding, os.user);
  await expect(real.load()).rejects.toThrow('user-identity-missing');
  await real.create();
  const fingerprint = (await real.load()).fingerprint;
  await expect(broken.create()).rejects.toThrow('user-identity-exists');
  expect((await real.load()).fingerprint).toBe(fingerprint);
});
async function fixture() {
  const pair = async () => {
    const keys = (await crypto.subtle.generateKey('Ed25519', false, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    return {
      privateKey: keys.privateKey,
      publicKey: toHex(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey))),
    };
  };
  const encryptionKey = async () => {
    const keys = (await crypto.subtle.generateKey('X25519', false, [
      'deriveBits',
    ])) as CryptoKeyPair;
    return toHex(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)));
  };
  const [device, identity] = await Promise.all([pair(), pair()]);
  const anchor = await deriveTeamAnchor({
    nonce: '01'.repeat(32),
    owner: {
      userId: 'owner',
      instance: 'owner-1',
      recoverySigningKey: identity.publicKey,
      recoveryEncryptionKey: await encryptionKey(),
      device: {
        id: 'desktop',
        kind: 'personal',
        canManage: true,
        signingKey: device.publicKey,
        encryptionKey: await encryptionKey(),
      },
    },
  });
  const key = randomBytes(32);
  const commitment = await commitEpochKey(anchor.genesis, key);
  const wire = await new WebCryptoControl().sign(
    {
      genesis: anchor.genesis,
      previous: anchor.genesis,
      operationId: '03'.repeat(16),
      actor: 'owner',
      memberInstance: 'owner-1',
      device: 'desktop',
      ...encodeTeamAction({ type: 'epoch.publish', configVersion: 0, epoch: 0, commitment }),
    },
    [{ id: 'actor-device', key: device.privateKey }]
  );
  const records: string[] = [];
  let attempts = 0;
  const stream: ControlStream = {
    initialOffset: '-1',
    async readAfter(offset) {
      const start = offset === '-1' ? 0 : Number(offset.slice('tail:'.length));
      return {
        records: records.slice(start),
        nextOffset: records.length ? `tail:${records.length}` : '-1',
        upToDate: true,
      };
    },
    async appendCas(offset, bytes) {
      attempts++;
      if (offset !== (records.length ? `tail:${records.length}` : '-1')) return 'conflict';
      records.push(bytes);
      return 'accepted';
    },
  };
  return {
    anchor,
    identity,
    key,
    commitment,
    wire,
    records,
    stream,
    attempts: () => attempts,
    author: {
      actor: 'owner',
      memberInstance: 'owner-1',
      device: 'desktop',
      signingKey: device.privateKey,
    },
    sign: (patch: Partial<ControlEvent>) =>
      new WebCryptoControl().sign({ ...decodeRecord(wire).event, ...patch }, [
        { id: 'actor-device', key: device.privateKey },
      ]),
  };
}
function payload(path: string): string {
  const db = new DatabaseSync(path);
  try {
    return String(db.prepare('SELECT payload FROM journal WHERE id=1').get()?.payload);
  } finally {
    db.close();
  }
}

it('device identity restores the same signing and encryption keys as non-extractable handles', async () => {
  const path = location(),
    p = protection(),
    binding = 'a1'.repeat(32);
  const store = new SqliteDeviceIdentityStore(path, binding, p.device);
  await expect(store.load()).rejects.toThrow('device-identity-missing');
  const identity = await store.create();
  const restored = await new SqliteDeviceIdentityStore(path, binding, p.device).load();
  expect(restored.id).toBe(identity.id);
  for (const kind of ['signing', 'encryption'] as const) {
    expect(await crypto.subtle.exportKey('raw', restored[kind].publicKey)).toEqual(
      await crypto.subtle.exportKey('raw', identity[kind].publicKey)
    );
    expect(restored[kind].privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('pkcs8', restored[kind].privateKey)).rejects.toThrow();
  }
  const message = new TextEncoder().encode('device possession fixture');
  const signature = await crypto.subtle.sign('Ed25519', restored.signing.privateKey, message);
  expect(
    await new WebCryptoControl().verify(
      toHex(new Uint8Array(await crypto.subtle.exportKey('raw', identity.signing.publicKey))),
      message,
      toHex(new Uint8Array(signature))
    )
  ).toBe(true);
  const other = (await crypto.subtle.generateKey('X25519', false, ['deriveBits'])) as CryptoKeyPair;
  expect(
    await crypto.subtle.deriveBits(
      { name: 'X25519', public: other.publicKey },
      restored.encryption.privateKey,
      256
    )
  ).toEqual(
    await crypto.subtle.deriveBits(
      { name: 'X25519', public: identity.encryption.publicKey },
      other.privateKey,
      256
    )
  );
  const before = payload(path);
  await expect(store.create()).rejects.toThrow('device-identity-exists');
  expect(payload(path)).toBe(before);
});

it('locked device storage and another account cannot regenerate or overwrite the identity', async () => {
  const path = location(),
    p = protection(),
    binding = 'a2'.repeat(32);
  const store = new SqliteDeviceIdentityStore(path, binding, p.device);
  const identity = await store.create();
  const before = payload(path);
  p.state.available = false;
  await expect(store.load()).rejects.toThrow('secure-key-storage-unavailable');
  await expect(store.create()).rejects.toThrow('device-identity-exists');
  p.state.available = true;
  await expect(
    new SqliteDeviceIdentityStore(path, 'b2'.repeat(32), p.device).load()
  ).rejects.toThrow('invalid-device-store');
  expect(payload(path)).toBe(before);
  expect((await store.load()).id).toBe(identity.id);
});

it('rejects an authenticated device bundle whose public and private keys disagree', async () => {
  const path = location(),
    p = protection(),
    binding = 'a3'.repeat(32);
  const store = new SqliteDeviceIdentityStore(path, binding, p.device);
  await store.create();
  const row = JSON.parse(payload(path)) as string[];
  const plaintext = p.device.open(binding, Buffer.from(row[2]!, 'hex'));
  const fields = JSON.parse(new TextDecoder().decode(plaintext)) as string[];
  fields[3] = '00'.repeat(32);
  row[2] = toHex(p.device.seal(binding, new TextEncoder().encode(JSON.stringify(fields))));
  plaintext.fill(0);
  const changed = JSON.stringify(row);
  const db = new DatabaseSync(path);
  db.prepare('UPDATE journal SET payload=? WHERE id=1').run(changed);
  db.close();
  await expect(store.load()).rejects.toThrow('device-key-pair-mismatch');
  expect(payload(path)).toBe(changed);
});

it('main device service returns public identity only and isolates accounts and auth domains', async () => {
  const directory = join(location(), '..', 'devices'),
    p = protection();
  let userId = 'alice';
  const options = {
    enabled: true,
    directory,
    authOrigin: 'https://auth.example.test',
    account: async () => ({ userId, assertCurrent() {} }),
    protection: p.device,
  };
  const service = new E2eeDeviceService(options);
  const alice = await service.create();
  expect(Object.keys(alice).sort()).toEqual([
    'deviceId',
    'encryptionPublicKey',
    'signingPublicKey',
  ]);
  expect(await new E2eeDeviceService(options).load()).toEqual(alice);
  userId = 'bob';
  await expect(service.load()).rejects.toThrow('device-identity-missing');
  const bob = await service.create();
  expect(bob.deviceId).not.toBe(alice.deviceId);
  userId = 'alice';
  expect(await service.load()).toEqual(alice);
  await expect(
    new E2eeDeviceService({ ...options, authOrigin: 'https://other.example.test' }).load()
  ).rejects.toThrow('device-identity-missing');
});

it('main device service withholds an in-flight result when the account lease expires', async () => {
  const directory = join(location(), '..', 'devices'),
    p = protection();
  let generation = 0;
  let expire = true;
  const options = {
    enabled: true,
    directory,
    authOrigin: 'https://auth.example.test',
    account: async () => {
      const captured = generation;
      return {
        userId: 'alice',
        assertCurrent() {
          if (captured !== generation) throw new Error('e2ee-account-changed');
        },
      };
    },
    protection: {
      ...p.device,
      seal(binding: string, plaintext: Uint8Array) {
        const wrapped = p.device.seal(binding, plaintext);
        if (expire) generation++;
        return wrapped;
      },
    },
  };
  await expect(new E2eeDeviceService(options).create()).rejects.toThrow('e2ee-account-changed');
  expire = false;
  const restored = await new E2eeDeviceService(options).load();
  expect(restored.deviceId).toHaveLength(32);
  await expect(new E2eeDeviceService(options).create()).rejects.toThrow('device-identity-exists');
});

it('login initialization reuses an identity and never replaces it when OS storage is unavailable', async () => {
  const p = protection();
  const options = {
    enabled: true,
    directory: join(location(), '..', 'devices'),
    authOrigin: 'https://auth.example.test',
    account: async () => ({ userId: 'alice', assertCurrent() {} }),
    protection: p.device,
  };
  const service = new E2eeDeviceService(options);
  const identity = await service.initialize();
  expect(await new E2eeDeviceService(options).initialize()).toEqual(identity);
  p.state.available = false;
  await expect(service.initialize()).rejects.toThrow('secure-key-storage-unavailable');
  p.state.available = true;
  expect(await service.initialize()).toEqual(identity);
});

it('concurrent windows initialize one identity without surfacing internal SQLite contention', async () => {
  const p = protection();
  let release!: () => void;
  const start = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = new E2eeDeviceService({
    enabled: true,
    directory: join(location(), '..', 'devices'),
    authOrigin: 'https://auth.example.test',
    account: async () => {
      await start;
      return { userId: 'alice', assertCurrent() {} };
    },
    protection: p.device,
  });
  const pending = Array.from({ length: 8 }, () => service.initialize());
  release();
  const results = await Promise.allSettled(pending);
  expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
  const identities = results.map((result) => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
  for (const identity of identities) expect(identity).toEqual(identities[0]);
  expect(await service.load()).toEqual(identities[0]);
});

it('local-mode device IPC service rejects before resolving a cloud account', async () => {
  const service = new E2eeDeviceService({
    enabled: false,
    directory: join(location(), '..', 'unused'),
    authOrigin: 'unused',
    account: async () => {
      throw new Error('cloud-auth-must-not-run');
    },
    protection: protection().device,
  });
  await expect(service.create()).rejects.toThrow('e2ee-device-unavailable');
  await expect(service.load()).rejects.toThrow('e2ee-device-unavailable');
  await expect(service.initialize()).rejects.toThrow('e2ee-device-unavailable');
});

it('returns no device identity when ciphertext persistence fails', async () => {
  const path = location(),
    p = protection(),
    binding = 'a4'.repeat(32);
  const store = new SqliteDeviceIdentityStore(path, binding, p.device);
  await expect(store.load()).rejects.toThrow('device-identity-missing');
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TRIGGER deny_device BEFORE INSERT ON journal BEGIN SELECT RAISE(ABORT, 'disk-denied'); END;"
  );
  db.close();
  await expect(store.create()).rejects.toThrow('disk-denied');
  await expect(store.load()).rejects.toThrow('device-identity-missing');
});

async function historyFixture() {
  const f = await fixture();
  const secret = randomBytes(32);
  const commitment = await commitEpochKey(f.anchor.genesis, secret);
  const operationId = '71'.repeat(16);
  const publication = await f.sign({
    previous: await new WebCryptoControl().hashRecord(f.wire),
    operationId,
    ...encodeTeamAction({ type: 'epoch.publish', configVersion: 0, epoch: 1, commitment }),
  });
  f.records.push(f.wire, publication);
  const log = new ControlLogClient(f.anchor, ownerManagedTeamPolicy, new MemoryStore(), f.stream);
  const snapshot = await log.read();
  const keys = new VerifiedEpochKeys(f.anchor.genesis, {
    commitment(epoch) {
      const value = snapshot.state.epochs.get(epoch);
      if (!value) throw new Error('unknown-epoch');
      return value;
    },
  });
  await keys.install(1, secret);
  const cipher = new ContentCipher({
    authorize(header) {
      const member = f.anchor.state.members.get(header.actor);
      const device = member?.devices.get(header.device);
      if (member?.instance !== header.memberInstance || !device) throw new Error('unknown-author');
      return device.signingKey;
    },
  });
  const seal = (previousKey = f.key) =>
    sealEpochHistory(cipher, {
      genesis: f.anchor.genesis,
      epoch: 1,
      epochKey: secret,
      previousKey,
      author: f.author,
      signingKey: f.author.signingKey,
    });
  const path = location();
  let remoteBytes: Uint8Array | null = null;
  const uploaded: string[] = [];
  const remote = {
    async put(_id: string, bytes: Uint8Array) {
      uploaded.push(toHex(bytes));
      remoteBytes = new Uint8Array(bytes);
    },
    async read() {
      return remoteBytes;
    },
  };
  const store = () => new SqliteHistoryPublicationStore(path, f.anchor.genesis);
  const publisher = () => new HistoryPublisher(log, keys, cipher, store(), remote);
  return {
    f,
    keys,
    cipher,
    log,
    seal,
    path,
    store,
    remote,
    uploaded,
    publisher,
    operationId,
    publication,
  };
}

it('history outbox survives response loss and restart with the exact ciphertext', async () => {
  const h = await historyFixture();
  const frame = await h.seal();
  const read = h.remote.read;
  h.remote.read = async () => {
    throw new Error('offline');
  };
  expect(await h.publisher().publish(h.operationId, frame)).toBe('unknown');
  const saved = payload(h.path);
  expect(saved).toContain(toHex(frame));
  expect(saved).not.toContain(toHex(h.f.key));
  h.remote.read = read;
  expect(await h.publisher().publish(h.operationId)).toBe('observed');
  expect(h.uploaded).toEqual([toHex(frame), toHex(frame)]);
  expect(payload(h.path)).toBe(saved);
  await h.keys.importHistory(h.cipher, 1, (await h.remote.read())!);
  expect(h.keys.read(0)).toEqual(new Uint8Array(h.f.key));
  expect(h.f.attempts()).toBe(0);
});

it('history publication requires committed evidence and never submits the candidate', async () => {
  const h = await historyFixture();
  // Fresh reader has not observed the second publication at all.
  h.f.records.pop();
  const log = new ControlLogClient(
    h.f.anchor,
    ownerManagedTeamPolicy,
    new MemoryStore(),
    h.f.stream
  );
  const publisher = new HistoryPublisher(log, h.keys, h.cipher, h.store(), h.remote);
  await expect(publisher.publish(h.operationId, await h.seal())).rejects.toThrow(
    'epoch-publication-not-observed'
  );
  expect(h.uploaded).toEqual([]);
  expect(h.f.attempts()).toBe(0);
  expect(await h.store().exclusive((tx) => tx.load(h.operationId))).toBeNull();
});

it('rejects wrong old keys and corrupted signatures before saving or uploading a bridge', async () => {
  const h = await historyFixture();
  await expect(h.publisher().publish(h.operationId, await h.seal(randomBytes(32)))).rejects.toThrow(
    'epoch-key-mismatch'
  );
  const broken = await h.seal();
  broken[broken.length - 1]! ^= 1;
  await expect(h.publisher().publish(h.operationId, broken)).rejects.toThrow();
  expect(h.uploaded).toEqual([]);
  expect(await h.store().exclusive((tx) => tx.load(h.operationId))).toBeNull();
});

it('retains the original ciphertext when a retry supplies a newly sealed bridge', async () => {
  const h = await historyFixture();
  const frame = await h.seal();
  expect(await h.publisher().publish(h.operationId, frame)).toBe('observed');
  const before = payload(h.path);
  await expect(h.publisher().publish(h.operationId, await h.seal())).rejects.toThrow(
    'history-frame-conflict'
  );
  expect(payload(h.path)).toBe(before);
  expect(h.uploaded).toEqual([toHex(frame)]);
});

it('requires exact read-back even after acknowledgement and reconciles a lost write response', async () => {
  const h = await historyFixture();
  const frame = await h.seal();
  const put = h.remote.put;
  const read = h.remote.read;
  h.remote.put = async (id, bytes) => {
    await put(id, bytes);
    throw new Error('response-lost');
  };
  expect(await h.publisher().publish(h.operationId, frame)).toBe('observed');
  h.remote.read = async () => null;
  expect(await h.publisher().publish(h.operationId)).toBe('unknown');
  h.remote.read = async () => new Uint8Array([1]);
  await expect(h.publisher().publish(h.operationId)).rejects.toThrow('history-remote-mismatch');
  h.remote.read = read;
  expect(await h.publisher().publish(h.operationId)).toBe('observed');
  expect(h.uploaded.every((bytes) => bytes === toHex(frame))).toBe(true);
});

it('clearing local keys during persistence stops upload without deleting the saved ciphertext', async () => {
  const h = await historyFixture();
  const store = h.store();
  const publisher = new HistoryPublisher(
    h.log,
    h.keys,
    h.cipher,
    {
      exclusive: (work) =>
        store.exclusive((tx) =>
          work({
            load: (id) => tx.load(id),
            save: async (entry) => {
              await tx.save(entry);
              h.keys.clear();
            },
          })
        ),
    },
    h.remote
  );
  const frame = await h.seal();
  await expect(publisher.publish(h.operationId, frame)).rejects.toThrow('missing-content-key');
  expect(h.uploaded).toEqual([]);
  expect(await store.exclusive((tx) => tx.load(h.operationId))).toEqual({
    publication: h.publication,
    frameHex: toHex(frame),
  });
});

it('SQLite rejection prevents upload and a foreign journal is preserved', async () => {
  const h = await historyFixture();
  await h.store().exclusive(async () => {});
  const db = new DatabaseSync(h.path);
  db.exec(
    "CREATE TRIGGER deny_history BEFORE INSERT ON journal BEGIN SELECT RAISE(ABORT, 'disk-denied'); END;"
  );
  db.close();
  await expect(h.publisher().publish(h.operationId, await h.seal())).rejects.toThrow('disk-denied');
  expect(h.uploaded).toEqual([]);
  const before = readFileSync(h.path);
  await expect(new SqliteControlStore(h.path).exclusive(async () => {})).rejects.toThrow(
    'unsupported-journal-database'
  );
  expect(readFileSync(h.path)).toEqual(before);
});

it('persists key and exact pending bytes before CAS; restart after lost response restores verified key', async () => {
  const f = await fixture();
  const path = location();
  const p = protection();
  const store = new SqliteEpochControlStore(path, p.value);
  const prepared = await store.withCandidate(f.wire, f.key);
  let failRead = false;
  const stream: ControlStream = {
    ...f.stream,
    async appendCas(offset, wire) {
      await f.stream.appendCas(offset, wire);
      failRead = true;
      throw Error('lost response');
    },
    async readAfter(offset) {
      if (failRead) throw Error('offline');
      return f.stream.readAfter(offset);
    },
  };
  const client = new ControlLogClient(f.anchor, ownerManagedTeamPolicy, prepared, stream);
  await expect(client.submit(f.wire)).rejects.toThrow('offline');
  const saved = JSON.parse(payload(path));
  expect(JSON.parse(saved[1])[3]).toBe(f.wire);
  expect(saved[2]).toHaveLength(1);
  expect(saved[2][0][0]).toBe(f.wire);
  expect(payload(path)).not.toContain(f.key.toString('hex'));
  const reopened = new SqliteEpochControlStore(path, p.value);
  const resumed = await new ControlLogClient(
    f.anchor,
    ownerManagedTeamPolicy,
    reopened,
    f.stream
  ).resume();
  expect(resumed.status).toBe('committed');
  expect(f.attempts()).toBe(1);
  expect(JSON.parse(JSON.parse(payload(path))[1])[3]).toBeNull();
  const keys = new VerifiedEpochKeys(f.anchor.genesis, {
    commitment: (n) => {
      const c = resumed.snapshot.state.epochs.get(n);
      if (!c) throw Error('not published');
      return c;
    },
  });
  await reopened.restore(f.wire, keys);
  expect(keys.read(0)).toEqual(new Uint8Array(f.key));
});

it('an already observed exact publication also durably retains the supplied key', async () => {
  const f = await fixture();
  f.records.push(f.wire);
  const store = new SqliteEpochControlStore(location(), protection().value);
  const candidate = await store.withCandidate(f.wire, f.key);
  const result = await new ControlLogClient(
    f.anchor,
    ownerManagedTeamPolicy,
    candidate,
    f.stream
  ).submit(f.wire);
  expect(result.status).toBe('committed');
  expect(f.attempts()).toBe(0);
  const keys = new VerifiedEpochKeys(f.anchor.genesis, { commitment: () => f.commitment });
  await store.restore(f.wire, keys);
  expect(keys.read(0)).toEqual(new Uint8Array(f.key));
});

it('missing candidate and SQLite rejection prevent network publication without partial saved state', async () => {
  const f = await fixture();
  const path = location();
  const store = new SqliteEpochControlStore(path, protection().value);
  const client = new ControlLogClient(f.anchor, ownerManagedTeamPolicy, store, f.stream);
  await expect(client.submit(f.wire)).rejects.toThrow('missing-epoch-candidate');
  expect(f.records).toEqual([]);
  const prepared = await store.withCandidate(f.wire, f.key);
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TRIGGER reject_write BEFORE INSERT ON journal BEGIN SELECT RAISE(ABORT,'disk rejected'); END;"
  );
  db.close();
  await expect(
    new ControlLogClient(f.anchor, ownerManagedTeamPolicy, prepared, f.stream).submit(f.wire)
  ).rejects.toThrow('disk rejected');
  expect(f.attempts()).toBe(0);
  expect(await store.exclusive((tx) => tx.load())).toBeNull();
  expect(payload(path)).toBe('undefined');
});

it('unknown submission retains candidate; unavailable OS protection prevents a retry', async () => {
  const f = await fixture();
  const path = location();
  const p = protection();
  const store = new SqliteEpochControlStore(path, p.value);
  const prepared = await store.withCandidate(f.wire, f.key);
  const uncertain = {
    ...f.stream,
    async appendCas() {
      throw Error('connection lost');
    },
  };
  expect(
    (
      await new ControlLogClient(f.anchor, ownerManagedTeamPolicy, prepared, uncertain).submit(
        f.wire
      )
    ).status
  ).toBe('unknown');
  const before = payload(path);
  p.state.available = false;
  await expect(
    new ControlLogClient(f.anchor, ownerManagedTeamPolicy, store, f.stream).resume()
  ).rejects.toThrow('secure-key-storage-unavailable');
  expect(f.attempts()).toBe(0);
  expect(payload(path)).toBe(before);
  p.state.available = true;
  expect(
    (await new ControlLogClient(f.anchor, ownerManagedTeamPolicy, store, f.stream).resume()).status
  ).toBe('committed');
});

it('saved keys do not restore revoked or unpublished authority', async () => {
  const f = await fixture();
  const store = new SqliteEpochControlStore(location(), protection().value);
  const prepared = await store.withCandidate(f.wire, f.key);
  await new ControlLogClient(f.anchor, ownerManagedTeamPolicy, prepared, f.stream).submit(f.wire);
  const revoked = new VerifiedEpochKeys(f.anchor.genesis, {
    commitment() {
      throw Error('revoked');
    },
  });
  await expect(store.restore(f.wire, revoked)).rejects.toThrow('revoked');
  const different = new VerifiedEpochKeys(f.anchor.genesis, { commitment: () => 'ff'.repeat(32) });
  await expect(store.restore(f.wire, different)).rejects.toThrow('epoch-key-mismatch');
  await expect(store.withCandidate(f.wire, randomBytes(32))).rejects.toThrow('epoch-key-mismatch');
});

it('ordinary and protected SQLite formats reject each other without rewriting the existing database', async () => {
  const path = location();
  const p = protection();
  const original = new SqliteControlStore(path);
  await original.exclusive(async () => {});
  const before = readFileSync(path);
  await expect(
    new SqliteEpochControlStore(path, p.value).exclusive((tx) => tx.load())
  ).rejects.toThrow('unsupported-journal-database');
  expect(readFileSync(path)).toEqual(before);
  const protectedPath = location();
  await new SqliteEpochControlStore(protectedPath, p.value).exclusive(async () => {});
  const protectedBefore = readFileSync(protectedPath);
  await expect(new SqliteControlStore(protectedPath).exclusive((tx) => tx.load())).rejects.toThrow(
    'unsupported-journal-database'
  );
  expect(readFileSync(protectedPath)).toEqual(protectedBefore);
});

it('a competing publication clears pending, cannot install the losing key or reuse it on another head', async () => {
  const f = await fixture();
  const store = new SqliteEpochControlStore(location(), protection().value);
  const candidate = await store.withCandidate(f.wire, f.key);
  const uncertain = {
    ...f.stream,
    async appendCas() {
      throw Error('response unknown');
    },
  };
  await new ControlLogClient(f.anchor, ownerManagedTeamPolicy, candidate, uncertain).submit(f.wire);
  const winnerCommitment = await commitEpochKey(f.anchor.genesis, randomBytes(32));
  const winner = await f.sign({
    operationId: '04'.repeat(16),
    ...encodeTeamAction({
      type: 'epoch.publish',
      configVersion: 0,
      epoch: 0,
      commitment: winnerCommitment,
    }),
  });
  f.records.push(winner);
  const result = await new ControlLogClient(
    f.anchor,
    ownerManagedTeamPolicy,
    store,
    f.stream
  ).resume();
  expect(result.status).toBe('conflict');
  expect((await store.exclusive((tx) => tx.load()))?.pending).toBeNull();
  const keys = new VerifiedEpochKeys(f.anchor.genesis, { commitment: () => winnerCommitment });
  await expect(store.restore(f.wire, keys)).rejects.toThrow('epoch-key-mismatch');
  const reused = await f.sign({
    previous: result.snapshot.head,
    operationId: '05'.repeat(16),
    ...encodeTeamAction({
      type: 'epoch.publish',
      configVersion: 0,
      epoch: 1,
      commitment: f.commitment,
    }),
  });
  const cipher = new ContentCipher({
    authorize: () => f.anchor.state.members.get('owner')!.devices.get('desktop')!.signingKey,
  });
  const bridge = await sealEpochHistory(cipher, {
    genesis: f.anchor.genesis,
    epoch: 1,
    epochKey: f.key,
    previousKey: randomBytes(32),
    author: f.author,
    signingKey: f.author.signingKey,
  });
  const reusedStore = await store.withCandidate(reused, f.key, bridge);
  await expect(
    new ControlLogClient(f.anchor, ownerManagedTeamPolicy, reusedStore, f.stream).submit(reused)
  ).rejects.toThrow('epoch-candidate-reused');
  expect(f.attempts()).toBe(0);
  expect(f.records).toEqual([winner]);
});

it('process death rolls back an interrupted SQLite replacement without losing pending or its encrypted key', async () => {
  const f = await fixture();
  const path = location();
  const p = protection();
  const store = new SqliteEpochControlStore(path, p.value);
  const candidate = await store.withCandidate(f.wire, f.key);
  const uncertain = {
    ...f.stream,
    async appendCas() {
      throw Error('offline');
    },
  };
  await new ControlLogClient(f.anchor, ownerManagedTeamPolicy, candidate, uncertain).submit(f.wire);
  const before = payload(path);
  const child: ChildProcess = fork(new URL('./node-store-child.ts', import.meta.url), [path], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const failed = new Promise<never>((_, reject) =>
    child.once('exit', (code, signal) =>
      reject(Error(`fixture exited: ${code}/${signal}: ${stderr}`))
    )
  );
  try {
    expect(await Promise.race([once(child, 'message'), failed])).toEqual(['ready', undefined]);
    const locked = once(child, 'message');
    child.send({ mode: 'uncommitted', genesis: f.anchor.genesis, pending: f.wire });
    expect(await Promise.race([locked, failed])).toEqual(['locked', undefined]);
    await expect(store.exclusive((tx) => tx.load())).rejects.toThrow('journal-busy');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit');
      child.kill('SIGKILL');
      await exit;
    }
  }
  expect(payload(path)).toBe(before);
  const reopened = new SqliteEpochControlStore(path, p.value);
  const result = await new ControlLogClient(
    f.anchor,
    ownerManagedTeamPolicy,
    reopened,
    f.stream
  ).resume();
  expect(result.status).toBe('committed');
  const keys = new VerifiedEpochKeys(f.anchor.genesis, { commitment: () => f.commitment });
  await reopened.restore(f.wire, keys);
  expect(keys.read(0)).toEqual(new Uint8Array(f.key));
});

it('publisher owns key generation and persists distinct consecutive epochs; repeated intent never rotates twice', async () => {
  const f = await fixture();
  const path = location();
  const p = protection();
  const store = new SqliteEpochControlStore(path, p.value);
  const firstIntent = { operationId: '10'.repeat(16), previous: f.anchor.genesis };
  const publisher = new EpochPublisher(f.anchor, store, f.stream);
  const first = await publisher.publish(firstIntent, f.author);
  expect(first.status).toBe('committed');
  expect(first.epoch).toBe(0);
  const previousKeys = new VerifiedEpochKeys(f.anchor.genesis, {
    commitment: (epoch) => first.snapshot.state.epochs.get(epoch) ?? '',
  });
  await store.restore(first.wire, previousKeys);
  const restarted = new EpochPublisher(
    f.anchor,
    new SqliteEpochControlStore(path, p.value),
    f.stream,
    previousKeys
  );
  const repeated = await restarted.publish(firstIntent, f.author);
  expect(repeated.wire).toBe(first.wire);
  expect(f.records).toEqual([first.wire]);
  const second = await restarted.publish(
    { operationId: '11'.repeat(16), previous: first.snapshot.head },
    f.author
  );
  expect(second.status).toBe('committed');
  expect(second.epoch).toBe(1);
  expect(second.snapshot.state.epochs.get(0)).not.toBe(second.snapshot.state.epochs.get(1));
  const keys = new VerifiedEpochKeys(f.anchor.genesis, {
    commitment: (n) => {
      const value = second.snapshot.state.epochs.get(n);
      if (!value) throw Error('not published');
      return value;
    },
  });
  await store.restore(first.wire, keys);
  await store.restore(second.wire, keys);
  expect(await commitEpochKey(f.anchor.genesis, keys.read(0))).toBe(
    second.snapshot.state.epochs.get(0)
  );
  expect(await commitEpochKey(f.anchor.genesis, keys.read(1))).toBe(
    second.snapshot.state.epochs.get(1)
  );
  expect(f.attempts()).toBe(2);
  expect((await restarted.publish(firstIntent, f.author)).wire).toBe(first.wire);
  expect(f.attempts()).toBe(2);
  expect(await store.readHistory(first.wire)).toBeNull();
  const bridge = await new SqliteEpochControlStore(path, p.value).readHistory(second.wire);
  expect(bridge).not.toBeNull();
  const recipient = new VerifiedEpochKeys(f.anchor.genesis, {
    commitment: (epoch) => second.snapshot.state.epochs.get(epoch) ?? '',
  });
  await store.restore(second.wire, recipient);
  const cipher = new ContentCipher({
    authorize: () => f.anchor.state.members.get('owner')!.devices.get('desktop')!.signingKey,
  });
  await recipient.importHistory(cipher, 1, bridge!);
  expect(recipient.read(0)).toEqual(previousKeys.read(0));
  let uploaded: Uint8Array | null = null;
  const historyPublisher = new HistoryPublisher(
    new ControlLogClient(f.anchor, ownerManagedTeamPolicy, store, f.stream),
    recipient,
    cipher,
    new SqliteHistoryPublicationStore(location(), f.anchor.genesis),
    {
      async put(_id, frame) {
        uploaded = new Uint8Array(frame);
      },
      async read() {
        return uploaded;
      },
    }
  );
  expect(await historyPublisher.publish(decodeRecord(second.wire).event.operationId, bridge!)).toBe(
    'observed'
  );
  expect(uploaded).toEqual(bridge);
});

it('rotation rejects missing previous keys and restart retains the bridge saved before CAS', async () => {
  const f = await fixture();
  const path = location();
  const p = protection();
  const store = new SqliteEpochControlStore(path, p.value);
  const first = await new EpochPublisher(f.anchor, store, f.stream).publish(
    { operationId: '41'.repeat(16), previous: f.anchor.genesis },
    f.author
  );
  const intent = { operationId: '42'.repeat(16), previous: first.snapshot.head };
  await expect(
    new EpochPublisher(f.anchor, store, f.stream).publish(intent, f.author)
  ).rejects.toThrow('previous-epoch-key-required');
  expect(f.records).toEqual([first.wire]);
  const keys = new VerifiedEpochKeys(f.anchor.genesis, {
    commitment: (epoch) => first.snapshot.state.epochs.get(epoch) ?? '',
  });
  await store.restore(first.wire, keys);
  let beforeCas: string | null = null;
  const uncertain: ControlStream = {
    ...f.stream,
    async appendCas() {
      // Read with the same SQLite connection via a second process is prohibited
      // while the journal lock is held; the durable result is inspected after return.
      beforeCas = 'entered';
      throw new Error('offline');
    },
  };
  const result = await new EpochPublisher(f.anchor, store, uncertain, keys).publish(
    intent,
    f.author
  );
  expect(result.status).toBe('unknown');
  expect(beforeCas).toBe('entered');
  const saved = payload(path);
  const bridge = await store.readHistory(result.wire);
  expect(bridge).not.toBeNull();
  expect(saved).toContain(toHex(bridge!));
  const restarted = new SqliteEpochControlStore(path, p.value);
  const resumed = await new EpochPublisher(f.anchor, restarted, f.stream).resume();
  expect(resumed.status).toBe('committed');
  expect(resumed.wire).toBe(result.wire);
  expect(await restarted.readHistory(result.wire)).toEqual(bridge);
  expect(f.records).toEqual([first.wire, result.wire]);
});

it('rejects old candidate database versions unchanged instead of losing missing bridge data', async () => {
  const path = location();
  const db = new DatabaseSync(path);
  db.exec(
    'PRAGMA application_id=1279609649; PRAGMA user_version=1; CREATE TABLE journal(id INTEGER PRIMARY KEY, payload TEXT);'
  );
  db.prepare('INSERT INTO journal VALUES(1, ?)').run('["lody-epoch-journal/v1","retained",[]]');
  db.close();
  const before = readFileSync(path);
  await expect(
    new SqliteEpochControlStore(path, protection().value).exclusive(async () => {})
  ).rejects.toThrow('unsupported-journal-database');
  expect(readFileSync(path)).toEqual(before);
});

it('publisher resumes an uncertain attempt without signing or generating another key', async () => {
  const f = await fixture();
  const path = location();
  const p = protection();
  const store = new SqliteEpochControlStore(path, p.value);
  const unknown = {
    ...f.stream,
    async appendCas() {
      throw Error('offline');
    },
  };
  const intent = { operationId: '12'.repeat(16), previous: f.anchor.genesis };
  const first = await new EpochPublisher(f.anchor, store, unknown).publish(intent, f.author);
  expect(first.status).toBe('unknown');
  const saved = payload(path);
  await expect(
    new EpochPublisher(f.anchor, store, f.stream).publish(
      { ...intent, operationId: '13'.repeat(16) },
      f.author
    )
  ).rejects.toThrow('pending-attempt-exists');
  expect(payload(path)).toBe(saved);
  const restarted = new EpochPublisher(
    f.anchor,
    new SqliteEpochControlStore(path, p.value),
    f.stream
  );
  const result = await restarted.resume();
  expect(result.status).toBe('committed');
  expect(result.wire).toBe(first.wire);
  expect(f.records).toEqual([first.wire]);
  await expect(restarted.resume()).rejects.toThrow('no-pending-attempt');
});

it('unsupported attempts retain their candidate for an identical later retry, not a new signed publication', async () => {
  const f = await fixture();
  const store = new SqliteEpochControlStore(location(), protection().value);
  const unsupported: ControlStream = {
    ...f.stream,
    async appendCas() {
      return 'unsupported';
    },
  };
  const intent = { operationId: '14'.repeat(16), previous: f.anchor.genesis };
  const first = await new EpochPublisher(f.anchor, store, unsupported).publish(intent, f.author);
  expect(first.status).toBe('unsupported');
  expect((await store.exclusive((tx) => tx.load()))?.pending).toBeNull();
  const retried = await new EpochPublisher(f.anchor, store, f.stream).publish(intent, f.author);
  expect(retried.wire).toBe(first.wire);
  expect(f.records).toEqual([first.wire]);
  await expect(
    new EpochPublisher(f.anchor, store, f.stream).publish(
      { ...intent, previous: retried.snapshot.head },
      f.author
    )
  ).rejects.toThrow('publication-intent-mismatch');
});

it('the protected journal refuses another key under an already saved operation ID', async () => {
  const f = await fixture();
  const path = location();
  const store = new SqliteEpochControlStore(path, protection().value);
  const unsupported: ControlStream = {
    ...f.stream,
    async appendCas() {
      return 'unsupported';
    },
  };
  const first = await store.withCandidate(f.wire, f.key);
  await new ControlLogClient(f.anchor, ownerManagedTeamPolicy, first, unsupported).submit(f.wire);
  const before = payload(path);
  const replacementKey = randomBytes(32);
  const replacement = await f.sign(
    encodeTeamAction({
      type: 'epoch.publish',
      configVersion: 0,
      epoch: 0,
      commitment: await commitEpochKey(f.anchor.genesis, replacementKey),
    })
  );
  const second = await store.withCandidate(replacement, replacementKey);
  await expect(
    new ControlLogClient(f.anchor, ownerManagedTeamPolicy, second, f.stream).submit(replacement)
  ).rejects.toThrow('epoch-operation-reused');
  expect(payload(path)).toBe(before);
  expect(await store.findCandidate(decodeRecord(f.wire).event.operationId)).toBe(f.wire);
  expect(f.attempts()).toBe(0);
});

it('publishes and restores an Admin epoch without the new Owner signing after transfer', async () => {
  const f = await fixture();
  const successor = await fixture();
  const next = successor.anchor.state.members.get('owner')!;
  const device = { ...next.devices.get('desktop')!, id: 'successor-desktop' };
  const log = new ControlLogClient(f.anchor, ownerManagedTeamPolicy, new MemoryStore(), f.stream);
  const signing = new WebCryptoControl();
  const admission = await signing.sign(
    {
      ...decodeRecord(f.wire).event,
      operationId: 'a1'.repeat(16),
      ...encodeTeamAction({
        type: 'member.add',
        configVersion: 0,
        member: {
          userId: 'successor',
          instance: 'successor-1',
          recoverySigningKey: next.recoverySigningKey,
          recoveryEncryptionKey: next.recoveryEncryptionKey,
          device,
        },
      }),
    },
    [
      { id: 'actor-device', key: f.author.signingKey },
      { id: 'joining-identity', key: successor.identity.privateKey },
      { id: 'new-device', key: successor.author.signingKey },
    ]
  );
  expect((await log.submit(admission)).status).toBe('committed');
  const transfer = await signing.sign(
    {
      ...decodeRecord(f.wire).event,
      previous: (await log.read()).head,
      operationId: 'a2'.repeat(16),
      ...encodeTeamAction({
        type: 'owner.transfer',
        configVersion: 0,
        userId: 'successor',
        instance: 'successor-1',
        acceptingDevice: device.id,
      }),
    },
    [
      { id: 'actor-device', key: f.author.signingKey },
      { id: 'accepting-device', key: successor.author.signingKey },
    ]
  );
  expect((await log.submit(transfer)).status).toBe('committed');
  const snapshot = await log.read();
  expect(snapshot.state.members.get('owner')!.role).toBe('admin');
  const path = location();
  const wrapped = protection().value;
  const store = new SqliteEpochControlStore(path, wrapped);
  const publication = await new EpochPublisher(f.anchor, store, f.stream).publish(
    {
      operationId: 'a3'.repeat(16),
      previous: snapshot.head,
    },
    f.author
  );
  expect(publication.status).toBe('committed');
  expect(decodeRecord(publication.wire).signatures.map(([id]) => id)).toEqual(['actor-device']);
  expect(publication.snapshot.state.owner.userId).toBe('successor');
  const keys = new VerifiedEpochKeys(f.anchor.genesis, {
    commitment: (epoch) => publication.snapshot.state.epochs.get(epoch)!,
  });
  await new SqliteEpochControlStore(path, wrapped).restore(publication.wire, keys);
  expect(await commitEpochKey(f.anchor.genesis, keys.read(0))).toBe(
    publication.snapshot.state.epochs.get(0)
  );
  keys.clear();
});

it('an epoch publisher does not publish from an unknown actor, wrong private key, or stale requested head', async () => {
  const f = await fixture();
  const store = new SqliteEpochControlStore(location(), protection().value);
  const publisher = new EpochPublisher(f.anchor, store, f.stream);
  const intent = { operationId: '15'.repeat(16), previous: f.anchor.genesis };
  await expect(publisher.publish(intent, { ...f.author, actor: 'other' })).rejects.toThrow(
    'rotator-required'
  );
  const badKey = (await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  await expect(
    publisher.publish(intent, { ...f.author, signingKey: badKey.privateKey })
  ).rejects.toThrow('bad-signature');
  expect(await store.findCandidate(intent.operationId)).toBeNull();
  f.records.push(f.wire);
  await expect(publisher.publish(intent, f.author)).rejects.toThrow('stale-publication-head');
  expect(f.attempts()).toBe(0);
  expect(f.records).toEqual([f.wire]);
});

it('a competing commit while preparing a key returns conflict and does not move the intent to the new head', async () => {
  const f = await fixture();
  const store = new SqliteEpochControlStore(location(), protection().value);
  const intent = { operationId: '16'.repeat(16), previous: f.anchor.genesis };
  let temporary: Uint8Array | undefined;
  const raceStore: EpochPublicationStore = {
    exclusive: (work) => store.exclusive(work),
    findCandidate: (id) => store.findCandidate(id),
    async withCandidate(wire, secret) {
      temporary = secret;
      const prepared = await store.withCandidate(wire, secret);
      f.records.push(f.wire);
      intent.operationId = '17'.repeat(16); // Caller mutation must not change the captured intent.
      return prepared;
    },
  };
  const result = await new EpochPublisher(f.anchor, raceStore, f.stream).publish(intent, f.author);
  expect(result.status).toBe('conflict');
  expect(decodeRecord(result.wire).event.operationId).toBe('16'.repeat(16));
  expect(decodeRecord(result.wire).event.previous).toBe(f.anchor.genesis);
  expect(f.records).toEqual([f.wire]);
  expect(f.attempts()).toBe(0);
  expect(temporary).toEqual(new Uint8Array(32));
});

it('two prepared publications at the same head produce one epoch, never an implicit next epoch', async () => {
  const f = await fixture();
  const ready = deferred<void>();
  let count = 0;
  const makeStore = (): EpochPublicationStore => {
    const store = new SqliteEpochControlStore(location(), protection().value);
    return {
      exclusive: (work) => store.exclusive(work),
      findCandidate: (id) => store.findCandidate(id),
      async withCandidate(wire, key) {
        const prepared = await store.withCandidate(wire, key);
        count++;
        if (count === 2) ready.resolve();
        await ready.promise;
        return prepared;
      },
    };
  };
  const a = new EpochPublisher(f.anchor, makeStore(), f.stream);
  const b = new EpochPublisher(f.anchor, makeStore(), f.stream);
  const results = await Promise.all([
    a.publish({ previous: f.anchor.genesis, operationId: '18'.repeat(16) }, f.author),
    b.publish({ previous: f.anchor.genesis, operationId: '19'.repeat(16) }, f.author),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual(['committed', 'conflict']);
  expect(f.records).toHaveLength(1);
  expect(results.every((r) => r.epoch === 0 && r.snapshot.state.epochs.size === 1)).toBe(true);
});

it('failure of the random source leaves no pending publication or fallback key', async () => {
  const f = await fixture();
  const store = new SqliteEpochControlStore(location(), protection().value);
  const publisher = new EpochPublisher(f.anchor, store, f.stream);
  const intent = { previous: f.anchor.genesis, operationId: '20'.repeat(16) };
  vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementationOnce(() => {
    throw Error('random source unavailable');
  });
  await expect(publisher.publish(intent, f.author)).rejects.toThrow('random source unavailable');
  expect(f.records).toEqual([]);
  expect(await store.findCandidate(intent.operationId)).toBeNull();
  expect(await store.exclusive((tx) => tx.load())).toBeNull();
});
