import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSessionTurnInputConfig } from '../../shared/src/session-input';
import { Effect } from 'effect';
import {
  decodeE2eeRpcResponseBody,
  encodeE2eeRpcResponseBody,
  encodeE2eeRpcRequestBody,
} from '../src/e2ee-wire';
import { e2eeRpcResource } from '../src/e2ee-resource';
import { E2eeRpcOriginals, e2eeRpcDigest } from '../src/e2ee-native';
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
  it('rejects a valid old Guest-signed Pi query at the receiving host before retaining or executing it', async () => {
    const f = encryptedRpcFixture({ guest: true });
    fixtures.push(f);
    const frame = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const binding = yield* makeRealtimeContentBinding({
            genesis: f.ledger.context.genesis,
            resource: e2eeRpcResource(f.machineId),
            signer: f.ledger.owner.signer,
            ledger: f.ledger.ledger,
            readEpochKey: () =>
              Effect.sync(() =>
                Result.getOrThrow(Bytes.epochKey(copyEpochKeyBytes(f.ledger.secret)))
              ),
          });
          return yield* binding.sealRequest(
            encodeE2eeRpcRequestBody({
              requestId: new Uint8Array(16).fill(42),
              expiresAt: 60_000,
              method: 'machine/pi-extensions',
              params: new TextEncoder().encode(
                JSON.stringify({ queryId: 'old-guest', params: {} })
              ),
            })
          );
        })
      )
    );
    await expect(
      Effect.runPromise(f.receiver.openFeature(f.machineId, Buffer.from(frame).toString('hex')))
    ).rejects.toThrow();
  });
  it('retains read request/response originals without an execution journal', async () => {
    const f = fixture();
    const input = {
      requestId: '11'.repeat(16),
      request: {
        workspaceId: f.workspaceId,
        machineId: f.machineId,
        method: 'machine/status' as const,
        params: {},
      },
    };
    const original = await Effect.runPromise(f.sender.prepareFeature(input));
    expect(await Effect.runPromise(f.native('owner').prepareFeature(input))).toEqual(original);
    const opened = await Effect.runPromise(f.receiver.openFeature(f.machineId, original.frameHex));
    if (!opened) throw new Error('missing request');
    await Effect.runPromise(f.receiver.retainFeatureRequest(f.machineId, opened));
    await Effect.runPromise(f.receiver.retainFeatureRequest(f.machineId, opened));
    await expect(
      Effect.runPromise(
        f.receiver.retainFeatureRequest(f.machineId, {
          ...opened,
          frame: Uint8Array.from([...opened.frame, 0]),
        })
      )
    ).rejects.toThrow();
    const result = { ok: false as const, error: 'PRIVATE_QUERY_CANARY' };
    const response = await Effect.runPromise(
      f.receiver.sealFeatureResult(f.machineId, opened, result)
    );
    expect(response[0]?.length).toBeLessThanOrEqual(1048576);
    expect(Buffer.from(response[0] ?? []).includes(Buffer.from('PRIVATE_QUERY_CANARY'))).toBe(
      false
    );
    expect(
      await Effect.runPromise(
        f.sender.acceptFeatureResponse(input, Buffer.from(response[0] ?? []).toString('hex'))
      )
    ).toEqual(result);
    expect(
      await Effect.runPromise(
        f.native('phone').sealFeatureResult(f.machineId, opened, { ok: false, error: 'changed' })
      )
    ).toEqual(response);
    for (const method of ['machine/restart', 'machine/memory'])
      await expect(
        Effect.runPromise(
          f.sender.prepareFeature({ ...input, request: { ...input.request, method } } as never)
        )
      ).rejects.toThrow();
  });

  it('waits for every signed page, including across reopen, and returns an explicit error above 16 MiB', async () => {
    const f = fixture();
    const input = {
      requestId: '12'.repeat(16),
      request: {
        workspaceId: f.workspaceId,
        machineId: f.machineId,
        method: 'machine/status' as const,
        params: {},
      },
    };
    const original = await Effect.runPromise(f.sender.prepareFeature(input));
    const opened = await Effect.runPromise(f.receiver.openFeature(f.machineId, original.frameHex));
    if (!opened) throw new Error('missing request');
    const result = { ok: false as const, error: '合成'.repeat(300_000) };
    const frames = await Effect.runPromise(
      f.receiver.sealFeatureResult(f.machineId, opened, result)
    );
    expect(frames.length).toBeGreaterThan(1);
    const accept = (index: number) =>
      Effect.runPromise(
        f.sender.acceptFeatureResponse(input, Buffer.from(frames[index] ?? []).toString('hex'))
      );
    expect(await accept(frames.length - 1)).toBeNull();
    for (let index = 0; index < frames.length - 2; index++) expect(await accept(index)).toBeNull();
    expect(await accept(frames.length - 2)).toEqual(result);
    expect(
      await Effect.runPromise(
        f.native('owner').acceptFeatureResponse(input, Buffer.from(frames[0] ?? []).toString('hex'))
      )
    ).toEqual(result);
    expect(
      await Effect.runPromise(
        f
          .native('phone')
          .sealFeatureResult(f.machineId, opened, { ok: false, error: 'replacement' })
      )
    ).toEqual(frames);
    const large = { ...input, requestId: '13'.repeat(16) };
    const prepared = await Effect.runPromise(f.sender.prepareFeature(large));
    const request = await Effect.runPromise(f.receiver.openFeature(f.machineId, prepared.frameHex));
    if (!request) throw new Error('missing request');
    const rejected = await Effect.runPromise(
      f.receiver.sealFeatureResult(f.machineId, request, {
        ok: false,
        error: 'x'.repeat(16 * 1024 * 1024),
      })
    );
    expect(
      await Effect.runPromise(
        f.sender.acceptFeatureResponse(large, Buffer.from(rejected[0] ?? []).toString('hex'))
      )
    ).toMatchObject({
      ok: false,
      code: 'e2ee_query_too_large',
      data: { truncated: true, maxBytes: 16 * 1024 * 1024 },
    });
  });

  it('reuses every sealed feature response byte after an uncertain atomic outbox write', async () => {
    const f = fixture();
    const input = {
      requestId: '14'.repeat(16),
      request: {
        workspaceId: f.workspaceId,
        machineId: f.machineId,
        method: 'machine/status' as const,
        params: {},
      },
    };
    const original = await Effect.runPromise(f.sender.prepareFeature(input));
    const opened = await Effect.runPromise(f.receiver.openFeature(f.machineId, original.frameHex));
    if (!opened) throw new Error('missing request');
    const retain = E2eeRpcOriginals.prototype.retainResponsePages;
    let sealed: Uint8Array[] = [];
    const fault = vi
      .spyOn(E2eeRpcOriginals.prototype, 'retainResponsePages')
      .mockImplementationOnce(function (this: E2eeRpcOriginals, key, frames) {
        sealed = frames.map((frame) => Uint8Array.from(frame));
        retain.call(this, key, frames);
        throw new Error('synthetic uncertain commit');
      });
    try {
      await expect(
        Effect.runPromise(
          f.receiver.sealFeatureResult(f.machineId, opened, {
            ok: false,
            error: 'PRIVATE_OUTBOX'.repeat(30_000),
          })
        )
      ).rejects.toThrow();
    } finally {
      fault.mockRestore();
    }
    expect(sealed.length).toBeGreaterThan(1);
    expect(await Effect.runPromise(f.receiver.readFeatureResponse(opened))).toEqual(sealed);
    expect(
      await Effect.runPromise(
        f
          .native('phone')
          .sealFeatureResult(f.machineId, opened, { ok: false, error: 'replacement' })
      )
    ).toEqual(sealed);
    let completed;
    for (const frame of sealed)
      completed = await Effect.runPromise(
        f.sender.acceptFeatureResponse(input, Buffer.from(frame).toString('hex'))
      );
    expect(completed).toEqual({ ok: false, error: 'PRIVATE_OUTBOX'.repeat(30_000) });
  });

  it.each(['before', 'after'] as const)(
    'recovers outbox faults %s commit without exhausting later Guest reads',
    async (phase) => {
      const f = encryptedRpcFixture({ guest: true });
      fixtures.push(f);
      const retain = E2eeRpcOriginals.prototype.retainResponsePages;
      for (let index = 0; index < 33; index++) {
        const input = {
          requestId: index.toString(16).padStart(32, '0'),
          request: {
            workspaceId: f.workspaceId,
            machineId: f.machineId,
            method: 'machine/status' as const,
            params: {},
          },
        };
        const prepared = await Effect.runPromise(f.sender.prepareFeature(input));
        const opened = await Effect.runPromise(
          f.receiver.openFeature(f.machineId, prepared.frameHex)
        );
        if (!opened) throw new Error('missing request');
        const fault = vi
          .spyOn(E2eeRpcOriginals.prototype, 'retainResponsePages')
          .mockImplementation(function (this: E2eeRpcOriginals, key, frames) {
            const current =
              key ===
              `feature-response:${Buffer.from(e2eeRpcDigest(opened.frame)).toString('hex')}`;
            if (current && phase === 'before') throw new Error('synthetic uncommitted write');
            retain.call(this, key, frames);
            if (current) throw new Error('synthetic uncertain commit');
          });
        try {
          await expect(
            Effect.runPromise(
              f.receiver.sealFeatureResult(f.machineId, opened, {
                ok: false,
                error: 'synthetic read outcome',
              })
            )
          ).rejects.toThrow();
        } finally {
          fault.mockRestore();
        }
        if (index !== 32) continue;
        const saved = await Effect.runPromise(f.receiver.readFeatureResponse(opened));
        expect(saved).toHaveLength(1);
        expect(
          await Effect.runPromise(
            f.sender.acceptFeatureResponse(input, Buffer.from(saved[0]!).toString('hex'))
          )
        ).toEqual({ ok: false, error: 'synthetic read outcome' });
      }
    }
  );

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

