import { Effect } from 'effect';
import type { makeE2eeRpcNative } from '@lody/loro-streams-rpc/e2ee-native';
import { e2eeRpcEnvelope } from '@lody/loro-streams-rpc/e2ee-streams';
import type { LoroStreamsJsonStreamClient } from '@lody/loro-streams-rpc';
import type {
  LocalMachineRpcRequest,
  LocalMachineRpcResponse,
} from '@lody/shared/local-machine-rpc';
import type { AuthorizeEncryptedExecution } from './agent-execution';
import { RealtimeJournal, type RealtimeStartPermit } from './realtime-journal';

const attempt = <A>(body: () => A) => Effect.try({ try: body, catch: (cause) => cause });
/** The verified same-member machine authority is reused; methods remain product-scoped.
 * All encrypted response originals are durable before publication. Unknown outcomes never rerun saves. */
export function makeEncryptedFeatureReceiver(options: {
  workspaceId: string;
  genesis: string;
  machineId: string;
  native: ReturnType<typeof makeE2eeRpcNative>;
  journal: () => RealtimeJournal;
  authorize: AuthorizeEncryptedExecution;
  isOpen: () => boolean;
  handle: (request: LocalMachineRpcRequest) => Promise<LocalMachineRpcResponse>;
  client: LoroStreamsJsonStreamClient;
}) {
  const pending = new Map<string, { permit: RealtimeStartPermit; frames: Uint8Array[] }>();
  return Effect.fnUntraced(function* (envelope: { id: string; frame: string }) {
    if (!options.isOpen()) return true;
    const opened = yield* options.native.openFeature(options.machineId, envelope.frame);
    if (opened === null) return false;
    if (!opened) return true;
    if (opened.requestId !== envelope.id)
      return yield* Effect.fail(new Error('e2ee_rpc_request_binding'));
    const authority = yield* options.authorize(options.workspaceId, opened.requesterDevice);
    if (authority._tag !== 'Authorized' || !options.isOpen()) return true;
    const journal = yield* attempt(options.journal);
    const request = {
      genesis: options.genesis,
      workspaceId: options.workspaceId,
      targetMachineId: options.machineId,
      requestId: opened.requestId,
      requester: opened.requesterDevice,
      expiresAt: opened.expiresAt,
      frame: Uint8Array.from(opened.frame),
    };
    const retained = yield* attempt(() => journal.receive(request));
    let owned = pending.get(opened.requestId);
    if (retained.state !== 'completed' && !owned) {
      if (pending.size >= 32) return true;
      const claim = yield* attempt(() => journal.claim(request));
      if (claim.state !== 'claimed' || !options.isOpen()) return true;
      const response = yield* Effect.acquireUseRelease(
        Effect.sync(() => ({ raw: undefined as Promise<LocalMachineRpcResponse> | undefined })),
        (owner) =>
          Effect.tryPromise({
            try: () => (owner.raw = options.handle(opened.input.request)),
            catch: (cause) => cause,
          }),
        (owner) =>
          Effect.promise(async () => {
            await owner.raw?.catch(() => undefined);
          })
      );
      const frames = yield* options.native.sealFeatureResult(options.machineId, opened, response);
      owned = { permit: claim.permit, frames };
      pending.set(opened.requestId, owned);
    }
    if (owned) {
      const selected = owned;
      for (let index = 0; index < selected.frames.length; index++) {
        const frame = selected.frames[index];
        if (!frame) return yield* Effect.fail(new Error('e2ee_feature_response_missing'));
        yield* attempt(() => journal.retainResponse(selected.permit, { index, frame }));
      }
      yield* attempt(() => journal.finish(selected.permit, Uint8Array.of(selected.frames.length)));
      pending.delete(opened.requestId);
    }
    const complete = yield* attempt(() => journal.receive(request));
    if (complete.state !== 'completed' || !options.isOpen()) return true;
    const count = complete.outcome[0];
    if (!count || count > 128)
      return yield* Effect.fail(new Error('e2ee_feature_response_missing'));
    const stream = options.native.responseStream(opened.requesterDevice);
    yield* Effect.tryPromise({
      try: () => options.client.ensureJsonStream(stream, 86400),
      catch: (cause) => cause,
    });
    for (let index = 0; index < count; index++) {
      if (!options.isOpen()) return true;
      const frame = yield* attempt(() => journal.readResponse(request, index));
      if (!frame) return yield* Effect.fail(new Error('e2ee_feature_response_missing'));
      yield* Effect.tryPromise({
        try: () =>
          options.client.appendJson(
            stream,
            e2eeRpcEnvelope({ id: opened.requestId, frame: Buffer.from(frame).toString('hex') })
          ),
        catch: (cause) => cause,
      });
    }
    return true;
  });
}
