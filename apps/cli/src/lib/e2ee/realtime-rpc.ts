import { Clock, Effect } from 'effect';
import type { E2eeDispatchInput, E2eeDispatchAck } from '@lody/shared/e2ee-rpc';
import { e2eeRpcEnvelope, type E2eeRpcTiming } from '@lody/loro-streams-rpc/e2ee-streams';
import type { makeE2eeRpcNative } from '@lody/loro-streams-rpc/e2ee-native';
import type { LoroStreamsJsonStreamClient } from '@lody/loro-streams-rpc';
import type { AuthorizeEncryptedExecution } from './agent-execution';
import { RealtimeJournal, type RealtimeStartPermit } from './realtime-journal';

const attempt = <A>(body: () => A) => Effect.try({ try: body, catch: (cause) => cause });
/** Delivery receipt owner only. Actual execution always enters agent-start:userTurnId
 * through SessionExecutionService, including when history beats this offer. */
export function makeEncryptedRpcReceiver(options: {
  workspaceId: string;
  genesis: string;
  machineId: string;
  native: ReturnType<typeof makeE2eeRpcNative>;
  journal: () => RealtimeJournal;
  authorize: AuthorizeEncryptedExecution;
  isOpen: () => boolean;
  offer: (input: E2eeDispatchInput) => Promise<E2eeDispatchAck>;
  client: LoroStreamsJsonStreamClient;
  trace?: (event: E2eeRpcTiming) => void;
}) {
  const pendingResponses = new Map<string, { permit: RealtimeStartPermit; frame: Uint8Array }>();
  const responseStreams = new Set<string>();
  return Effect.fnUntraced(function* (envelope: { id: string; frame: string }) {
    const mark = (stage: E2eeRpcTiming['stage'], userTurnId?: string) =>
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis;
        try {
          options.trace?.({ stage, requestId: envelope.id, at, userTurnId });
        } catch {
          /* Observation only. */
        }
      });
    if (!options.isOpen()) return;
    const opened = yield* options.native.openDispatch(options.machineId, envelope.frame);
    if (opened.requestId !== envelope.id) yield* Effect.fail(new Error('e2ee_rpc_request_binding'));
    yield* mark('verified', opened.args.userTurnId);
    const authorization = yield* options.authorize(options.workspaceId, opened.requesterDevice);
    if (authorization._tag !== 'Authorized' || !options.isOpen()) return;
    const journal = yield* attempt(options.journal);
    const request = {
      genesis: options.genesis,
      workspaceId: options.workspaceId,
      targetMachineId: options.machineId,
      requestId: opened.requestId,
      requester: opened.requesterDevice,
      expiresAt: opened.expiresAt,
      frame: opened.frame,
    };
    yield* attempt(() => journal.receive(request));
    const prior = yield* attempt(() => journal.readResponse(request, 0));
    let response = prior;
    if (!response) {
      const pending = pendingResponses.get(opened.requestId);
      if (pending) {
        response = yield* attempt(() =>
          journal.retainResponse(pending.permit, { index: 0, frame: pending.frame })
        );
        pendingResponses.delete(opened.requestId);
      }
    }
    if (!response) {
      if (pendingResponses.size >= 32) return;
      yield* options.native.retainIncoming(options.machineId, opened);
      const claim = yield* attempt(() => journal.claim(request));
      if (claim.state !== 'claimed' || !options.isOpen()) return;
      yield* mark('journal', opened.args.userTurnId);
      const ack = yield* Effect.tryPromise({
        try: () => options.offer(opened.args),
        catch: (cause) => cause,
      });
      response = yield* options.native.sealAck(options.machineId, opened, ack);
      const originalResponse = response;
      pendingResponses.set(opened.requestId, { permit: claim.permit, frame: originalResponse });
      yield* attempt(() =>
        journal.retainResponse(claim.permit, { index: 0, frame: originalResponse })
      );
      pendingResponses.delete(opened.requestId);
      // ACK remains progress. Never finish the distinct agent-start execution claim here.
    }
    if (!options.isOpen()) return;
    const stream = options.native.responseStream(opened.requesterDevice);
    const saved = response;
    yield* Effect.tryPromise({
      try: async () => {
        if (!responseStreams.has(stream)) {
          await options.client.ensureJsonStream(stream, 86400);
          if (responseStreams.size >= 128) responseStreams.clear();
          responseStreams.add(stream);
        }
        try {
          await options.client.appendJson(
            stream,
            e2eeRpcEnvelope({ id: opened.requestId, frame: Buffer.from(saved).toString('hex') })
          );
        } catch (cause) {
          responseStreams.delete(stream);
          throw cause;
        }
      },
      catch: (cause) => cause,
    });
  });
}
