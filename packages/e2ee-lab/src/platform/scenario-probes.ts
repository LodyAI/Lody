import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { Data, Effect, Result } from 'effect';
import { StreamsClient } from '@loro-dev/streams-client';
import { Bytes } from '@lody/e2ee-core';
import {
  contentSigningBytes,
  inspectContentFrame,
  type ContentScope,
} from '@lody/e2ee-core/protocol';
import {
  admitDocument,
  authenticateDocument,
  scopedDocumentKey,
  openDocument,
} from '@lody/e2ee-core/protocol';
import { makeSqliteProtectedEpochKeys } from '@lody/e2ee-core/internal';
import { type LedgerView } from '@lody/e2ee-core';
import { hashRecordBytes, requireLedgerContinuation } from '@lody/e2ee-core/protocol';
import { frameLedgerRecord } from '@lody/e2ee-core/protocol';
import { makeLabHttpIdentity } from './http-identity';
import { makeLabLedgerClient } from './ledger-client';
import { makeLabAttackObserver, type LabAttackProbes } from './attack-observer';
import { LabCallbackRunner } from './run';
import { makeLabSdkOwner } from './sdk-owner';
import { labSyntheticProtector } from './synthetic-protection';
import type { makeLabScenarioFixture } from './scenario-fixture';
import type { makeLabContentTrace } from './content-trace';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_FRAMES = 4096;
const PROBES = ['wrong-context', 'unauthorized-writer', 'forged-control', 'insider-post-exclusion'];

export class LabScenarioProbeError extends Data.TaggedError('LabScenarioProbeError')<{
  readonly code: 'input' | 'budget' | 'incomplete-content' | 'missing-control' | 'capability';
}> {}
const fail = (code: LabScenarioProbeError['code']) => new LabScenarioProbeError({ code });

export function captureLabUpdateSamples(
  source: Uint8Array,
  genesis: string,
  model: 'loro' | 'flock',
  resource: string
) {
  if (!(source instanceof Uint8Array) || source.length > MAX_BYTES) throw fail('budget');
  // Own the response before parsing. Neither native SDK buffers nor returned
  // sample mutation can change another sample or its authenticated context.
  const body = new Uint8Array(source);
  const samples: { scope: ContentScope; frame: Uint8Array; additionalData: Uint8Array }[] = [];
  const domain = new TextEncoder().encode('loro-streams-crdt-payload-protection/v2\0');
  const header = Uint8Array.of(76, 83, 67, 69, 2, 1, 0, 1, 0, 0, 3);
  const purpose = model === 'loro' ? 'doc-update' : 'flock-update';
  for (let at = 0; at < body.length;) {
    if (samples.length === MAX_FRAMES) throw fail('budget');
    if (body.length - at < 4) throw fail('incomplete-content');
    const size = new DataView(body.buffer, body.byteOffset + at, 4).getUint32(0);
    at += 4;
    if (size < 12 || size > body.length - at) throw fail('incomplete-content');
    const item = body.subarray(at, at + size);
    at += size;
    if (!Buffer.from(item.subarray(0, header.length)).equals(Buffer.from(header)))
      throw fail('incomplete-content');
    const frame = new Uint8Array(item.subarray(header.length));
    const parsed = inspectContentFrame(frame, purpose);
    if (Result.isFailure(parsed)) throw fail('incomplete-content');
    const additionalData = new Uint8Array(domain.length + header.length);
    additionalData.set(domain);
    additionalData.set(header, domain.length);
    samples.push({
      scope: Object.freeze({ genesis, resource, epoch: parsed.success.epoch, purpose }),
      frame,
      additionalData,
    });
  }
  return samples;
}

/** StreamsClient.close publishes EOF, so the lifecycle port only owns requests.
 * Every read/append is invoked through its lease through actual body settlement. */
const makeProbeStream = (url: string, transport: typeof fetch = fetch) =>
  makeLabSdkOwner(({ signal, assertOpen }) => ({
    close: async () => undefined,
    client: new StreamsClient({
      url,
      retry: { maxAttempts: 1 },
      fetch: async (request, init) => {
        assertOpen();
        const outgoing = new Request(request, init);
        const response = await transport(
          new Request(outgoing, {
            redirect: 'error',
            signal: AbortSignal.any([outgoing.signal, signal]),
          })
        );
        if (signal.aborted) {
          await response.body?.cancel();
          assertOpen();
        }
        // Bound the actual SDK body read, including malformed/error responses.
        let size = 0;
        const body = response.body?.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              size += chunk.byteLength;
              if (size > MAX_BYTES) throw fail('budget');
              controller.enqueue(chunk);
            },
          })
        );
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      },
    }),
  }));

/** Harness-private measured capabilities. Plans name probes only; device/key
 * handles and local paths never enter attacker DTOs or public observations.
 * Full-history update probes reject pruned/missing/incomplete transport rather
 * than treating absent evidence as a successful attack refusal. */
