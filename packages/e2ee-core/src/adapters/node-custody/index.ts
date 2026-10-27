import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { Data, Effect, Layer, Result } from 'effect';
import { Bytes, ContentError } from '../../protocol/index';
import {
  CandidateProtector,
  DeviceIdentity,
  KeyProtector,
  type DeviceSigner,
} from '../../services/index';

/** Promise-based protection calls, wrapped into ports by `KeyProtector.fromPromises`. */
type NativeEpochProtector = Parameters<typeof KeyProtector.fromPromises>[0];

/** Host-owned KEK protection. The host validates its real backend before supplying this capability. */
export interface KekWrapper {
  readonly protection: 'os-keystore' | 'file';
  wrap(value: string): Promise<Uint8Array>;
  unwrap(value: Uint8Array): Promise<{ result: string; shouldReEncrypt: boolean }>;
}
/** Stable custody failures; native errors and private material are never included. */
export class NodeE2eeCustodyError extends Data.TaggedError('NodeE2eeCustodyError')<{
  readonly code:
    | 'unavailable'
    | 'basic-text'
    | 'closed'
    | 'storage'
    | 'corrupt'
    | 'invalid-input'
    | 'rewrap-failed';
}> {}
const fail = (code: NodeE2eeCustodyError['code']) => new NodeE2eeCustodyError({ code });
const domain = Buffer.from('lody-e2ee/desktop-custody/v1\0');
const installedPurpose = Buffer.from('lody-e2ee/local-epoch-key/v1\0');
const candidatePurpose = Buffer.from('lody-e2ee/local-epoch-candidate/v1\0');
const devicePurpose = Buffer.from('lody-e2ee/local-device/v1\0');
const credentialPurpose = Buffer.from('lody-e2ee/local-device-credential/v1\0');
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && timingSafeEqual(a, b);
const bytes = (value: Uint8Array, limit: number) => {
  if (!(value instanceof Uint8Array) || value.length < 1 || value.length > limit)
    throw fail('invalid-input');
  return new Uint8Array(value);
};
function native<A>(work: () => Promise<A>) {
  return Effect.uninterruptible(
    Effect.tryPromise({
      try: work,
      catch: (cause) => (cause instanceof NodeE2eeCustodyError ? cause : fail('storage')),
    })
  );
}
function context(body: Uint8Array, kind: 'installed' | 'candidate') {
  const prefix = kind === 'installed' ? installedPurpose : candidatePurpose;
  const minimum = kind === 'installed' ? prefix.length + 32 * 3 + 4 : prefix.length + 32 * 6 + 12;
  if (!equal(body.subarray(0, prefix.length), prefix) || body.length < minimum + 32)
    throw fail('invalid-input');
  if (kind === 'installed' && body.length !== minimum + 32) throw fail('invalid-input');
  if (kind === 'candidate') {
    const size = new DataView(body.buffer, body.byteOffset, body.length).getUint32(minimum - 4);
    if (size < 1 || size > 8192 || body.length !== minimum + size + 32) throw fail('invalid-input');
  }
  // All public binding fields, including the original signed candidate record,
  // are AAD and are also within the fully encrypted authenticated plaintext.
  return body.slice(0, -32);
}
async function readOwned(path: string, maximum: number) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.size < 1 ||
      info.size > maximum ||
      (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
    )
      throw fail('corrupt');
    return new Uint8Array(await handle.readFile());
  } finally {
    await handle.close();
  }
}
/** Same-directory atomic publish, retaining the first complete original. */
async function publish(path: string, value: Uint8Array) {
  const temporary = `${path}.${randomBytes(16).toString('hex')}.pending`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(value);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, path);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
      return false;
    }
    return true;
  } finally {
    await handle?.close();
    await unlink(temporary).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code !== 'ENOENT') throw cause;
    });
  }
}
const remove = (file: string) =>
  unlink(file).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code !== 'ENOENT') throw cause;
  });
