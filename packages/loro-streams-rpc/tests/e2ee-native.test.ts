import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSessionTurnInputConfig } from '../../shared/src/session-input';
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
  it('retains signed read-query originals and final responses without an execution journal', async () => {
    const f = fixture();
    const input = { queryId: 'synthetic-query', method: 'machine/status' as const, params: {} };
    const original = await Effect.runPromise(f.sender.prepareQuery(f.machineId, input));
    expect(await Effect.runPromise(f.native('owner').prepareQuery(f.machineId, input))).toEqual(
      original
    );
    const opened = await Effect.runPromise(f.receiver.openQuery(f.machineId, original.frameHex));
    await Effect.runPromise(f.receiver.retainQueryRequest(f.machineId, opened));
    await Effect.runPromise(f.receiver.retainQueryRequest(f.machineId, opened));
    await expect(
      Effect.runPromise(
        f.receiver.retainQueryRequest(f.machineId, {
          ...opened,
          frame: Uint8Array.from([...opened.frame, 0]),
        })
      )
    ).rejects.toThrow();
    const response = await Effect.runPromise(
      f.receiver.queryResponse(f.machineId, opened, {
        result: { synthetic: 'PRIVATE_QUERY_CANARY' },
      })
    );
    const frame = Buffer.from(response[0]!).toString('hex');
    expect(response[0]!.length).toBeLessThanOrEqual(1048576);
    expect(Buffer.from(response[0]!).includes(Buffer.from('PRIVATE_QUERY_CANARY'))).toBe(false);
    expect(
      await Effect.runPromise(f.sender.acceptQueryResponse(f.machineId, input, frame))
    ).toEqual({ result: { synthetic: 'PRIVATE_QUERY_CANARY' } });
    expect(
      await Effect.runPromise(
        f.native('phone').queryResponse(f.machineId, opened, { result: 'changed' })
      )
    ).toEqual(response);
    await expect(
      Effect.runPromise(
        f.sender.prepareQuery(f.machineId, { ...input, method: 'machine/restart' as never })
      )
    ).rejects.toThrow();
    await expect(
      Effect.runPromise(
        f.sender.prepareQuery(f.machineId, {
          queryId: 'forbidden-memory-write',
          method: 'machine/memory',
          params: {
            action: 'create',
            providerId: 'synthetic',
            input: { name: 'synthetic', path: '/synthetic' },
          },
        })
      )
    ).rejects.toThrow();
  });

  it('pages an oversized result, waits through missing/out-of-order pages, and preserves exact retry bytes', async () => {
    const f = fixture();
    const input = { queryId: 'paged-query', method: 'machine/status' as const, params: {} };
    const original = await Effect.runPromise(f.sender.prepareQuery(f.machineId, input));
    const request = await Effect.runPromise(f.receiver.openQuery(f.machineId, original.frameHex));
    const result = { result: { text: '合成'.repeat(300000) } };
    const frames = await Effect.runPromise(f.receiver.queryResponse(f.machineId, request, result));
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) expect(frame.length).toBeLessThanOrEqual(1048576);
    const accept = (index: number) =>
      Effect.runPromise(
        f.sender.acceptQueryResponse(
          f.machineId,
          input,
          Buffer.from(frames[index]!).toString('hex')
        )
      );
    expect(await accept(frames.length - 1)).toBeNull();
    for (let index = 0; index < frames.length - 2; index++) expect(await accept(index)).toBeNull();
    expect(await accept(frames.length - 2)).toEqual(result);
    expect(
      await Effect.runPromise(
        f.native('phone').queryResponse(f.machineId, request, { result: 'replacement' })
      )
    ).toEqual(frames);
    const reopened = f.native('owner');
    expect(
      await Effect.runPromise(
        reopened.acceptQueryResponse(f.machineId, input, Buffer.from(frames[0]!).toString('hex'))
      )
    ).toEqual(result);
    await expect(
      Effect.runPromise(f.sender.prepareQuery('different-machine', input))
    ).rejects.toThrow();
  });

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

  it('retains one original for real composer configs with undefined optional fields', async () => {
    const f = fixture();
    const inputConfig = buildSessionTurnInputConfig({
      inputBlocks: [{ type: 'text', text: 'Synthetic composer input' }],
      cliType: 'builtin',
      agentType: 'codex',
    });
    expect(Object.hasOwn(inputConfig, 'modelId')).toBe(true);
    expect(inputConfig.modelId).toBeUndefined();
    const input = { ...f.input, inputConfig };
    const canonical = JSON.parse(JSON.stringify(input));
    const original = await Effect.runPromise(f.sender.prepareDispatch(f.machineId, input));
    const reopened = f.native('owner');
    expect(await Effect.runPromise(reopened.prepareDispatch(f.machineId, canonical))).toEqual(
      original
    );
    expect(await Effect.runPromise(reopened.prepareDispatch(f.machineId, input))).toEqual(original);
    const opened = await Effect.runPromise(f.receiver.openDispatch(f.machineId, original.frameHex));
    expect(opened.args).toStrictEqual(canonical);
    await expect(
      Effect.runPromise(
        reopened.prepareDispatch(f.machineId, {
          ...input,
          inputConfig: { ...inputConfig, prompt: 'changed composer input' },
        })
      )
    ).rejects.toThrow('intent_conflict');
    expect(await Effect.runPromise(reopened.prepareDispatch(f.machineId, input))).toEqual(original);
  });

  it('accepts ACKs using the same composer JSON representation without replacing stored originals', async () => {
    const f = fixture();
    const input = {
      ...f.input,
      inputConfig: buildSessionTurnInputConfig({
        inputBlocks: [{ type: 'text', text: 'Synthetic composer ACK' }],
        cliType: 'builtin',
        agentType: 'codex',
      }),
    };
    // Seed a JSON wire original to independently exercise response acceptance.
    const original = await Effect.runPromise(
      f.sender.prepareDispatch(f.machineId, JSON.parse(JSON.stringify(input)))
    );
    const opened = await Effect.runPromise(f.receiver.openDispatch(f.machineId, original.frameHex));
    const response = await Effect.runPromise(f.receiver.sealAck(f.machineId, opened, f.ack));
    const responseHex = Buffer.from(response).toString('hex');
    const reopened = f.native('owner');
    expect(
      await Effect.runPromise(reopened.acceptResponse(f.machineId, input, responseHex))
    ).toEqual(f.ack);
    expect(await Effect.runPromise(reopened.prepareDispatch(f.machineId, input))).toEqual(original);
    await expect(
      Effect.runPromise(
        reopened.acceptResponse(
          f.machineId,
          {
            ...input,
            inputConfig: { ...input.inputConfig, prompt: 'conflicting ACK intent' },
          },
          responseHex
        )
      )
    ).rejects.toThrow('intent_conflict');
    expect(
      await Effect.runPromise(f.sender.acceptResponse(f.machineId, input, responseHex))
    ).toEqual(f.ack);
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
