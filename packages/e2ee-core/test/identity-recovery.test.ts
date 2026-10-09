import { nodeDeviceIdentityClient } from '../src/node-identity-client';
// recovery device R, join/enrollment binding, recovery file and
// local device identity storage. Real Ed25519/X25519/XChaCha20 and real SQLite in
// temp dirs; no crypto stubs, clocks, sleeps or network.
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Ledger, LedgerError, canSendEpoch } from '../src/ledger';
import { deviceMayWriteDocument } from '../src/streams-content';
import type { Operation } from '../src/ledger/schema';
import { encodeSignedRecord } from '../src/ledger/schema';
import { createRecoveryDeviceSecret, importRecoveryDevice } from '../src/recovery-device';
import {
  createRecoveryFile,
  openRecoveryBackup,
  parseRecoveryFile,
  sealRecoveryBackup,
} from '../src/recovery-file';
import { encodeRecoveryFile } from '../src/pure/recovery-file';
import { SqliteDeviceIdentityStore } from '../src/node-device-store';
import { SqliteUserIdentityStore } from '../src/node-user-store';
import { protection } from './node-protection-fixture';
import {
  HISTORY_PACKET_BYTES,
  admitDeviceOp,
  append,
  commitEpochKey,
  ed25519,
  hex,
  random,
  signGenesis,
  signJoin,
  type DeviceKeys,
} from './ledger-fixtures';
import { Result } from 'effect';

type L = Awaited<ReturnType<typeof Ledger.verify>>;

async function code(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    if (error instanceof LedgerError) return error.code;
    if (error instanceof Error) return error.message;
    throw error;
  }
  return 'accepted';
}

async function signed(ledger: L, signer: DeviceKeys, operation: Operation) {
  const proposal = ledger.prepare(operation, signer.publicKey);
  return encodeSignedRecord(proposal.bodyBytes, await signer.sign(proposal.signingBytes));
}

async function tryAppend(ledger: L, signer: DeviceKeys, operation: Operation) {
  return code(ledger.extend([await signed(ledger, signer, operation)]));
}

async function org() {
  const owner = await ed25519();
  const created = await signGenesis(owner);
  let ledger = created.ledger;
  const push = async (signer: DeviceKeys, op: Operation) => {
    ledger = (await append(ledger, signer, op)).ledger;
  };
  const admit = async () => {
    const device = await ed25519();
    const request = await signJoin(created.anchor, device);
    const membershipId = random(16);
    await push(owner, { type: 'admitMember', membershipId, request });
    return { device, membershipId, request };
  };
  return {
    owner,
    created,
    get ledger() {
      return ledger;
    },
    push,
    admit,
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'e2ee-review-e-'));
  dirs.push(dir);
  return dir;
}

