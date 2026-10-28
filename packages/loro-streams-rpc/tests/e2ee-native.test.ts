import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect } from 'effect';
import { decodeE2eeRpcResponseBody, encodeE2eeRpcResponseBody } from '../src/e2ee-wire';
import { e2eeRpcResource } from '../src/e2ee-resource';
import { encryptedRpcFixture } from './fixtures/e2ee-native-fixture';
import { makeRealtimeContentBinding } from '@lody/e2ee-core/adapters/loro-streams';
import { Bytes } from '@lody/e2ee-core/protocol';
import { Result } from 'effect';
import { copyEpochKeyBytes } from '../../e2ee-core/src/internal/foundation/epoch-key';

const fixtures: ReturnType<typeof encryptedRpcFixture>[] = [];
const fixture = () => {
  const value = encryptedRpcFixture();
  fixtures.push(value);
  return value;
};
afterEach(() => {
  for (const value of fixtures.splice(0)) value.close();
});

describe('trusted-host encrypted dispatch originals', () => {
  it('persists an original before returning it and reopens exact ID/ciphertext without re-signing', async () => {
    const f = fixture();
    const first = await Effect.runPromise(f.sender.prepareDispatch(f.machineId, f.input));
    const reopened = f.native('owner');
    expect(await Effect.runPromise(reopened.prepareDispatch(f.machineId, f.input))).toEqual(first);
    const opened = await Effect.runPromise(f.receiver.openDispatch(f.machineId, first.frameHex));
    expect(opened.args).toEqual(f.input);
    expect(opened.requestId).toBe(first.requestId);
    expect(opened.requesterDevice).toBe(Buffer.from(f.ledger.owner.raw).toString('hex'));
    expect(
      Buffer.from(first.frameHex, 'hex').includes(Buffer.from(f.input.inputConfig.prompt))
    ).toBe(false);
    expect(
      readFileSync(join(f.directory, 'owner.sqlite')).includes(
        Buffer.from(f.input.inputConfig.prompt)
      )
    ).toBe(false);
    await expect(
      Effect.runPromise(
        reopened.prepareDispatch(f.machineId, { ...f.input, inputConfig: { prompt: 'different' } })
      )
    ).rejects.toThrow('intent_conflict');
    expect(await Effect.runPromise(reopened.prepareDispatch(f.machineId, f.input))).toEqual(first);
  });

  it('accepts only the original target-signed ACK and retains its exact bytes across reopen', async () => {
    const f = fixture();
    const original = await Effect.runPromise(f.sender.prepareDispatch(f.machineId, f.input));
    const opened = await Effect.runPromise(f.receiver.openDispatch(f.machineId, original.frameHex));
    const response = await Effect.runPromise(f.receiver.sealAck(f.machineId, opened, f.ack));
    const frameHex = Buffer.from(response).toString('hex');
    expect(
      await Effect.runPromise(f.sender.acceptResponse(f.machineId, f.input, frameHex))
    ).toEqual(f.ack);
    expect(
      await Effect.runPromise(f.native('owner').acceptResponse(f.machineId, f.input, frameHex))
    ).toEqual(f.ack);
    // An otherwise valid member knows the epoch key but cannot impersonate the target machine.
    const impostor = await Effect.runPromise(f.sender.sealAck(f.machineId, opened, f.ack));
    await expect(
      Effect.runPromise(
        f.sender.acceptResponse(f.machineId, f.input, Buffer.from(impostor).toString('hex'))
      )
    ).rejects.toThrow();
    const replacement = await Effect.runPromise(
      f.receiver.sealAck(f.machineId, opened, { ...f.ack, disposition: 'duplicate' })
    );
    await expect(
      Effect.runPromise(
        f.sender.acceptResponse(f.machineId, f.input, Buffer.from(replacement).toString('hex'))
      )
    ).rejects.toThrow();
  });

  it('rejects validly signed replies bound to another request/digest/kind/sequence', async () => {
    const f = fixture();
    const original = await Effect.runPromise(f.sender.prepareDispatch(f.machineId, f.input));
    const opened = await Effect.runPromise(f.receiver.openDispatch(f.machineId, original.frameHex));
    const valid = await Effect.runPromise(f.receiver.sealAck(f.machineId, opened, f.ack));
    const plaintext = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const binding = yield* makeRealtimeContentBinding({
            genesis: f.ledger.context.genesis,
            resource: e2eeRpcResource(f.machineId),
            signer: f.ledger.phone.signer,
            ledger: f.ledger.ledger,
            readEpochKey: () =>
              Effect.sync(() =>
                Result.getOrThrow(Bytes.epochKey(copyEpochKeyBytes(f.ledger.secret)))
              ),
          });
          return (yield* binding.openResponse(
            valid,
            Buffer.from(f.ledger.phone.raw).toString('hex'),
            0
          )).plaintext;
        })
      )
    );
    const body = decodeE2eeRpcResponseBody(plaintext);
    plaintext.fill(0);
    for (const change of [
      { requestId: new Uint8Array(16).fill(1) },
      { requestDigest: new Uint8Array(32).fill(2) },
      { kind: 'success' as const },
      { sequence: 1 },
    ]) {
      const forged = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const binding = yield* makeRealtimeContentBinding({
              genesis: f.ledger.context.genesis,
              resource: e2eeRpcResource(f.machineId),
              signer: f.ledger.phone.signer,
              ledger: f.ledger.ledger,
              readEpochKey: () =>
                Effect.sync(() =>
                  Result.getOrThrow(Bytes.epochKey(copyEpochKeyBytes(f.ledger.secret)))
                ),
            });
            return yield* binding.sealResponse(
              encodeE2eeRpcResponseBody({ ...body, ...change }),
              0
            );
          })
        )
      );
      await expect(
        Effect.runPromise(
          f.sender.acceptResponse(f.machineId, f.input, Buffer.from(forged).toString('hex'))
        )
      ).rejects.toThrow('response_binding');
    }
    body.payload.fill(0);
  });

  it('uses exact UTF-8 machine identities and refuses unsupported targets or oversized inputs', async () => {
    expect(e2eeRpcResource('a')).toBe('rpc:YQ');
    expect(e2eeRpcResource('机器')).toBe('rpc:5py65Zmo');
    expect(e2eeRpcResource('\ufeffa')).not.toBe(e2eeRpcResource('a'));
    expect(e2eeRpcResource('a'.repeat(256)).length).toBe(346);
    for (const id of ['', 'a'.repeat(257), '\ud800']) expect(() => e2eeRpcResource(id)).toThrow();
    const f = fixture();
    await expect(
      Effect.runPromise(f.sender.prepareDispatch('other-machine', f.input))
    ).rejects.toThrow('not_owned');
    await expect(
      Effect.runPromise(
        f.sender.prepareDispatch(f.machineId, {
          ...f.input,
          inputConfig: { prompt: 'a'.repeat(1024 * 1024) },
        })
      )
    ).rejects.toThrow();
    const first = await Effect.runPromise(f.sender.prepareDispatch(f.machineId, f.input));
    await expect(
      Effect.runPromise(f.receiver.openDispatch('other-machine', first.frameHex))
    ).rejects.toThrow();
  });
});
