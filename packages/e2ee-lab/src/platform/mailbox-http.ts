import { Data, Effect } from 'effect';
import type { makeSqliteKeyMailbox } from '@lody/e2ee-core/adapters/node-sqlite';
import { type MailboxSlot } from '@lody/e2ee-core/services';
import { validSlot } from '@lody/e2ee-core/host';
export type LabMailboxHost = Effect.Success<ReturnType<typeof makeSqliteKeyMailbox>>;
type Remote = import('effect').Result.Result.Success<ReturnType<LabMailboxHost['bind']>>;
class LabMailboxRequestError extends Data.TaggedError('LabMailboxRequestError')<{}> {}
const invalid = () => new LabMailboxRequestError();
const byteString = (value: unknown, maxBytes = 512) => {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(value) || value.length > maxBytes * 2)
    throw invalid();
  return new Uint8Array(Buffer.from(value, 'hex'));
};
const id = (value: unknown, bytes: number) => {
  if (typeof value !== 'string' || value.length !== bytes * 2 || !/^[0-9a-f]+$/.test(value))
    throw invalid();
  return value;
};
/** DTO adapter only. The real HTTP host authenticates the stored bearer, binds Org,
 * and calls public mailbox.bind(storedDevice). JSON never selects this principal.
 * All crypto, current eligibility, durable status and installation-report admission
 * remain in the public mailbox; no alternate acceptance/store or implicit retry. */
export function dispatchLabMailbox(
  remote: Remote,
  payload: Record<string, unknown>,
  genesis: string
) {
  return Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => {
        const slot = () => {
          const value = payload.slot as MailboxSlot;
          if (!value || !validSlot(value) || value.genesis !== genesis) throw invalid();
          return { genesis: value.genesis, epoch: value.epoch, recipient: value.recipient };
        };
        const page = () => {
          const { cursor, limit } = payload;
          if (
            (cursor !== null && (typeof cursor !== 'string' || !/^\d{1,9}$/.test(cursor))) ||
            typeof limit !== 'number' ||
            !Number.isSafeInteger(limit) ||
            limit < 1 ||
            limit > 100
          )
            throw invalid();
          return { cursor, limit };
        };
        switch (payload.op) {
          case 'status':
            return { op: 'status' as const, slot: slot() };
          case 'list': {
            if (payload.kind !== 'needsEnvelope' && payload.kind !== 'awaitingInstallationReport')
              throw invalid();
            return {
              op: 'list' as const,
              kind: payload.kind as 'needsEnvelope' | 'awaitingInstallationReport',
              ...page(),
            };
          }
          case 'fetch': {
            const epoch = payload.epoch;
            if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 0)
              throw invalid();
            return { op: 'fetch' as const, epoch, ...page() };
          }
          case 'read':
            return { op: 'read' as const, id: id(payload.id, 16) };
          case 'put':
            return { op: 'put' as const, id: id(payload.id, 16), bytes: byteString(payload.bytes) };
          case 'report':
            return {
              op: 'report' as const,
              bytes: byteString(payload.bytes),
              publication:
                payload.publication === null ? undefined : byteString(payload.publication, 8192),
            };
          case 'repair':
            return {
              op: 'repair' as const,
              slot: slot(),
              requestId: (() => {
                if (
                  typeof payload.requestId !== 'string' ||
                  payload.requestId.length < 1 ||
                  payload.requestId.length > 256
                )
                  throw invalid();
                return payload.requestId;
              })(),
              rejectedDigest:
                payload.rejectedDigest === undefined ? undefined : id(payload.rejectedDigest, 32),
            };
          default:
            throw invalid();
        }
      },
      catch: () => invalid(),
    });
    switch (parsed.op) {
      case 'status':
        return yield* remote.status(parsed.slot);
      case 'list':
        return yield* remote.list(parsed.kind, parsed.cursor, parsed.limit);
      case 'fetch': {
        const result = yield* remote.fetch(parsed.epoch, parsed.cursor, parsed.limit);
        return {
          ...result,
          items: result.items.map((item) => ({
            ...item,
            frame: Buffer.from(item.frame).toString('hex'),
          })),
        };
      }
      case 'read': {
        const bytes = yield* remote.read(parsed.id);
        return bytes === null ? null : Buffer.from(bytes).toString('hex');
      }
      case 'put':
        yield* remote.put(parsed.id, parsed.bytes);
        return { ok: true };
      case 'report':
        yield* remote.report(parsed.bytes, parsed.publication);
        return { ok: true };
      case 'repair':
        yield* remote.repair(parsed.slot, parsed.requestId, parsed.rejectedDigest);
        return { ok: true };
    }
    return yield* invalid();
  });
}
