import type { LedgerView } from '@lody/e2ee-core/protocol';
import type { PersonalIrohEndpoint } from './platform';

/** Connection budget for a call on an existing connection. */
const CONNECT_TIMEOUT_MS = 3_000;
/** Budget for preparing a connection in the background. */
const WARM_TIMEOUT_MS = 10_000;

/** The single ledger device registered as `machineId`; iroh dials its signing key. */
export function irohTargetDevice(view: LedgerView, machineId: string): string | undefined {
  const matches = [...view.inspectState().devices.entries()].filter(
    ([, device]) => device.kind === 'machine' && device.machineId === machineId
  );
  const key = matches.length === 1 ? matches[0]![0] : undefined;
  return typeof key === 'string' && /^[0-9a-f]{64}$/.test(key) ? key : undefined;
}

/**
 * One machine's iroh route on an open endpoint. Every method is lock-free and
 * runs after the session has released its locks; the renderer verifies replies.
 */
export function makePersonalIrohRoute(
  endpoint: PersonalIrohEndpoint,
  key: string,
  warming: Set<string>
) {
  return {
    path: async () =>
      endpoint.connectionPath?.(key).catch(() => 'none' as const) ?? ('none' as const),
    /** Live connection? Never waits for a dial; starts at most one background dial. */
    ready: async (): Promise<boolean> => {
      if (await endpoint.hasConnection(key).catch(() => false)) return true;
      if (!warming.has(key)) {
        warming.add(key);
        void endpoint
          .warm(key, WARM_TIMEOUT_MS)
          .catch(() => undefined)
          .finally(() => warming.delete(key));
      }
      return false;
    },
    /** Sends one `{id, frame}` envelope; returns reply frames read within `timeoutMs`. */
    call: async (envelope: { id: string; frame: string }, timeoutMs: number): Promise<string[]> => {
      const call = await endpoint.call(
        key,
        new TextEncoder().encode(JSON.stringify(envelope)),
        CONNECT_TIMEOUT_MS
      );
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        call.cancel();
      }, timeoutMs);
      try {
        const frames: string[] = [];
        const decoder = new TextDecoder('utf-8', { fatal: true });
        for (let reply = await call.nextReply(); reply; reply = await call.nextReply()) {
          const parsed = JSON.parse(decoder.decode(reply)) as { id?: unknown; frame?: unknown };
          if (parsed.id === envelope.id && typeof parsed.frame === 'string')
            frames.push(parsed.frame);
          if (frames.length > 128) throw new Error('iroh_reply_limit');
        }
        if (timedOut) throw new Error('iroh_timeout');
        return frames;
      } catch (cause) {
        call.cancel();
        throw cause;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
