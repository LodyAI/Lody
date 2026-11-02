import { describe, expect, it } from 'vitest';
import { Result } from 'effect';
import { gcm } from '@noble/ciphers/aes.js';
import { encode } from '@ipld/dag-cbor';
import { Bytes } from '@lody/e2ee-core/protocol';
import {
  ClientInstallationStore,
  CLIENT_KEY_PURPOSES,
  type ClientCustodyBinding,
  type ClientInstallation,
} from '@lody/e2ee-core/services';
import vector from './client-custody-vector.json';

const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'));
const toHex = (value: Uint8Array) => Buffer.from(value).toString('hex');
const aadValues = (purpose: string): (string | number | Uint8Array)[] => [
  'lody-e2ee/client-custody/v1\0',
  vector.version,
  vector.binding.accountId,
  vector.binding.workspaceId,
  bytes(vector.binding.genesisHex),
  bytes(vector.binding.deviceHex),
  vector.binding.installationId,
  purpose,
];

describe('shared client custody wrapping v1 vectors', () => {
  it('covers exactly every fixed purpose with a distinct nonce under the synthetic KEK', () => {
    expect(vector.vectors.map((item) => item.purpose)).toEqual([...CLIENT_KEY_PURPOSES]);
    expect(new Set(vector.vectors.map((item) => item.nonceHex)).size).toBe(
      CLIENT_KEY_PURPOSES.length
    );
    expect(vector.domainUtf8Hex).toBe(
      toHex(new TextEncoder().encode('lody-e2ee/client-custody/v1\0'))
    );
  });

  it.each(vector.vectors)(
    '$purpose agrees byte-for-byte across CBOR, WebCrypto and noble',
    async (v) => {
      const aad = new Uint8Array(encode(aadValues(v.purpose)));
      expect(toHex(aad)).toBe(v.aadHex);
      const key = await crypto.subtle.importKey('raw', bytes(vector.kekHex), 'AES-GCM', false, [
        'encrypt',
        'decrypt',
      ]);
      const params = {
        name: 'AES-GCM',
        iv: bytes(v.nonceHex),
        additionalData: aad,
        tagLength: 128,
      };
      const cipherAndTag = new Uint8Array(
        await crypto.subtle.encrypt(params, key, bytes(v.plaintextHex))
      );
      expect(toHex(cipherAndTag)).toBe(v.ciphertextHex + v.tagHex);
      expect(toHex(new Uint8Array([1, ...bytes(v.nonceHex), ...cipherAndTag]))).toBe(v.blobHex);
      expect(new Uint8Array(await crypto.subtle.decrypt(params, key, cipherAndTag))).toEqual(
        bytes(v.plaintextHex)
      );
      expect(
        gcm(bytes(vector.kekHex), bytes(v.nonceHex), aad).encrypt(bytes(v.plaintextHex))
      ).toEqual(cipherAndTag);
      expect(gcm(bytes(vector.kekHex), bytes(v.nonceHex), aad).decrypt(cipherAndTag)).toEqual(
        bytes(v.plaintextHex)
      );
      await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
    }
  );

  it.each([
    'domain',
    'version',
    'account',
    'workspace',
    'genesis',
    'device',
    'installation',
    'purpose',
  ] as const)('rejects swapping the authenticated %s', async (field) => {
    const v = vector.vectors[0]!,
      values = aadValues(v.purpose);
    const at = {
      domain: 0,
      version: 1,
      account: 2,
      workspace: 3,
      genesis: 4,
      device: 5,
      installation: 6,
      purpose: 7,
    }[field];
    const old = values[at]!;
    values[at] =
      typeof old === 'string'
        ? old + 'x'
        : typeof old === 'number'
          ? old + 1
          : new Uint8Array(32).fill(0x77);
    const key = await crypto.subtle.importKey('raw', bytes(vector.kekHex), 'AES-GCM', false, [
      'decrypt',
    ]);
    await expect(
      crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: bytes(v.nonceHex),
          tagLength: 128,
          additionalData: new Uint8Array(encode(values)),
        },
        key,
        bytes(v.ciphertextHex + v.tagHex)
      )
    ).rejects.toThrow();
  });

  it('rejects ciphertext/tag corruption and interchanged purpose wrappers', async () => {
    const key = await crypto.subtle.importKey('raw', bytes(vector.kekHex), 'AES-GCM', false, [
      'decrypt',
    ]);
    for (const v of vector.vectors) {
      for (const at of [0, bytes(v.ciphertextHex + v.tagHex).length - 1]) {
        const changed = bytes(v.ciphertextHex + v.tagHex);
        changed[at] ^= 1;
        await expect(
          crypto.subtle.decrypt(
            {
              name: 'AES-GCM',
              iv: bytes(v.nonceHex),
              additionalData: bytes(v.aadHex),
              tagLength: 128,
            },
            key,
            changed
          )
        ).rejects.toThrow();
      }
      for (const other of vector.vectors.filter((item) => item.purpose !== v.purpose))
        await expect(
          crypto.subtle.decrypt(
            {
              name: 'AES-GCM',
              iv: bytes(v.nonceHex),
              additionalData: bytes(other.aadHex),
              tagLength: 128,
            },
            key,
            bytes(v.ciphertextHex + v.tagHex)
          )
        ).rejects.toThrow();
    }
  });
});