const kekDigest = (plaintext: string) => {
  const key = Buffer.from(plaintext, 'hex');
  try {
    return createHash('sha256').update(key).digest('hex');
  } finally {
    key.fill(0);
  }
};
const wrapper = (value: unknown): Uint8Array => {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{2}){1,8192}$/.test(value))
    throw fail('rewrap-failed');
  return new Uint8Array(Buffer.from(value, 'hex'));
};
/** SQLite's OS lock dies with its process; the persistent file is not a lease. */
async function lockInitialization(path: string) {
  const lockPath = `${path}.rewrap-lock`;
  try {
    const handle = await open(lockPath, 'wx', 0o600);
    await handle.close();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
  }
  const info = await lstat(lockPath);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
  )
    throw fail('rewrap-failed');
  const mutex = new DatabaseSync(lockPath);
  try {
    // No busy retry or time-based takeover, including another owner in this process.
    mutex.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE');
    return mutex;
  } catch {
    mutex.close();
    throw fail('rewrap-failed');
  }
}
async function replaceWrapped(path: string, value: Uint8Array) {
  const pending = `${path}.rewrap-pending`;
  await remove(pending);
  const handle = await open(pending, 'wx', 0o600);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(pending, path);
}
/** Only encrypted wrappers and a one-way random-KEK digest enter the journal. */
async function recoverRewrap(path: string, unwrap: KekWrapper['unwrap']) {
  const journalPath = `${path}.rewrap-journal`;
  let journal: Uint8Array;
  try {
    journal = await readOwned(journalPath, 34000);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw fail('rewrap-failed');
    await remove(`${path}.rewrap-pending`);
    await remove(`${journalPath}.rewrap-pending`);
    return;
  }
  const value: unknown = JSON.parse(Buffer.from(journal).toString('utf8'));
  if (
    typeof value !== 'object' ||
    value === null ||
    !('original' in value) ||
    !('replacement' in value) ||
    !('digest' in value) ||
    typeof value.digest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.digest)
  )
    throw fail('rewrap-failed');
  const original = wrapper(value.original),
    replacement = wrapper(value.replacement);
  const validate = async (encoded: Uint8Array) => {
    const opened = await unwrap(Buffer.from(encoded));
    if (!/^[0-9a-f]{64}$/.test(opened.result) || kekDigest(opened.result) !== value.digest)
      throw fail('rewrap-failed');
  };
  let current: Uint8Array | undefined;
  try {
    current = await readOwned(path, 8192);
    if (!equal(current, original) && !equal(current, replacement)) throw fail('rewrap-failed');
    await validate(current);
  } catch {
    // A failed final native readback may leave the replacement, or a failed rollback
    // may leave the original. A retired OS wrapping key can also make only the
    // journaled replacement usable. Publish only a validated same-key copy.
    let retained = original;
    try {
      await validate(original);
    } catch {
      await validate(replacement);
      retained = replacement;
    }
    await replaceWrapped(path, retained);
    await validate(await readOwned(path, 8192));
  }
  await remove(`${path}.rewrap-pending`);
  await remove(`${journalPath}.rewrap-pending`);
  await remove(journalPath);
}
/** Caller holds the initialization OS mutex until native readback and rollback settle. */
async function rewrapKek(
  path: string,
  original: Uint8Array,
  plaintext: string,
  wrap: KekWrapper['wrap'],
  unwrap: KekWrapper['unwrap']
) {
  const journalPath = `${path}.rewrap-journal`;
  let journaled = false;
  try {
    if (!equal(await readOwned(path, 8192), original)) throw fail('rewrap-failed');
    const encrypted = await wrap(plaintext);
    if (!(encrypted instanceof Uint8Array) || encrypted.length < 1 || encrypted.length > 8192)
      throw fail('rewrap-failed');
    const replacement = new Uint8Array(encrypted);
    const validate = async (actual: Uint8Array) => {
      if (!equal(actual, replacement)) throw fail('rewrap-failed');
      const result = await unwrap(Buffer.from(actual));
      if (result.result !== plaintext || result.shouldReEncrypt) throw fail('rewrap-failed');
    };
    await validate(replacement);
    const journal = Buffer.from(
      JSON.stringify({
        original: Buffer.from(original).toString('hex'),
        replacement: Buffer.from(replacement).toString('hex'),
        digest: kekDigest(plaintext),
      })
    );
    // The journal reaches disk before the retained wrapper can change.
    await replaceWrapped(journalPath, journal);
    journaled = true;
    await replaceWrapped(path, replacement);
    await validate(await readOwned(path, 8192));
    await remove(journalPath);
  } catch {
    if (journaled) {
      try {
        if (!equal(await readOwned(path, 8192), original)) await replaceWrapped(path, original);
        const restored = await readOwned(path, 8192);
        const opened = await unwrap(Buffer.from(restored));
        if (!equal(restored, original) || opened.result !== plaintext) throw fail('rewrap-failed');
        await remove(journalPath);
      } catch {
        // Leave the encrypted journal, not a permanent lock. Next initialization
        // owns recovery after SQLite proves that no live initializer holds it.
      }
    }
    throw fail('rewrap-failed');
  } finally {
    await remove(`${path}.rewrap-pending`);
    await remove(`${journalPath}.rewrap-pending`);
  }
}
/** Prepared local identity, retained under a genesis before publication. */
export interface PreparedNodeE2eeDevice extends DeviceSigner {
  readonly enc: Bytes.EncryptionPublicKey;
}
/** Open device signer and nonextractable encryption handles; borrowed from the custody owner. */
export interface NodeE2eeDevice extends PreparedNodeE2eeDevice {
  readonly enc: Bytes.EncryptionPublicKey;
  readonly encryption: Readonly<CryptoKeyPair>;
}
/** No IPC or startup registration. Its Scope owns the KEK and raw native work. */
export const makeNodeE2eeCustody = Effect.fnUntraced(function* (input: {
  readonly directory: string;
  readonly wrapper: KekWrapper;
}) {
  const { directory } = input;
  if (typeof directory !== 'string' || !isAbsolute(directory)) return yield* fail('invalid-input');
  const storage = input.wrapper;
  if (storage?.protection !== 'os-keystore' && storage?.protection !== 'file')
    return yield* fail('unavailable');
  const protection = storage.protection;
  const wrap = storage.wrap.bind(storage);
  const unwrap = storage.unwrap.bind(storage);
  const subtle = globalThis.crypto.subtle;
  const generate = subtle.generateKey.bind(subtle);
  const exportKey = subtle.exportKey.bind(subtle);
  const importKey = subtle.importKey.bind(subtle);
  const sign = subtle.sign.bind(subtle);
  const verify = subtle.verify.bind(subtle);
  const derive = subtle.deriveBits.bind(subtle);
  const random = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  const active = new Set<Promise<unknown>>();
  type Prepared = {
    readonly kind: 'personal' | 'machine';
    readonly publicKey: Uint8Array;
    readonly encryptionPublicKey: Uint8Array;
    signing?: CryptoKey;
    signingBytes?: Uint8Array;
    encryptionBytes?: Uint8Array;
    bound?: string;
  };
  const preparedDevices = new Map<PreparedNodeE2eeDevice, Prepared>();
  const clearPrepared = (value: Prepared) => {
    value.signingBytes?.fill(0);
    value.encryptionBytes?.fill(0);
    value.signingBytes = value.encryptionBytes = undefined;
    value.signing = undefined;
  };
  let closed = false;
  let kek: Uint8Array | undefined;
  function track<A>(work: () => Promise<A>): Promise<A> {
    if (closed) return Promise.reject(fail('closed'));
    const pending = Promise.resolve().then(work);
    active.add(pending);
    void pending.then(
      () => active.delete(pending),
      () => active.delete(pending)
    );
    return pending;
  }
  const close = async () => {
    closed = true;
    await Promise.allSettled([...active]);
    for (const value of preparedDevices.values()) clearPrepared(value);
    preparedDevices.clear();
    kek?.fill(0);
    kek = undefined;
  };
  yield* Effect.addFinalizer(() => native(close).pipe(Effect.orDie));
  yield* native(() =>
    track(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const info = await lstat(directory);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
      )
        throw fail('storage');
      const file = join(directory, 'kek.safe-storage');
      const mutex = await lockInitialization(file);
      try {
        await recoverRewrap(file, unwrap).catch(() => {
          throw fail('rewrap-failed');
        });
        let wrapped: Uint8Array;
        try {
          wrapped = await readOwned(file, 8192);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
          const candidate = random(new Uint8Array(32));
          try {
            const encoded = await wrap(Buffer.from(candidate).toString('hex'));
            if (!(encoded instanceof Uint8Array) || encoded.length < 1 || encoded.length > 8192)
              throw fail('corrupt');
            await publish(file, encoded);
          } finally {
            candidate.fill(0);
          }
          wrapped = await readOwned(file, 8192);
        }
        const recovered = await unwrap(Buffer.from(wrapped));
        if (!/^[0-9a-f]{64}$/.test(recovered.result)) throw fail('corrupt');
        if (recovered.shouldReEncrypt)
          await rewrapKek(file, wrapped, recovered.result, wrap, unwrap);
        kek = new Uint8Array(Buffer.from(recovered.result, 'hex'));
        // Native strings/handles cannot be deterministically erased. Never log or
        // persist this decrypted string; owned byte copies are cleared on close.
      } finally {
        mutex.close();
      }
    })
  );
  const seal = (body: Uint8Array, aad: Uint8Array) => {
    if (!kek) throw fail('closed');
    const nonce = random(new Uint8Array(24));
    const header = Buffer.concat([
      domain,
      Buffer.from([aad.length >> 8, aad.length & 255]),
      aad,
      nonce,
    ]);
    return new Uint8Array(
      Buffer.concat([header, xchacha20poly1305(kek, nonce, header).encrypt(body)])
    );
  };
  const unseal = (inputBlob: Uint8Array) => {
    if (!kek) throw fail('closed');
    const blob = bytes(inputBlob, 32768);
    if (!equal(blob.subarray(0, domain.length), domain) || blob.length < domain.length + 42)
      throw fail('corrupt');
    const size = (blob[domain.length]! << 8) | blob[domain.length + 1]!;
    const at = domain.length + 2 + size;
    if (at + 40 > blob.length) throw fail('corrupt');
    const aad = blob.slice(domain.length + 2, at);
    try {
      return {
        body: xchacha20poly1305(kek, blob.subarray(at, at + 24), blob.subarray(0, at + 24)).decrypt(
          blob.subarray(at + 24)
        ),
        aad,
      };
    } catch {
      throw fail('corrupt');
    }
  };
  const protector = (kind: 'installed' | 'candidate'): NativeEpochProtector =>
    Object.freeze({
      protect: (inputBody) => {
        if (closed) return Promise.reject(fail('closed'));
        let body: Uint8Array;
        try {
          body = bytes(inputBody, 12288);
        } catch (cause) {
          return Promise.reject(cause);
        }
        const result = track(async () => {
          try {
            return seal(body, context(body, kind));
          } finally {
            body.fill(0);
          }
        });
        void result.catch(() => body.fill(0));
        return result;
      },
      unprotect: (inputBlob) => {
        if (closed) return Promise.reject(fail('closed'));
        let blob: Uint8Array;
        try {
          blob = bytes(inputBlob, 32768);
        } catch (cause) {
          return Promise.reject(cause);
        }
        return track(async () => {
          const opened = unseal(blob);
          try {
            if (!equal(context(opened.body, kind), opened.aad)) throw fail('corrupt');
            return opened.body;
          } catch (cause) {
            opened.body.fill(0);
            throw cause;
          }
        });
      },
    });
  const deviceContext = (
    genesis: Bytes.GenesisHash,
    key: Uint8Array,
    enc: Uint8Array,
    kind: 'personal' | 'machine'
  ) =>
    new Uint8Array(
      Buffer.concat([
        devicePurpose,
        genesis.toBytes(),
        key,
        enc,
        Buffer.from([kind === 'personal' ? 0 : 1]),
      ])
    );
  const ownGenesis = (value: Bytes.GenesisHash) =>
    Result.getOrThrow(Bytes.genesisHash(value.toBytes()));
  const decodeDevice = async (
    genesis: Bytes.GenesisHash,
    kind: 'personal' | 'machine',
    blob: Uint8Array
  ): Promise<NodeE2eeDevice> => {
    const opened = unseal(blob);
    try {
      const at = devicePurpose.length + 32;
      const key = opened.aad.slice(at, at + 32);
      const enc = opened.aad.slice(at + 32, at + 64);
      if (!equal(opened.aad, deviceContext(genesis, key, enc, kind)) || opened.body.length !== 96)
        throw fail('corrupt');
      const ed = opened.body.slice(0, 48),
        x = opened.body.slice(48);
      let signing: CryptoKey, encryption: CryptoKey;
      try {
        signing = await importKey('pkcs8', ed, 'Ed25519', false, ['sign']);
        encryption = await importKey('pkcs8', x, 'X25519', false, ['deriveBits']);
      } finally {
        ed.fill(0);
        x.fill(0);
      }
      const publicSigning = await importKey('raw', key, 'Ed25519', true, ['verify']);
      const proof = new Uint8Array([69, 50, 69, 69]);
      if (!(await verify('Ed25519', publicSigning, await sign('Ed25519', signing, proof), proof)))
        throw fail('corrupt');
      const temporary = (await generate('X25519', true, ['deriveBits'])) as CryptoKeyPair;
      const publicEncryption = await importKey('raw', enc, 'X25519', true, []);
      const a = new Uint8Array(
        await derive({ name: 'X25519', public: temporary.publicKey }, encryption, 256)
      );
      const b = new Uint8Array(
        await derive({ name: 'X25519', public: publicEncryption }, temporary.privateKey, 256)
      );
      try {
        if (!equal(a, b)) throw fail('corrupt');
      } finally {
        a.fill(0);
        b.fill(0);
      }
      return Object.freeze({
        publicKey: Result.getOrThrow(Bytes.signingPublicKey(key)),
        enc: Result.getOrThrow(Bytes.encryptionPublicKey(enc)),
        sign: (message: Uint8Array) =>
          Effect.suspend(() => {
            const copied = bytes(message, 16 * 1024 * 1024);
            return native(() =>
              track(async () => {
                try {
                  return Result.getOrThrow(
                    Bytes.signature(new Uint8Array(await sign('Ed25519', signing, copied)))
                  );
                } finally {
                  copied.fill(0);
                }
              })
            ).pipe(Effect.mapError(() => new ContentError({ code: 'sign-failed' })));
          }),
        encryption: Object.freeze({ publicKey: publicEncryption, privateKey: encryption }),
      });
    } finally {
      opened.body.fill(0);
    }
  };
  const pathFor = (genesis: Bytes.GenesisHash, kind: 'personal' | 'machine') =>
    join(directory, `${Buffer.from(genesis.toBytes()).toString('hex')}.${kind}.device`);
  const validKind = (kind: string): kind is 'personal' | 'machine' =>
    kind === 'machine' || (kind === 'personal' && protection === 'os-keystore');
  async function prepareDevice(kind: 'personal' | 'machine'): Promise<PreparedNodeE2eeDevice> {
    if (!validKind(kind)) throw fail('invalid-input');
    const settled = await Promise.allSettled([
      generate('Ed25519', true, ['sign', 'verify']),
      generate('X25519', true, ['deriveBits']),
    ]);
    for (const value of settled) if (value.status === 'rejected') throw value.reason;
    const signing = (settled[0] as PromiseFulfilledResult<CryptoKeyPair>).value;
    const encryption = (settled[1] as PromiseFulfilledResult<CryptoKeyPair>).value;
    let ed: Uint8Array | undefined, x: Uint8Array | undefined;
    let transferred = false;
    try {
      ed = new Uint8Array(await exportKey('pkcs8', signing.privateKey));
      x = new Uint8Array(await exportKey('pkcs8', encryption.privateKey));
      if (ed.length !== 48 || x.length !== 48) throw fail('corrupt');
      const publicKey = new Uint8Array(await exportKey('raw', signing.publicKey));
      const encryptionPublicKey = new Uint8Array(await exportKey('raw', encryption.publicKey));
      const prepared: PreparedNodeE2eeDevice = Object.freeze({
        publicKey: Result.getOrThrow(Bytes.signingPublicKey(publicKey)),
        enc: Result.getOrThrow(Bytes.encryptionPublicKey(encryptionPublicKey)),
        sign: (message: Uint8Array) =>
          Effect.suspend(() =>
            native(() =>
              track(async () => {
                const owned = preparedDevices.get(prepared);
                if (!owned?.signing || owned.bound) throw fail('closed');
                const copied = bytes(message, 16 * 1024 * 1024);
                try {
                  return Result.getOrThrow(
                    Bytes.signature(new Uint8Array(await sign('Ed25519', owned.signing, copied)))
                  );
                } finally {
                  copied.fill(0);
                }
              })
            )
          ).pipe(Effect.mapError(() => new ContentError({ code: 'sign-failed' }))),
      });
      preparedDevices.set(prepared, {
        kind,
        publicKey,
        encryptionPublicKey,
        signing: signing.privateKey,
        signingBytes: ed,
        encryptionBytes: x,
      });
      transferred = true;
      return prepared;
    } finally {
      if (!transferred) {
        ed?.fill(0);
        x?.fill(0);
      }
    }
  }
  async function retainDevice(genesis: Bytes.GenesisHash, prepared: PreparedNodeE2eeDevice) {
    const value = preparedDevices.get(prepared);
    if (!value) throw fail('invalid-input');
    const id = Buffer.from(genesis.toBytes()).toString('hex');
    if (value.bound && value.bound !== id) throw fail('invalid-input');
    const file = pathFor(genesis, value.kind);
    if (!value.bound) {
      if (!value.signingBytes || !value.encryptionBytes) throw fail('closed');
      const body = new Uint8Array(Buffer.concat([value.signingBytes, value.encryptionBytes]));
      try {
        await publish(
          file,
          seal(body, deviceContext(genesis, value.publicKey, value.encryptionPublicKey, value.kind))
        );
      } finally {
        body.fill(0);
        clearPrepared(value);
      }
      // A committed local original remains recoverable even if readback fails.
      value.bound = id;
    }
    const actual = await decodeDevice(genesis, value.kind, await readOwned(file, 32768));
    if (
      !equal(actual.publicKey.toBytes(), value.publicKey) ||
      !equal(actual.enc.toBytes(), value.encryptionPublicKey)
    )
      throw fail('corrupt');
    return actual;
  }
  const credentialContext = (genesis: Bytes.GenesisHash, key: Bytes.SigningPublicKey) =>
    new Uint8Array(Buffer.concat([credentialPurpose, genesis.toBytes(), key.toBytes()]));
  const credentialPath = (genesis: Bytes.GenesisHash, key: Bytes.SigningPublicKey) =>
    join(
      directory,
      `device-credential-${Buffer.from(genesis.toBytes()).toString('hex')}-${Buffer.from(key.toBytes()).toString('hex')}.sealed`
    );
  const readCredential = async (genesis: Bytes.GenesisHash, key: Bytes.SigningPublicKey) => {
    const opened = unseal(await readOwned(credentialPath(genesis, key), 1024));
    try {
      if (!equal(opened.aad, credentialContext(genesis, key)) || opened.body.length !== 32)
        throw fail('corrupt');
      return Buffer.from(opened.body).toString('hex');
    } finally {
      opened.body.fill(0);
    }
  };
  return Object.freeze({
    protection,
    /** Explicit first preparation only. Publish encrypted original before returning;
     * exact retries read the winner, never replace a credential or identity. */
    prepareDeviceCredential: (inputGenesis: Bytes.GenesisHash, key: Bytes.SigningPublicKey) =>
      native(() =>
        track(async () => {
          const genesis = ownGenesis(inputGenesis);
          try {
            const credential = await readCredential(genesis, key);
            return {
              credential,
              credentialHash: createHash('sha256')
                .update(Buffer.from(credential, 'hex'))
                .digest('hex'),
            };
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
          }
          const raw = random(new Uint8Array(32));
          try {
            await publish(credentialPath(genesis, key), seal(raw, credentialContext(genesis, key)));
          } finally {
            raw.fill(0);
          }
          const credential = await readCredential(genesis, key);
          return {
            credential,
            credentialHash: createHash('sha256')
              .update(Buffer.from(credential, 'hex'))
              .digest('hex'),
          };
        })
      ),
    /** Reopen a previously retained access credential. Missing/corrupt data never regenerates it. */
    deviceCredential: (inputGenesis: Bytes.GenesisHash, key: Bytes.SigningPublicKey) =>
      native(() => track(() => readCredential(ownGenesis(inputGenesis), key))),
    installed: protector('installed'),
    candidate: protector('candidate'),
    /** Only local signing is available before binding. No private handles export. */
    prepareDevice: (kind: 'personal' | 'machine' = 'personal') =>
      native(() => track(() => prepareDevice(kind))),
    /** Discard only this uncommitted preparation; never delete a retained identity. */
    discardDevice: (prepared: PreparedNodeE2eeDevice) =>
      Effect.sync(() => {
        const value = preparedDevices.get(prepared);
        if (value) clearPrepared(value);
        preparedDevices.delete(prepared);
      }),
    /** Call after computing genesis, before any submission/HTTP dispatch. */
    retainDevice: (inputGenesis: Bytes.GenesisHash, prepared: PreparedNodeE2eeDevice) =>
      native(() => track(() => retainDevice(ownGenesis(inputGenesis), prepared))),
    createDevice: (inputGenesis: Bytes.GenesisHash, kind: 'personal' | 'machine' = 'personal') =>
      native(() =>
        track(async () => {
          if (!validKind(kind)) throw fail('invalid-input');
          const genesis = ownGenesis(inputGenesis),
            file = pathFor(genesis, kind);
          try {
            return await decodeDevice(genesis, kind, await readOwned(file, 32768));
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
          }
          return retainDevice(genesis, await prepareDevice(kind));
        })
      ),
    openDevice: (inputGenesis: Bytes.GenesisHash, kind: 'personal' | 'machine' = 'personal') =>
      native(() =>
        track(async () => {
          if (!validKind(kind)) throw fail('invalid-input');
          const genesis = ownGenesis(inputGenesis);
          return decodeDevice(genesis, kind, await readOwned(pathFor(genesis, kind), 32768));
        })
      ),
    stop: () =>
      Effect.sync(() => {
        closed = true;
      }),
    close: () => native(close),
  });
});

/** An opened Node custody (see {@link makeNodeE2eeCustody}). */
export type NodeE2eeCustody = Effect.Success<ReturnType<typeof makeNodeE2eeCustody>>;

/**
 * The platform ports this custody provides to `@lody/e2ee-core` workflows for
 * one opened device: `KeyProtector` (installed keys), `CandidateProtector`
 * (unpublished rotation keys, under a separate purpose context) and
 * `DeviceIdentity` (signer and nonextractable encryption key pair).
 */
export const nodeE2eePorts = (custody: NodeE2eeCustody, device: NodeE2eeDevice) =>
  Layer.mergeAll(
    KeyProtector.layerFromPromises(custody.installed),
    CandidateProtector.layerFromPromises(custody.candidate),
    Layer.succeed(DeviceIdentity, { signer: device, encryptionKeyPair: device.encryption })
  );