describe('recovery device R: receive keys and admit own personal devices only', () => {
  it('SAFE: R of an Owner cannot manage, write, forward keys, revoke, or admit machine/R/foreign devices', async () => {
    const o = await org();
    const anchor = o.created.anchor;
    const r = await ed25519();
    await o.push(o.owner, await admitDeviceOp(anchor, o.created.membershipId, r, 'recovery'));
    const bob = await o.admit();
    const applicant = await ed25519();
    const managerial: Operation[] = [
      {
        type: 'admitMember',
        membershipId: random(16),
        request: await signJoin(anchor, applicant),
      },
      { type: 'setRole', membershipId: bob.membershipId, role: 'guest' },
      { type: 'removeMember', membershipId: bob.membershipId },
      { type: 'transferOwner', successorMembershipId: bob.membershipId },
      {
        type: 'publishEpoch',
        epoch: 1,
        commitment: await commitEpochKey(anchor, 1, random(32)),
        previousEpochKey: random(HISTORY_PACKET_BYTES),
      },
      { type: 'revokeDevice', target: o.owner.publicKey },
      await admitDeviceOp(anchor, o.created.membershipId, await ed25519(), 'machine'),
      await admitDeviceOp(anchor, o.created.membershipId, await ed25519(), 'recovery'),
      // Possession proof bound to Bob's membership cannot be submitted by Alice's R.
      await admitDeviceOp(anchor, bob.membershipId, await ed25519(), 'personal'),
    ];
    const outcomes = [];
    for (const op of managerial) outcomes.push(`${op.type}:${await tryAppend(o.ledger, r, op)}`);
    expect(
      outcomes.every((line) => !line.endsWith(':accepted')),
      outcomes.join(' ')
    ).toBe(true);
    expect(canSendEpoch(o.ledger.state, r.publicKey)).toBe(false);
    expect(deviceMayWriteDocument(o.ledger.state, hex(r.publicKey))).toBe(false);

    // Allowed: R admits a new personal device of its own user; it follows the Owner role.
    const c = await ed25519();
    await o.push(r, await admitDeviceOp(anchor, o.created.membershipId, c, 'personal'));
    expect(hex(o.ledger.state.devices.get(hex(c.publicKey))!.membershipId)).toBe(
      hex(o.created.membershipId)
    );
    expect(
      await tryAppend(o.ledger, c, {
        type: 'setRole',
        membershipId: bob.membershipId,
        role: 'admin',
      })
    ).toBe('accepted');
  });

  it('SAFE: R of a Guest yields only a Guest personal device (no write, no management)', async () => {
    const o = await org();
    const anchor = o.created.anchor;
    const guest = await o.admit();
    await o.push(o.owner, { type: 'setRole', membershipId: guest.membershipId, role: 'guest' });
    const r = await ed25519();
    await o.push(guest.device, await admitDeviceOp(anchor, guest.membershipId, r, 'recovery'));
    const c = await ed25519();
    await o.push(r, await admitDeviceOp(anchor, guest.membershipId, c, 'personal'));
    expect(deviceMayWriteDocument(o.ledger.state, hex(c.publicKey))).toBe(false);
    expect(
      await tryAppend(o.ledger, c, {
        type: 'admitMember',
        membershipId: random(16),
        request: await signJoin(anchor, await ed25519()),
      })
    ).toBe('unauthorized');
    expect(
      await tryAppend(
        o.ledger,
        c,
        await admitDeviceOp(anchor, guest.membershipId, await ed25519(), 'machine')
      )
    ).toBe('unauthorized');
    // Removing the user kills R and everything R admitted.
    await o.push(o.owner, { type: 'removeMember', membershipId: guest.membershipId });
    expect(o.ledger.state.devices.has(hex(r.publicKey))).toBe(false);
    expect(o.ledger.state.devices.has(hex(c.publicKey))).toBe(false);
  });
});

describe('join request binds Org, request id, keys and expiry', () => {
  it('SAFE: cross-Org replay, reuse after removal, re-admission under a new membership id, and field tampering all fail', async () => {
    const a = await org();
    const b = await org();
    const applicant = await ed25519();
    const request = await signJoin(a.created.anchor, applicant);
    // Org B cannot consume a request signed for Org A.
    expect(
      await tryAppend(b.ledger, b.owner, { type: 'admitMember', membershipId: random(16), request })
    ).toBe('bad-proof');
    // Expiry, userId, requestId are signed.
    for (const tampered of [
      { ...request, expiresAt: 1 },
      { ...request, userId: random(32) },
      { ...request, requestId: random(16) },
    ]) {
      expect(
        await tryAppend(a.ledger, a.owner, {
          type: 'admitMember',
          membershipId: random(16),
          request: tampered,
        })
      ).toBe('bad-proof');
    }
    const membershipId = random(16);
    await a.push(a.owner, { type: 'admitMember', membershipId, request });
    // Same request, second membership while the first is live.
    expect(
      await tryAppend(a.ledger, a.owner, { type: 'admitMember', membershipId: random(16), request })
    ).toBe('replay');
    await a.push(a.owner, { type: 'removeMember', membershipId });
    // After removal the same signed request (and its keys) cannot resurrect the member.
    expect(
      await tryAppend(a.ledger, a.owner, { type: 'admitMember', membershipId: random(16), request })
    ).toBe('replay');
  });
});

