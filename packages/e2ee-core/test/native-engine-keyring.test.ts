/**
 * Byte equality between this package's Loro Streams content binding (the
 * product seal/open path) and the native loro-repo-rs engine keyring
 * (`ContentKeyring`), in both directions. Room AAD comes from the product
 * encoder, `loro-repo`'s `encodeStreamsRoomAdditionalData`, and the core
 * resource names follow `encryptedWorkspaceRoom` in `@lody/shared`.
 * Native engine cloud/E2EE Spec, phase 0: specs/native-engine-cloud-e2ee.md.
 */
import { describe, expect, it } from 'vitest';
import type { ContentKeyring } from '@loro-dev/loro-repo-engine';
import {
  ENGINE_NAMESPACE,
  EPOCH0,
  EPOCH1,
  type Kind,
  type Room,
  aad,
  core,
  coreOpen,
  coreSeal,
  engineOpen,
  engineSeal,
  epochOf,
  headerFor,
  identity,
  matrix,
  plaintext,
  workspace,
} from './native-engine-keyring-fixture';

describe('native engine keyring and core content binding', () => {
  it.each(matrix)('%s sealed by core opens in the engine keyring', async (_, room, kind) => {
    const f = workspace();
    const sealed = await coreSeal(f, room, kind);
    expect(sealed.header).toEqual(headerFor(kind));
    expect(engineOpen(f.keyring(), f, room, kind, sealed)).toEqual(plaintext);
  });

  it.each(matrix)('%s sealed by the engine keyring opens in core', async (_, room, kind) => {
    const f = workspace();
    const sealed = engineSeal(f.keyring(), f, room, kind);
    expect(sealed.header).toEqual(headerFor(kind));
    expect(await coreOpen(f, room, kind, sealed)).toEqual(plaintext);
  });

  it.each(matrix)(
    '%s fails on tampered room, AAD or epoch in both directions',
    async (_, room, kind) => {
      const f = workspace();
      const other: Room =
        room.kind === 'doc'
          ? { kind: 'doc', docId: 'session-0002' }
          : room.kind === 'flock'
            ? { kind: 'flock', flockDocId: 'ws-native-keyring:sr' }
            : { kind: 'doc', docId: 'meta' };
      const byCore = await coreSeal(f, room, kind);
      const byEngine = engineSeal(f.keyring(), f, room, kind);
      const wrongAad = aad(f, other, kind).full;
      const flipped = (s: { header: Uint8Array; sealed: Uint8Array }) => {
        const sealed = new Uint8Array(s.sealed);
        sealed[4] ^= 1;
        return { header: s.header, sealed };
      };
      for (const sealed of [byCore, byEngine]) {
        expect(() => engineOpen(f.keyring(), f, room, kind, sealed, wrongAad)).toThrow(
          /CONTENT_KEYRING/
        );
        expect(() => engineOpen(f.keyring(), f, other, kind, sealed)).toThrow(/CONTENT_KEYRING/);
        expect(() => engineOpen(f.keyring(), f, room, kind, flipped(sealed))).toThrow(
          /CONTENT_KEYRING/
        );
        await expect(coreOpen(f, room, kind, sealed, wrongAad)).rejects.toBeDefined();
        await expect(coreOpen(f, other, kind, sealed)).rejects.toBeDefined();
        await expect(coreOpen(f, room, kind, flipped(sealed))).rejects.toBeDefined();
      }
    }
  );

  it('after rotation both seal at the new epoch and both still open old-epoch frames', async () => {
    const f = workspace();
    const room: Room = { kind: 'doc', docId: 'session-0001' };
    const kind: Kind = { kind: 'update_batch' };
    const oldCore = await coreSeal(f, room, kind);
    const oldEngine = engineSeal(f.keyring(), f, room, kind);
    f.rotate();
    const rotated = f.keyring(f.owner, [EPOCH0, EPOCH1]);
    const newCore = await coreSeal(f, room, kind);
    const newEngine = engineSeal(rotated, f, room, kind);
    expect([epochOf(oldCore.sealed), epochOf(oldEngine.sealed)]).toEqual([0, 0]);
    expect([epochOf(newCore.sealed), epochOf(newEngine.sealed)]).toEqual([1, 1]);
    for (const sealed of [oldCore, oldEngine, newCore, newEngine]) {
      expect(engineOpen(rotated, f, room, kind, sealed)).toEqual(plaintext);
      expect(await coreOpen(f, room, kind, sealed)).toEqual(plaintext);
    }
  });

  it('opens frames from an author revoked afterwards, and the revoked device cannot seal in core', async () => {
    const f = workspace();
    f.addPhone();
    const room: Room = { kind: 'doc', docId: 'session-0001' };
    const kind: Kind = { kind: 'update_batch' };
    const byPhoneEngine = engineSeal(f.keyring(f.phone), f, room, kind);
    const byPhoneCore = await coreSeal(f, room, kind, f.phone.signer);
    f.revokePhone();
    for (const sealed of [byPhoneEngine, byPhoneCore]) {
      expect(engineOpen(f.keyring(), f, room, kind, sealed)).toEqual(plaintext);
      expect(await coreOpen(f, room, kind, sealed)).toEqual(plaintext);
    }
    await expect(coreSeal(f, room, kind, f.phone.signer)).rejects.toBeDefined();
  });

  it('core refuses a never-admitted engine signer', async () => {
    const f = workspace();
    const stranger = identity(3);
    const k = f.keyring(stranger);
    k.admitWriterPubkey(ENGINE_NAMESPACE, stranger.raw);
    const room: Room = { kind: 'doc', docId: 'session-0001' };
    const kind: Kind = { kind: 'update_batch' };
    const sealed = engineSeal(k, f, room, kind);
    await expect(coreOpen(f, room, kind, sealed)).rejects.toBeDefined();
  });

  it.fails('K2: the keyring holds sealing for a writer without revoking its admission', () => {
    const f = workspace();
    const k = f.keyring() as ContentKeyring & {
      holdSealing?: (namespace: string, writer: string) => void;
    };
    expect(typeof k.holdSealing).toBe('function');
  });
  it.fails('K2: the keyring seals at an explicit seal epoch, not the highest installed one', () => {
    const f = workspace();
    const k = f.keyring(f.owner, [EPOCH0, EPOCH1]) as ContentKeyring & {
      setSealEpoch?: (namespace: string, epoch: number) => void;
    };
    expect(typeof k.setSealEpoch).toBe('function');
  });
});
