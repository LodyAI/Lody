/** Manual, synthetic loopback measurement. Not a test or packaged-agent acceptance.
 * Start `loro dev --protocol http1 --host 127.0.0.1 --port 0 --db-path <temporary file> --json`, then:
 * pnpm --filter lody exec node --import tsx scripts/benchmark-e2ee-rpc.ts <baseUrl> [samples]
 * Uses real Streams I/O, crypto, SQLite and the production execution claim. The
 * final handler is synthetic; authentication is a warm Authorized fixture.
 */
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { Effect, Exit, Scope } from 'effect';
import type { MachineId, SessionId, WorkspaceId } from '@lody/shared';
import type { E2eeDispatchInput } from '@lody/shared/e2ee-rpc';
import {
  createLoroStreamsJsonStreamClient,
  LoroStreamsMachineRpcClient,
  LoroStreamsMachineRpcServer,
  type LoroStreamsJsonStreamClient,
} from '@lody/loro-streams-rpc';
import {
  makeEncryptedRpcListener,
  makeEncryptedStreamsRpc,
} from '@lody/loro-streams-rpc/e2ee-streams';
import { encryptedRpcFixture } from '../../../packages/loro-streams-rpc/tests/fixtures/e2ee-native-fixture';
import { makeEncryptedAgentExecution } from '../src/lib/e2ee/agent-execution';
import { RealtimeJournal } from '../src/lib/e2ee/realtime-journal';
import { makeEncryptedRpcReceiver } from '../src/lib/e2ee/realtime-rpc';

type Sample = { mode: 'plain' | 'encrypted'; index: number; stages: Record<string, number> };
const baseUrl = process.argv[2];
if (!baseUrl || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseUrl).hostname))
  throw new Error('Pass a loopback loro dev base URL; synthetic fixtures only.');
const count = Number(process.argv[3] ?? 100);
if (!Number.isSafeInteger(count) || count < 1 || count > 1000)
  throw new Error('Invalid sample count');