describe('recovery file / backup frame', () => {
  const material = new TextEncoder().encode('synthetic-recovery-material');

  it('SAFE: revision downgrade, identity swap, foreign file, and header-length tampering are rejected', () => {
    const file = createRecoveryFile();
    const identity = 'ab'.repeat(32);
    const rev1 = sealRecoveryBackup(file, { identity, revision: 1 }, material);
    const rev2 = sealRecoveryBackup(file, { identity, revision: 2 }, material);
    expect(openRecoveryBackup(file, { identity, revision: 2 }, rev2)).toEqual(material);
    expect(() => openRecoveryBackup(file, { identity, revision: 2 }, rev1)).toThrow(
      'recovery-context-mismatch'
    );
    expect(() =>
      openRecoveryBackup(file, { identity: 'cd'.repeat(32), revision: 2 }, rev2)
    ).toThrow('recovery-context-mismatch');
    // Same backupId, different key: AEAD fails closed.
    const { backupId } = parseRecoveryFile(file);
    const forged = Result.getOrThrow(encodeRecoveryFile(backupId, random(32)));
    expect(() => openRecoveryBackup(forged, { identity, revision: 2 }, rev2)).toThrow(
      'recovery-authentication-failed'
    );
    // A different file is a different backupId and never reaches decryption.
    expect(() => openRecoveryBackup(createRecoveryFile(), { identity, revision: 2 }, rev2)).toThrow(
      'recovery-context-mismatch'
    );
    const lying = new Uint8Array(rev2);
    new DataView(lying.buffer).setUint16(0, 10);
    expect(() => openRecoveryBackup(file, { identity, revision: 2 }, lying)).toThrow(
      'invalid-recovery-backup'
    );
    const flipped = new Uint8Array(rev2);
    flipped[flipped.length - 1]! ^= 1;
    expect(() => openRecoveryBackup(file, { identity, revision: 2 }, flipped)).toThrow(
      'recovery-authentication-failed'
    );
    // Non-canonical file text (whitespace / uppercase hex) is not accepted.
    const text = new TextDecoder().decode(file);
    for (const variant of [text.replace(',', ', '), text.toUpperCase()]) {
      expect(() => parseRecoveryFile(new TextEncoder().encode(variant))).toThrow();
    }
  });

  it('importRecoveryDevice rejects a secret whose public keys do not match its private keys', async () => {
    // Two honest R secrets; splice R1's public keys onto R2's private keys.
    const r1 = await createRecoveryDeviceSecret();
    const r2 = await createRecoveryDeviceSecret();
    const f1 = JSON.parse(new TextDecoder().decode(r1.secret)) as string[];
    const f2 = JSON.parse(new TextDecoder().decode(r2.secret)) as string[];
    const spliced = new TextEncoder().encode(JSON.stringify([f1[0], f1[1], f1[2], f2[3], f2[4]]));
    // restoreUserIdentity / SqliteDeviceIdentityStore both check pair consistency;
    // the R import path should too (spec: backup binds the expected R public key).
    const outcome = await importRecoveryDevice(spliced).then(
      async (handle) => {
        const message = new TextEncoder().encode('probe');
        const signature = await handle.sign(message);
        const key = await crypto.subtle.importKey(
          'raw',
          new Uint8Array(handle.publicKey),
          'Ed25519',
          false,
          ['verify']
        );
        const verifies = await crypto.subtle.verify(
          'Ed25519',
          key,
          new Uint8Array(signature),
          message
        );
        return `accepted: handle.publicKey=R1, signing key=R2, self-verify=${verifies}`;
      },
      (error: Error) => `rejected: ${error.message}`
    );
    expect(outcome).toMatch(/^rejected/);
  });
});