const binding = (replacement = false): ClientCustodyBinding => ({
  accountId: 'synthetic-account',
  workspaceId: 'synthetic-workspace',
  genesis: Result.getOrThrow(Bytes.genesisHash(new Uint8Array(32).fill(1))),
  device: Result.getOrThrow(
    Bytes.signingPublicKey(
      new Uint8Array(
        Buffer.from(
          replacement
            ? '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c'
            : 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
          'hex'
        )
      )
    )
  ),
  installationId: (replacement ? '22' : '11').repeat(32),
});
const original = (replacement = false): ClientInstallation => ({
  binding: binding(replacement),
  revision: replacement ? 5 : 4,
  phase: replacement ? 'protected' : 'retired',
  wrapped: ['signing-private-key', 'encryption-private-key', 'device-credential'].map(
    (purpose, index) => ({
      purpose: purpose as ClientInstallation['wrapped'][number]['purpose'],
      blob: new Uint8Array([1, ...new Uint8Array(60).fill((replacement ? 20 : 10) + index)]),
    })
  ),
});

describe('client installation replacement contract', () => {
  it('archives an unusable old wrapper unchanged instead of blocking desktop-approved recovery', () => {
    const old = original();
    old.wrapped[0]!.blob[0] = 0xff;
    const plan = Result.getOrThrow(
      ClientInstallationStore.prepareReplacement(
        old,
        {
          revision: old.revision,
          binding: old.binding,
        },
        original(true)
      )
    );
    expect(plan.retired.wrapped[0]!.blob).toEqual(old.wrapped[0]!.blob);
    expect(plan.current.binding).toEqual(binding(true));
  });
  it('can switch a retired lost-KEK identity after reapproval without destroying its originals', () => {
    const old = original(),
      next = original(true);
    const plan = Result.getOrThrow(
      ClientInstallationStore.prepareReplacement(
        old,
        {
          revision: old.revision,
          binding: old.binding,
        },
        next
      )
    );
    expect(plan.current).toEqual(next);
    expect(plan.retired).toEqual(old);
    // The plan owns copies, so caller mutation cannot rewrite the archived original.
    next.wrapped[0]!.blob.fill(0);
    old.wrapped[0]!.blob.fill(0);
    expect(plan.current.wrapped[0]!.blob[0]).toBe(1);
    expect(plan.retired.wrapped[0]!.blob[0]).toBe(1);
  });

  it('does not let a late old writer replace the selected successor or roll its revision back', () => {
    const old = original(),
      next = original(true);
    const expected = { revision: old.revision, binding: old.binding };
    const first = Result.getOrThrow(
      ClientInstallationStore.prepareReplacement(old, expected, next)
    );
    expect(ClientInstallationStore.prepareReplacement(first.current, expected, next)).toMatchObject(
      { _tag: 'Failure', failure: { reason: 'conflict' } }
    );
    const advanced = { ...first.current, phase: 'retired' as const, revision: 6 };
    expect(
      ClientInstallationStore.prepareReplacement(advanced, expected, { ...next, revision: 5 })
    ).toMatchObject({ _tag: 'Failure', failure: { reason: 'conflict' } });
    expect(first.retired).toEqual(old);
    expect(first.current).toEqual(next);
  });

  it.each(['revision', 'device', 'installation', 'account', 'workspace', 'genesis'] as const)(
    'refuses a stale or misbound replacement precondition (%s)',
    (field) => {
      const old = original(),
        expected = { revision: old.revision, binding: { ...old.binding } };
      if (field === 'revision') expected.revision--;
      else if (field === 'device') expected.binding.device = binding(true).device;
      else if (field === 'installation')
        expected.binding.installationId = binding(true).installationId;
      else if (field === 'account') expected.binding.accountId = 'another-account';
      else if (field === 'workspace') expected.binding.workspaceId = 'another-workspace';
      else
        expected.binding.genesis = Result.getOrThrow(Bytes.genesisHash(new Uint8Array(32).fill(2)));
      expect(
        ClientInstallationStore.prepareReplacement(old, expected, original(true))
      ).toMatchObject({ _tag: 'Failure', failure: { reason: 'conflict' } });
      expect(old).toEqual(original());
    }
  );

  it.each([
    'live',
    'same-device',
    'same-installation',
    'wrong-scope',
    'old-revision',
    'empty',
    'duplicate-purpose',
  ] as const)(
    'refuses replacement without retirement, a fresh identity and complete wrappers (%s)',
    (kind) => {
      const old = original(),
        next = original(true);
      const current = kind === 'live' ? { ...old, phase: 'ready' as const } : old;
      const changed =
        kind === 'same-device'
          ? { ...next, binding: { ...next.binding, device: old.binding.device } }
          : kind === 'same-installation'
            ? { ...next, binding: { ...next.binding, installationId: old.binding.installationId } }
            : kind === 'wrong-scope'
              ? { ...next, binding: { ...next.binding, workspaceId: 'other' } }
              : kind === 'old-revision'
                ? { ...next, revision: 0 }
                : kind === 'empty'
                  ? { ...next, wrapped: [] }
                  : kind === 'duplicate-purpose'
                    ? { ...next, wrapped: [next.wrapped[0]!, next.wrapped[0]!, next.wrapped[2]!] }
                    : next;
      expect(
        Result.isFailure(
          ClientInstallationStore.prepareReplacement(
            current,
            {
              revision: old.revision,
              binding: old.binding,
            },
            changed
          )
        )
      ).toBe(true);
      expect(old).toEqual(original());
    }
  );
});