const f = encryptedRpcFixture();
const scope = Scope.makeUnsafe();
const bucketId = `benchmark-${crypto.randomUUID()}`;
const samples: Sample[] = [];
let current: Sample | undefined;
const mark = (stage: string) => {
  if (current && current.stages[stage] === undefined) current.stages[stage] = performance.now();
};
const streamClient = (mode: Sample['mode'], receiving: boolean): LoroStreamsJsonStreamClient => {
  const client = createLoroStreamsJsonStreamClient({
    baseUrl,
    bucketId,
    getToken: async () => 'dev-token',
  });
  return {
    ...client,
    appendJson: async (...args) => {
      if (!receiving && current?.mode === mode) mark('append-start');
      const result = await client.appendJson(...args);
      if (!receiving && current?.mode === mode) mark('append-complete');
      return result;
    },
    readJsonLive: (stream, state, onBatch, options) =>
      client.readJsonLive(
        stream,
        state,
        async (batch) => {
          if (receiving && current?.mode === mode && batch.messages.length) mark('target-receive');
          await onBatch(batch);
        },
        options
      ),
  };
};
const genesis = Buffer.from(f.ledger.context.genesis.toBytes()).toString('hex');
const receipts = RealtimeJournal.create(join(f.directory, 'bench-receipts.sqlite'), () =>
  Date.now()
);
const execution = RealtimeJournal.create(join(f.directory, 'bench-execution.sqlite'), () =>
  Date.now()
);
const authorize = () => Effect.succeed({ _tag: 'Authorized' as const });
const gate = makeEncryptedAgentExecution({
  workspaceId: f.workspaceId,
  genesis,
  targetMachineId: f.machineId,
  journal: () => execution,
  authorizeExecution: authorize,
  resolveVerifiedOriginal: (intent) =>
    Effect.gen(function* () {
      const retained = yield* f.receiver.readIncoming(intent);
      if (!retained) return undefined;
      const opened = yield* f.receiver.openDispatch(
        f.machineId,
        Buffer.from(retained.frame).toString('hex')
      );
      return {
        requesterDevice: opened.requesterDevice,
        requesterCryptoUserId: 'synthetic-owner',
        expiresAt: opened.expiresAt,
      };
    }),
  onClaim: () => mark('agent-journal'),
});
const targetClient = streamClient('encrypted', true);
const receive = makeEncryptedRpcReceiver({
  workspaceId: f.workspaceId,
  genesis,
  machineId: f.machineId,
  native: f.receiver,
  journal: () => receipts,
  authorize,
  isOpen: () => true,
  client: targetClient,
  trace: ({ stage }) => mark(stage),
  offer: async (input) => {
    const claim = await Effect.runPromise(
      gate.claim({
        workspaceId: f.workspaceId,
        sessionId: input.sessionId,
        userTurnId: input.userTurnId,
        inputConfig: input.inputConfig,
      })
    );
    if (claim.state !== 'claimed') throw new Error(`Unexpected execution claim: ${claim.state}`);
    // Entry into the synthetic handler, after the real durable actual-start claim.
    mark('handler-start');
    await Effect.runPromise(gate.complete(claim.permit));
    return { ...f.ack, sessionId: input.sessionId, userTurnId: input.userTurnId };
  },
});
const plainServer = new LoroStreamsMachineRpcServer({
  workspaceId: f.workspaceId as WorkspaceId,
  machineId: f.machineId as MachineId,
  streamClient: streamClient('plain', true),
  logger: { warn: (message) => console.error(message) },
  refreshMachineAcpCapabilities: async () => {
    throw new Error('Unused');
  },
  getMachineStatus: async () => {
    throw new Error('Unused');
  },
  dispatchSessionTurn: async (input) => {
    mark('handler-start');
    return { ...f.ack, sessionId: input.sessionId, userTurnId: input.userTurnId };
  },
});
const plainClient = new LoroStreamsMachineRpcClient({
  workspaceId: f.workspaceId,
  machineId: f.machineId,
  streamClient: streamClient('plain', false),
});
try {
  const bucket = await fetch(`${baseUrl}/ds/${bucketId}`, { method: 'PUT' });
  if (bucket.status !== 201) throw new Error(`Local bucket creation failed: ${bucket.status}`);
  await bucket.arrayBuffer();
  await plainServer.start();
  await plainClient.start();
  await Effect.runPromise(
    makeEncryptedRpcListener({
      workspaceId: f.workspaceId,
      machineId: f.machineId,
      client: targetClient,
      receive,
      onFailure: () => console.error('encrypted intake failed'),
    }).pipe(Scope.provide(scope))
  );
  const encrypted = await Effect.runPromise(
    makeEncryptedStreamsRpc({
      workspaceId: f.workspaceId,
      requesterDevice: Buffer.from(f.ledger.owner.publicKey.toBytes()).toString('hex'),
      client: streamClient('encrypted', false),
      acceptResponse: (original, input, frame) =>
        Effect.runPromise(f.sender.acceptResponse(original.targetMachineId, input, frame)),
    }).pipe(Scope.provide(scope))
  );
  for (let index = -10; index < count; index++) {
    for (const mode of ['plain', 'encrypted'] as const) {
      current = { mode, index, stages: {} };
      const inputConfig = {
        prompt: 'Synthetic benchmark input',
        cliType: 'builtin' as const,
        agentType: 'codex',
      };
      const input: E2eeDispatchInput = {
        sessionId: f.input.sessionId,
        userTurnId: `${mode}-${index}`,
        userId: f.input.userId,
        timestamp: new Date().toISOString(),
        inputConfig,
      };
      mark('send');
      const ack =
        mode === 'encrypted'
          ? await Effect.runPromise(
              Effect.gen(function* () {
                const original = yield* f.sender.prepareDispatch(f.machineId, input);
                mark('prepared');
                return yield* encrypted.send(original, input);
              })
            )
          : await plainClient.requestSessionDispatchTurn({
              ...input,
              sessionId: input.sessionId as SessionId,
              inputConfig,
              timeoutMs: 800,
            });
      if (!ack?.accepted || current.stages['handler-start'] === undefined)
        throw new Error(`Missing ACK or handler start: ${mode}/${index}`);
      if (index >= 0) samples.push(current);
    }
  }
  const percentile = (values: number[], fraction: number) => {
    values.sort((a, b) => a - b);
    return Number(values[Math.max(0, Math.ceil(values.length * fraction) - 1)]?.toFixed(3));
  };
  const pairs = [
    ['total', 'send', 'handler-start'],
    ['prepare', 'send', 'prepared'],
    ['send-to-append', 'send', 'append-start'],
    ['append-to-receive', 'append-start', 'target-receive'],
    ['receive-to-verified', 'target-receive', 'verified'],
    ['verified-to-receipt-journal', 'verified', 'journal'],
    ['receipt-to-agent-journal', 'journal', 'agent-journal'],
    ['agent-journal-to-handler', 'agent-journal', 'handler-start'],
  ] as const;
  const summary = ['plain', 'encrypted'].map((mode) => ({
    mode,
    milliseconds: Object.fromEntries(
      pairs.flatMap(([label, start, end]) => {
        const values = samples
          .filter((sample) => sample.mode === mode)
          .flatMap((sample) =>
            sample.stages[start] === undefined || sample.stages[end] === undefined
              ? []
              : [sample.stages[end] - sample.stages[start]]
          );
        return values.length
          ? [
              [
                label,
                {
                  n: values.length,
                  p50: percentile([...values], 0.5),
                  p95: percentile([...values], 0.95),
                  p99: percentile([...values], 0.99),
                },
              ],
            ]
          : [];
      })
    ),
  }));
  console.log(
    JSON.stringify(
      {
        environment: {
          node: process.version,
          baseUrl,
          count,
          warmup: 10,
          authorization: 'warm synthetic Authorized; no authenticated ledger network fetch',
          boundary:
            'synthetic handler after production claim; no UI/Meta/watcher/IPC/ACP/model startup',
        },
        summary,
        samples,
      },
      null,
      2
    )
  );
} finally {
  plainClient.stop();
  plainServer.stop();
  await Effect.runPromise(Scope.close(scope, Exit.void));
  f.close();
}
