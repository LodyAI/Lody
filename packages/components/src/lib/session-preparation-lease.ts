import type { MachineId, SessionPreparationSpec } from '@lody/shared';
import type { WorkspaceRuntime } from '@/atoms/runtime';

/** A warmup is owned until explicitly handed off, canceled, or its workspace closes. */
export function createSessionPreparationLease(
  runtime: WorkspaceRuntime,
  machineId: MachineId,
  spec: SessionPreparationSpec
) {
  const ready =
    Promise.withResolvers<Awaited<ReturnType<WorkspaceRuntime['requestSessionPrepare']>>>();
  const stop = Promise.withResolvers<void>();
  let handedOff = false;
  let released = false;
  const settled = runtime.sendResources.run(
    async (signal) => {
      const abort = () => stop.resolve();
      signal.addEventListener('abort', abort, { once: true });
      try {
        const response = await runtime.requestSessionPrepare(machineId, spec, { timeoutMs: 5_000 });
        ready.resolve(response);
        if (!response?.accepted) stop.resolve();
        if (signal.aborted) stop.resolve();
        await stop.promise;
      } catch (error) {
        ready.reject(error);
        throw error;
      } finally {
        signal.removeEventListener('abort', abort);
        if (!handedOff)
          await runtime
            .requestSessionPrepareCancel(
              machineId,
              {
                preparationId: spec.preparationId,
                sessionId: spec.sessionId,
                requestedByUserId: spec.requestedByUserId,
              },
              { timeoutMs: 5_000 }
            )
            .catch(() => undefined);
      }
    },
    undefined,
    { protectExit: false }
  );
  void settled.catch((error: unknown) => {
    ready.reject(error);
  });
  return {
    ready: ready.promise,
    settled,
    cancel: () => {
      released = true;
      stop.resolve();
    },
    handoff: () => {
      if (released) return false;
      handedOff = true;
      released = true;
      stop.resolve();
      return true;
    },
  };
}
