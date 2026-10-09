import { Effect, Layer } from 'effect';
import {
  KeyMailboxRemote,
  KeyDeliveryRemote,
  TransportError,
  ValidationError,
  StreamProtocolError,
  type MailboxTarget,
  type MailboxPage,
  type MailboxEnvelope,
} from '@lody/e2ee-core/effect';
import type { LabFetch } from '../services/http';
import { fromHex, toHex } from './bytes';

/** Lab-only authenticated HTTP adapter. fetch is the session capability that adds its
 * device credential. No Convex/Streams dependency and no implicit retry timer. */
export function centralMailboxHttpLayer(input: { readonly url: string; readonly fetch: LabFetch }) {
  const call = <A>(body: unknown, decode: (data: unknown) => A) =>
    Effect.tryPromise({
      try: async () => {
        const res = await input.fetch(input.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          if (res.status === 400 || res.status === 403) return { error: 'unauthorized' };
          return { error: 'transport' };
        }
        return { data: (await res.json()) as unknown };
      },
      catch: () => new TransportError({ operation: 'deliver' }),
    }).pipe(
      Effect.flatMap(
        (r): Effect.Effect<A, ValidationError | TransportError | StreamProtocolError> =>
          'error' in r
            ? r.error === 'unauthorized'
              ? Effect.fail(new ValidationError({ code: 'unauthorized' }))
              : Effect.fail(new TransportError({ operation: 'deliver' }))
            : Effect.try({
                try: () => decode(r.data),
                catch: () => new StreamProtocolError({ code: 'invalid-mailbox-response' }),
              })
      )
    );
  const target = (x: unknown): MailboxTarget => {
    const t = x as MailboxTarget;
    if (
      !t ||
      !/^[0-9a-f]{64}$/.test(t.genesis) ||
      !/^[0-9a-f]{64}$/.test(t.recipient) ||
      !Number.isInteger(t.epoch) ||
      !Number.isInteger(t.revision) ||
      t.epoch < 0 ||
      t.revision < 0 ||
      ![
        'NeedsEnvelope',
        'EnvelopeStored',
        'InstallationReported',
        'Ineligible',
        'Obsolete',
      ].includes(t.status)
    )
      throw new Error('invalid-target');
    return t;
  };
  const page = <A>(x: unknown, decode: (x: unknown) => A): MailboxPage<A> => {
    const p = x as MailboxPage<unknown>;
    if (
      !p ||
      !Array.isArray(p.items) ||
      p.items.length > 100 ||
      (p.next !== null && (typeof p.next !== 'string' || p.next.length > 128))
    )
      throw new Error('invalid-page');
    return { items: p.items.map(decode), next: p.next };
  };
  const acknowledged = (data: unknown) => {
    if (!data || typeof data !== 'object' || !('ok' in data) || data.ok !== true)
      throw new Error('invalid-acknowledgement');
  };
  const remote: KeyMailboxRemote['Service'] = {
    status: (slot) => call({ op: 'status', slot }, target),
    list: (kind, cursor, limit) =>
      call({ op: 'list', kind, cursor, limit }, (x) => page(x, target)),
    fetch: (epoch, cursor, limit) =>
      call({ op: 'fetch', epoch, cursor, limit }, (x) =>
        page(x, (y) => {
          const r = y as { sender: string; frame: string };
          if (
            !r ||
            !/^[0-9a-f]{64}$/.test(r.sender) ||
            typeof r.frame !== 'string' ||
            r.frame.length > 4096
          )
            throw new Error('invalid-envelope');
          return { sender: r.sender, frame: fromHex(r.frame) } satisfies MailboxEnvelope;
        })
      ),
    report: (bytes, publication) =>
      call(
        { op: 'report', bytes: toHex(bytes), publication: publication ? toHex(publication) : null },
        acknowledged
      ),
    repair: (slot, requestId, rejectedDigest) =>
      call({ op: 'repair', slot, requestId, rejectedDigest }, acknowledged),
  };
  const delivery: KeyDeliveryRemote['Service'] = {
    put: (id, bytes) => call({ op: 'put', id, bytes: toHex(bytes) }, acknowledged),
    read: (id) =>
      call({ op: 'read', id }, (x) =>
        x === null
          ? null
          : typeof x === 'string' && x.length <= 4096
            ? fromHex(x)
            : (() => {
                throw new Error('invalid-frame');
              })()
      ),
  };
  return Layer.mergeAll(
    Layer.succeed(KeyMailboxRemote, remote),
    Layer.succeed(KeyDeliveryRemote, delivery)
  );
}