it('protects feature requests and chunked results with workspace signatures and exact retained originals', async () => {
  const f = fixture();
  const input = {
    requestId: '77'.repeat(16),
    request: {
      workspaceId: f.workspaceId,
      machineId: f.machineId,
      method: 'code-collab/open-text' as const,
      params: { sessionId: f.input.sessionId, path: 'private.ts' },
    },
  };
  const original = await Effect.runPromise(f.sender.prepareFeature(input));
  expect(await Effect.runPromise(f.sender.prepareFeature(input))).toEqual(original);
  const opened = await Effect.runPromise(f.receiver.openFeature(f.machineId, original.frameHex));
  expect(opened?.input).toEqual(input);
  const result = { ok: false as const, error: 'SYNTHETIC_PRIVATE_FILE'.repeat(60_000) };
  const frames = await Effect.runPromise(
    f.receiver.sealFeatureResult(f.machineId, opened!, result)
  );
  expect(frames.length).toBeGreaterThan(1);
  let outcome;
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index];
    if (!frame) throw new Error('missing response');
    expect(frame.length).toBeLessThanOrEqual(1048576);
    expect(Buffer.from(frame).includes(Buffer.from('SYNTHETIC_PRIVATE_FILE'))).toBe(false);
    outcome = await Effect.runPromise(
      f.sender.acceptFeatureResponse(input, Buffer.from(frame).toString('hex'))
    );
    if (index < frames.length - 1) expect(outcome).toBeNull();
  }
  expect(outcome).toEqual(result);
  await expect(
    Effect.runPromise(
      f.sender.prepareFeature({
        ...input,
        request: {
          ...input.request,
          method: 'file/resolve-local',
        },
      } as never)
    )
  ).rejects.toThrow();
  await expect(
    Effect.runPromise(
      f.sender.prepareFeature({
        ...input,
        request: {
          ...input.request,
          params: { ...input.request.params, path: 'changed.ts' },
        },
      })
    )
  ).rejects.toThrow('intent_conflict');
});

