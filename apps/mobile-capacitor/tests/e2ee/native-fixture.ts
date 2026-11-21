import { Result } from 'effect';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { encode } from '@ipld/dag-cbor';
import { Bytes } from '@lody/e2ee-core/protocol';
import type { NativeBinding, NativeKekBridge } from '../../src/e2ee/native-custody';
export const nativeAad = (a: NativeBinding & { purpose: string }) =>
  encode([
    'lody-e2ee/client-custody/v1\0',
    1,
    a.accountId,
    a.workspaceId,
    raw(a.genesisHash),
    raw(a.deviceId),
    a.installationId,
    a.purpose,
  ]);
export const vector = JSON.parse(
  readFileSync(new URL('../fixtures/client-custody-vector.json', import.meta.url), 'utf8')
) as {
  kekHex: string;
  binding: {
    accountId: string;
    workspaceId: string;
    genesisHex: string;
    deviceHex: string;
    installationId: string;
  };
  vectors: { purpose: string; plaintextHex: string; aadHex: string; blobHex: string }[];
};
export const raw = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));
export const binding = {
  accountId: vector.binding.accountId,
  workspaceId: vector.binding.workspaceId,
  genesis: Result.getOrThrow(Bytes.genesisHash(raw(vector.binding.genesisHex))),
  device: Result.getOrThrow(Bytes.signingPublicKey(raw(vector.binding.deviceHex))),
  installationId: vector.binding.installationId,
};
export const args: NativeBinding = {
  accountId: binding.accountId,
  workspaceId: binding.workspaceId,
  genesisHash: vector.binding.genesisHex,
  deviceId: vector.binding.deviceHex,
  installationId: binding.installationId,
};
export const payload = raw(vector.vectors[0]!.plaintextHex);
export const record = (a: NativeBinding) =>
  JSON.stringify([a.accountId, a.workspaceId, a.genesisHash, a.deviceId, a.installationId]);
export class NativeFixture implements NativeKekBridge {
  keys = new Set<string>();
  wraps = 0;
  version = 1;
  fail = '';
  failAfterWrap = false;
  async status(a: NativeBinding) {
    if (this.fail) throw { code: this.fail };
    return {
      state: this.keys.has(record(a)) ? 'ready' : 'missing',
      version: this.version,
      installationId: a.installationId,
    };
  }
  async install(a: NativeBinding) {
    this.keys.add(record(a));
    return { state: 'ready', version: this.version, installationId: a.installationId };
  }
  async wrap(a: NativeBinding & { purpose: string; plaintext: string }) {
    if (!this.keys.has(record(a))) throw { code: 'REAPPROVAL_REQUIRED' };
    this.wraps++;
    const nonce = Buffer.alloc(12);
    nonce.writeUInt32BE(this.wraps, 8);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(vector.kekHex, 'hex'), nonce);
    cipher.setAAD(Buffer.from(nativeAad(a)));
    const encrypted = Buffer.concat([
      cipher.update(Buffer.from(a.plaintext, 'base64')),
      cipher.final(),
    ]);
    const blob = Buffer.concat([Buffer.of(1), nonce, encrypted, cipher.getAuthTag()]);
    if (this.failAfterWrap) throw { code: 'PROTECTION_UNAVAILABLE' };
    return { wrapped: blob.toString('base64') };
  }
  async unwrap(a: NativeBinding & { purpose: string; wrapped: string }) {
    if (!this.keys.has(record(a))) throw { code: 'REAPPROVAL_REQUIRED' };
    const b = Buffer.from(a.wrapped, 'base64');
    const cipher = createDecipheriv(
      'aes-256-gcm',
      Buffer.from(vector.kekHex, 'hex'),
      b.subarray(1, 13)
    );
    cipher.setAAD(Buffer.from(nativeAad(a)));
    cipher.setAuthTag(b.subarray(-16));
    return {
      plaintext: Buffer.concat([cipher.update(b.subarray(13, -16)), cipher.final()]).toString(
        'base64'
      ),
    };
  }
  async delete(a: NativeBinding) {
    this.keys.delete(record(a));
    return { state: 'deleted' };
  }
}