export const measureLabScenarioProbes = Effect.fnUntraced(function* (input: {
  readonly fixture: Effect.Success<ReturnType<typeof makeLabScenarioFixture>>;
  readonly trace: Effect.Success<ReturnType<typeof makeLabContentTrace>>;
  readonly actor: string;
  readonly probes: readonly string[];
  readonly retained?: LedgerView;
  readonly actorClosed: boolean;
}) {
  const fixture = input.fixture,
    trace = input.trace,
    actor = input.actor,
    actorClosed = input.actorClosed,
    retained = input.retained,
    probes = [...input.probes],
    org = hex(fixture.genesis.toBytes()),
    current = fixture.view(),
    device = fixture.devices.get(actor);
  if (
    !device ||
    probes.length > PROBES.length ||
    new Set(probes).size !== probes.length ||
    probes.some((probe) => !PROBES.includes(probe))
  )
    return yield* fail('input');
  yield* Effect.fromResult(requireLedgerContinuation(current, current));
  if (!current.genesis.equals(fixture.genesis)) return yield* fail('input');
  const checkpoint = { head: current.head, length: current.length };
  // Independently witnessed originals are captured before any network await.
  const genesisRecord = new Uint8Array(fixture.records[0]);
  const lastRecord = new Uint8Array(fixture.records[current.length - 1]);
  if (!hashRecordBytes(lastRecord).equals(current.head)) return yield* fail('input');
  const facts = yield* trace.contentWritesFor(org);
  const backendRows: Uint8Array[] = [];
  const samples: ReturnType<typeof captureLabUpdateSamples> = [];
  let totalBytes = 0;
  for (const stream of [
    { model: 'loro', resource: 'document-A' },
    { model: 'flock', resource: 'document-B' },
  ] as const) {
    const owner = yield* makeProbeStream(`${fixture.server.baseUrl}/ds/${org}/${stream.model}`);
    const chunks: Uint8Array[] = [];
    let offset = '-1',
      complete = false;
    const visited = new Set([offset]);
    for (let page = 0; page < MAX_FRAMES; page++) {
      const read = yield* owner.invoke(({ client }) => client.read({ offset }));
      if (!read.ok) {
        if (
          page === 0 &&
          read.result.code === 'not_found' &&
          !facts.some((fact) => fact.stream === stream.model)
        ) {
          complete = true;
          break;
        }
        return yield* fail('incomplete-content');
      }
      const result = read.result;
      if (
        result.requestOffset !== offset ||
        result.payload.contentType !== 'application/octet-stream'
      )
        return yield* fail('incomplete-content');
      const bytes = new Uint8Array(result.payload.body);
      totalBytes += bytes.length;
      if (totalBytes > MAX_BYTES) return yield* fail('budget');
      chunks.push(bytes);
      if (result.upToDate) {
        complete = true;
        break;
      }
      if (visited.has(result.nextOffset)) return yield* fail('incomplete-content');
      visited.add(result.nextOffset);
      offset = result.nextOffset;
    }
    if (!complete) return yield* fail('incomplete-content');
    const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    backendRows.push(bytes);
    const captured = yield* Effect.try({
      try: () => captureLabUpdateSamples(bytes, org, stream.model, stream.resource),
      catch: (cause) =>
        cause instanceof LabScenarioProbeError ? cause : fail('incomplete-content'),
    });
    samples.push(...captured);
    if (samples.length > MAX_FRAMES) return yield* fail('budget');
  }
  const content: NonNullable<LabAttackProbes['content']>[number][] = [];
  if (probes.includes('wrong-context') || probes.includes('unauthorized-writer')) {
    const positive = [...samples].reverse().find((sample) => {
      const principal = Bytes.signingPublicKey(sample.frame.subarray(7, 39));
      return (
        Result.isSuccess(principal) &&
        Result.isSuccess(
          admitDocument(
            current,
            sample.scope,
            sample.frame,
            principal.success,
            sample.additionalData
          )
        )
      );
    });
    if (!positive) return yield* fail('missing-control');
    const principal = yield* Effect.fromResult(
      Bytes.signingPublicKey(positive.frame.subarray(7, 39))
    );
    if (probes.includes('wrong-context'))
      content.push({
        kind: 'wrong-context',
        scope: { ...positive.scope, resource: 'wrong-resource' },
        originalScope: positive.scope,
        frame: positive.frame,
        additionalData: positive.additionalData,
        principal,
      });
    if (probes.includes('unauthorized-writer')) {
      const unsigned = new Uint8Array(positive.frame.subarray(0, positive.frame.length - 64));
      unsigned.set(device.publicKey.toBytes(), 7);
      const signature = yield* device.sign(
        yield* Effect.fromResult(
          contentSigningBytes(positive.scope, unsigned, positive.additionalData)
        )
      );
      const frame = new Uint8Array(unsigned.length + 64);
      frame.set(unsigned);
      frame.set(signature.toBytes(), unsigned.length);
      yield* Effect.fromResult(
        authenticateDocument(current, positive.scope, frame, positive.additionalData)
      );
      content.push({
        kind: 'unauthorized-writer',
        scope: positive.scope,
        frame,
        additionalData: positive.additionalData,
        principal: device.publicKey,
      });
    }
  }
  let control: LabAttackProbes['control'];
  if (probes.includes('forged-control')) {
    const identity = yield* makeLabHttpIdentity({
      baseUrl: fixture.host.baseUrl,
      genesis: fixture.genesis,
    });
    const auth = yield* identity.authenticate(fixture.owner);
    const owner = yield* makeProbeStream(`${fixture.host.baseUrl}/ds/${org}/control`, auth.fetch);
    // The public ledger reader calls a Promise-only SDK port. This runner owns
    // only those callbacks; orchestration stays in the surrounding Effect.
    const callbacks = yield* Effect.acquireRelease(
      Effect.sync(() => new LabCallbackRunner()),
      (runner) => Effect.promise(() => runner.close())
    );
    const directory = yield* Effect.try({
      try: () => mkdtempSync(join(fixture.directory, 'probe-feed-')),
      catch: (cause) => cause,
    });
    const client = yield* makeLabLedgerClient({
      path: join(directory, 'feed.sqlite'),
      mode: 'create',
      genesis: fixture.genesis,
      genesisRecord,
      stream: {
        read: (request) => callbacks.run(owner.invoke(({ client: sdk }) => sdk.read(request))),
      },
      expected: { head: hashRecordBytes(genesisRecord), length: 1 },
      budget: { maxRecords: MAX_FRAMES, maxBytes: MAX_BYTES },
    });
    const baseline = yield* client.read(checkpoint);
    yield* Effect.fromResult(requireLedgerContinuation(current, baseline.view));
    if (!baseline.view.head.equals(current.head) || baseline.view.length !== current.length)
      return yield* fail('missing-control');
    lastRecord[lastRecord.length - 1] = lastRecord[lastRecord.length - 1] ^ 1;
    control = {
      record: lastRecord,
      refresh: () => client.read(checkpoint).pipe(Effect.map((value) => value.view)),
      retained: () => client.current().pipe(Effect.map((value) => value.view)),
    };
  }
  const appendOwner =
    control && (yield* makeProbeStream(`${fixture.server.baseUrl}/ds/${org}/control`));
  const observer = yield* makeLabAttackObserver({
    genesis: fixture.genesis,
    ledger: () => Effect.succeed(current),
    trace,
    maxFrames: MAX_FRAMES,
    maxBytes: MAX_BYTES,
    backend: {
      read: () => Effect.succeed(backendRows),
      appendControl: appendOwner
        ? (record) =>
            Effect.gen(function* () {
              // Capture the complete native input before the first SDK await.
              const body = yield* Effect.fromResult(frameLedgerRecord(new Uint8Array(record)));
              const result = yield* appendOwner.invoke(({ client }) =>
                client.append({
                  part: { contentType: 'application/octet-stream', body },
                })
              );
              if (result.ok) return { status: result.result.status };
              if ('status' in result.result && typeof result.result.status === 'number')
                return { status: result.result.status };
              return yield* fail('incomplete-content');
            })
        : undefined,
    },
  });
  if (!probes.includes('insider-post-exclusion'))
    return yield* observer.observe({ control, content });
  if (
    !actorClosed ||
    !retained ||
    fixture.configuration.find((row) => row.id === actor)?.behavior !== 'insider'
  )
    return yield* fail('capability');
  yield* Effect.fromResult(requireLedgerContinuation(retained, current));
  const keyEpoch = retained.inspectState().epoch.number;
  const store = yield* makeSqliteProtectedEpochKeys({
    path: join(fixture.directory, `${actor}-keys.sqlite`),
    mode: 'open',
    genesis: fixture.genesis,
    recipient: device.publicKey,
    ledger: () => Effect.succeed(retained),
    protector: labSyntheticProtector,
  });
  const key = yield* store.read(keyEpoch),
    before = samples.find((sample) => sample.scope.epoch === keyEpoch),
    after = samples.filter((sample) => sample.scope.epoch > keyEpoch);
  if (!before || !after.length) return yield* fail('missing-control');
  const leaf = yield* scopedDocumentKey(before.scope, key);
  return yield* Effect.acquireUseRelease(
    Effect.fromResult(
      openDocument(current, before.scope, leaf, before.frame, before.additionalData)
    ),
    ({ plaintext }) =>
      observer.observe({
        control,
        content,
        insider: {
          key,
          keyEpoch,
          freshnessBypassed: false,
          samples: [{ ...before, expectedPlaintext: plaintext }, ...after],
        },
      }),
    ({ plaintext }) => Effect.sync(() => plaintext.fill(0))
  );
});