it('reassembles a large save from signed chunks and rejects a response from another request', async () => {
  const f = fixture();
  const text = 'SYNTHETIC_LARGE_SAVE_'.repeat(80_000);
  const input = {
    requestId: '66'.repeat(16),
    request: {
      workspaceId: f.workspaceId,
      machineId: f.machineId,
      method: 'code-collab/save-text' as const,
      params: {
        sessionId: f.input.sessionId,
        requestedByUserId: 'owner',
        path: 'private.ts',
        baseDigest: 'sha256:' + '11'.repeat(32),
        text: { encoding: 'plain' as const, text, rawBytes: text.length },
      },
    },
  };
  const original = await Effect.runPromise(f.sender.prepareFeature(input));
  expect(original.frames!.length).toBeGreaterThan(1);
  let opened;
  for (const frame of [...original.frames!].reverse()) {
    opened = await Effect.runPromise(f.receiver.openFeature(f.machineId, frame));
  }
  expect(opened?.input).toEqual(input);
  const frames = await Effect.runPromise(
    f.receiver.sealFeatureResult(f.machineId, opened!, { ok: false, error: 'synthetic outcome' })
  );
  const changed = { ...input, requestId: '88'.repeat(16) };
  await Effect.runPromise(f.sender.prepareFeature(changed));
  await expect(
    Effect.runPromise(
      f.sender.acceptFeatureResponse(changed, Buffer.from(frames[0]!).toString('hex'))
    )
  ).rejects.toThrow('response_binding');
  const reopened = f.native('owner');
  expect(await Effect.runPromise(reopened.prepareFeature(input))).toEqual(original);
  expect(readFileSync(join(f.directory, 'owner.sqlite')).includes(Buffer.from(text))).toBe(false);
});

it('rejects expired feature requests before admitting even a single chunk', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1000);
  const f = fixture();
  try {
    const original = await Effect.runPromise(
      f.sender.prepareFeature({
        requestId: '99'.repeat(16),
        request: {
          workspaceId: f.workspaceId,
          machineId: f.machineId,
          method: 'code-collab/open-text',
          params: { sessionId: f.input.sessionId, path: 'private.ts' },
        },
      })
    );
    vi.setSystemTime(original.expiresAt);
    await expect(
      Effect.runPromise(f.receiver.openFeature(f.machineId, original.frameHex))
    ).rejects.toThrow('e2ee_feature_expiry');
  } finally {
    vi.useRealTimers();
  }
});