describe('local device / user identity storage', () => {
  it('SAFE: device store is 0600, never regenerates on load failure, and create refuses to overwrite', async () => {
    const dir = temp();
    const path = join(dir, 'device.sqlite');
    const binding = 'a1'.repeat(32);
    const p = protection();
    const created = await new SqliteDeviceIdentityStore(path, binding, p.device).create();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const pub = hex(
      new Uint8Array(await crypto.subtle.exportKey('raw', created.signing.publicKey))
    );
    expect(created.signing.privateKey.extractable).toBe(false);

    // Wrong OS protection key (e.g. keychain reset): load fails, create still refuses.
    const other = protection();
    await expect(
      new SqliteDeviceIdentityStore(path, binding, other.device).load()
    ).rejects.toThrow();
    await expect(
      new SqliteDeviceIdentityStore(path, binding, other.device).create()
    ).rejects.toThrow('device-identity-exists');
    // Wrong account binding is rejected, not re-created.
    await expect(
      new SqliteDeviceIdentityStore(path, 'b2'.repeat(32), p.device).load()
    ).rejects.toThrow();
    // Protection unavailable: fails, no regeneration.
    p.state.available = false;
    await expect(new SqliteDeviceIdentityStore(path, binding, p.device).load()).rejects.toThrow(
      'secure-key-storage-unavailable'
    );
    p.state.available = true;
    const again = await new SqliteDeviceIdentityStore(path, binding, p.device).load();
    expect(hex(new Uint8Array(await crypto.subtle.exportKey('raw', again.signing.publicKey)))).toBe(
      pub
    );
    expect(again.signing.privateKey.extractable).toBe(false);
  });

  it('SAFE: user-store recovery never replaces an existing identity', async () => {
    const dir = temp();
    const p = protection();
    const binding = 'c3'.repeat(32);
    const source = new SqliteUserIdentityStore(join(dir, 'src.sqlite'), binding, p.user);
    const identity = await source.create();
    const file = createRecoveryFile();
    const context = { identity: identity.fingerprint, revision: 0 };
    const frame = await source.sealBackup(file, context);
    const target = new SqliteUserIdentityStore(join(dir, 'dst.sqlite'), binding, p.user);
    const existing = await target.create();
    await expect(target.recover(file, context, frame)).rejects.toThrow('user-identity-exists');
    expect((await target.load()).fingerprint).toBe(existing.fingerprint);
    // Context identity must match the stored fingerprint when sealing.
    await expect(
      source.sealBackup(file, { identity: 'ee'.repeat(32), revision: 0 })
    ).rejects.toThrow('user-identity-mismatch');
  });
});

describe('open never initializes missing storage', () => {
  it('device identity load() on a missing path does not create a SQLite store', async () => {
    const dir = temp();
    const path = join(dir, 'never-created.sqlite');
    const p = protection();
    const outcome = await new SqliteDeviceIdentityStore(path, 'd4'.repeat(32), p.device)
      .load()
      .then(
        () => 'loaded',
        (error: Error) => error.message
      );
    let created = false;
    try {
      statSync(path);
      created = true;
    } catch {
      created = false;
    }
    expect({ outcome, fileCreatedByLoad: created }).toEqual({
      outcome: 'device-identity-missing',
      fileCreatedByLoad: false,
    });
  });
});

it('initializes through the Promise facade without replacing identity and checks account before create', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'identity-facade-'));
  const protectedKeys = protection();
  try {
    const path = join(dir, 'device.sqlite');
    const client = nodeDeviceIdentityClient({
      path,
      binding: 'ab'.repeat(32),
      protection: protectedKeys.device,
    });
    await expect(
      client.initialize(() => {
        throw new Error('stale-account');
      })
    ).rejects.toThrow('stale-account');
    await expect(client.load()).rejects.toMatchObject({ _tag: 'StorageError', reason: 'missing' });
    const created = await client.initialize(() => {});
    const loaded = await client.initialize(() => {
      throw new Error('must-not-recreate');
    });
    expect(loaded.id).toEqual(created.id);
    expect(await crypto.subtle.exportKey('raw', loaded.signing.publicKey)).toEqual(
      await crypto.subtle.exportKey('raw', created.signing.publicKey)
    );
    expect(await crypto.subtle.exportKey('raw', loaded.encryption.publicKey)).toEqual(
      await crypto.subtle.exportKey('raw', created.encryption.publicKey)
    );
    await expect(client.create()).rejects.toMatchObject({ _tag: 'StorageError', reason: 'exists' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
