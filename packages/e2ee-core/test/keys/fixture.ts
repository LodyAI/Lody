import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { Effect, Result } from 'effect';
import { DhkemX25519HkdfSha256 } from '@hpke/core';
import * as Public from '../../src/protocol';
import * as Envelopes from '@lody/e2ee-core/protocol';
import * as Ledger from '@lody/e2ee-core/protocol';
import * as EpochKeys from '@lody/e2ee-core/protocol';
import { encodeCbor, type CborValue } from '../../src/internal/foundation/cbor';
import { concat } from '../../src/internal/foundation/concat';
import type { DeviceSigner } from '@lody/e2ee-core/protocol';
import vector from '../hpke-vector.json';
const v = vector.epoch;
const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'));
const ok = <A, E>(r: Result.Result<A, E>) => Result.getOrThrow(r);
export async function recipientPair(): Promise<CryptoKeyPair> {
  const kem = new DhkemX25519HkdfSha256();
  return {
    privateKey: await kem.deserializePrivateKey(bytes(v.skR)),
    publicKey: await kem.deserializePublicKey(bytes(v.pkR)),
  };
}
export function envelopeFixture(kind: 0 | 1 | 2 = 0, org = 100) {
  const ed = (n: number) => {
    const privateKey = createPrivateKey({
      key: Buffer.concat([
        Buffer.from('302e020100300506032b657004220420', 'hex'),
        Buffer.alloc(32, n),
      ]),
      format: 'der',
      type: 'pkcs8',
    });
    const raw = new Uint8Array(
      createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32)
    );
    const publicKey = ok(Public.Bytes.signingPublicKey(raw));
    const signBytes = (message: Uint8Array) => new Uint8Array(sign(null, message, privateKey));
    const signer: DeviceSigner = {
      publicKey,
      sign: (message) => Effect.sync(() => ok(Public.Bytes.signature(signBytes(message)))),
    };
    return { raw, publicKey, signBytes, signer };
  };
  const owner = ed(10),
    phone = ed(11);
  const secret = ok(Public.Bytes.epochKey(bytes(v.pt)));
  const dummy = ok(Public.Bytes.genesisHash(new Uint8Array(32).fill(1)));
  const commitment = ok(EpochKeys.commitEpochKey(dummy, 0, secret));
  const tag = (name: string, body: Uint8Array) =>
    concat([new TextEncoder().encode(`lody-e2ee/${name}\0`), body]);
  const signed = (body: CborValue, signer = owner) =>
    ok(encodeCbor([body, signer.signBytes(tag('sig/v1', ok(encodeCbor(body))))]));
  const member = new Uint8Array(16).fill(10);
  const records = [
    signed([
      1,
      owner.raw,
      new Uint8Array(32).fill(10),
      member,
      new Uint8Array(32).fill(org),
      commitment.toBytes(),
    ]),
  ];
  const genesis = ok(Public.Bytes.genesisHash(Ledger.hashRecordBytes(records[0]!).toBytes()));
  const view = () =>
    ok(
      Ledger.verifyLedger({
        anchor: genesis,
        records,
        checkpoint: {
          head: Ledger.hashRecordBytes(records[records.length - 1]!),
          length: records.length,
        },
      })
    );
  const append = (operation: CborValue, signer = owner) =>
    records.push(
      signed(
        [Ledger.hashRecordBytes(records[records.length - 1]!).toBytes(), signer.raw, operation],
        signer
      )
    );
  const machineId = new TextEncoder().encode('fixture-machine');
  const proof = phone.signBytes(
    tag(
      'possess/v2',
      ok(
        encodeCbor([
          genesis.toBytes(),
          member,
          phone.raw,
          bytes(v.pkR),
          kind,
          ...(kind === 1 ? [machineId] : []),
        ])
      )
    )
  );
  append([4, kind, phone.raw, bytes(v.pkR), proof, ...(kind === 1 ? [machineId, null] : [])]);
  const envelopeContext: Envelopes.EpochEnvelopeContext = {
    genesis,
    epoch: ok(Public.Bytes.epochNumber(0)),
    sender: owner.publicKey,
    recipient: phone.publicKey,
  };
  const ledger = () => Effect.sync(view);
  const prepare = (lookup = ledger) =>
    Envelopes.prepareEpochEnvelope({
      context: envelopeContext,
      key: secret,
      signer: owner.signer,
      ledger: lookup,
    });
  const resign = (frame: Uint8Array) => {
    const unsigned = frame.subarray(0, -64);
    return concat([unsigned, owner.signBytes(tag('epoch-env/v1', unsigned))]);
  };
  return {
    owner,
    phone,
    ed,
    secret,
    view,
    append,
    context: envelopeContext,
    ledger,
    prepare,
    resign,
    genesisRecord: new Uint8Array(records[0]!),
    records: () => records.map((record) => new Uint8Array(record)),
  };
}
