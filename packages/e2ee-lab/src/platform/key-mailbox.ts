import { Data, Effect, Result } from 'effect';
import type { DistributionMailboxRemote } from '@lody/e2ee-core/internal';
import type { MailboxTarget } from '@lody/e2ee-core/adapters/node-sqlite';
import { validSlot } from '@lody/e2ee-core/host';
import { makeLabSdkOwner } from './sdk-owner';
import { readBoundedBody } from './bounded-body';

export class LabMailboxError extends Data.TaggedError('LabMailboxError')<{
  readonly code: 'unauthorized' | 'transport' | 'invalid-response' | 'closed';
}> {}
const fail = (code: LabMailboxError['code']) => new LabMailboxError({ code });
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const frame = (value: unknown) => {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(value) || value.length > 1024)
    throw fail('invalid-response');
  return new Uint8Array(Buffer.from(value, 'hex'));
};
const target = (value: unknown): MailboxTarget => {
  const item = value as MailboxTarget;
  if (
    !item ||
    !validSlot(item) ||
    !Number.isSafeInteger(item.revision) ||
    item.revision < 0 ||
    !['NeedsEnvelope', 'EnvelopeStored', 'InstallationReported', 'Ineligible', 'Obsolete'].includes(
      item.status
    )
  )
    throw fail('invalid-response');
  return {
    genesis: item.genesis,
    epoch: item.epoch,
    recipient: item.recipient,
    revision: item.revision,
    status: item.status,
  };
};
const page = <A>(value: unknown, decode: (value: unknown) => A) => {
  const item = value as { items: unknown[]; next: string | null };
  if (
    !item ||
    !Array.isArray(item.items) ||
    item.items.length > 100 ||
    (item.next !== null && (typeof item.next !== 'string' || !/^\d{1,9}$/.test(item.next)))
  )
    throw fail('invalid-response');
  return { items: item.items.map(decode), next: item.next };
};
const ack = (value: unknown) => {
  if (!value || typeof value !== 'object' || !('ok' in value) || value.ok !== true)
    throw fail('invalid-response');
};
/** Lab transport only. The caller supplies an authenticated fetch capability; neither
 * JSON fields nor response status authenticate a device or authorize installation.
 * Uses the public receiver/distributor interface, no implicit retry or key custody.
 * Scope owns the complete raw fetch AND response body, aborts and waits before close. */
export function makeLabMailboxRemote(input: {
  readonly url: string;
  readonly fetch: typeof fetch;
  /** Optional owned transport lease (e.g. an authenticated native HTTP session).
   * Runs only after actual fetch/body settlement; global fetch needs no native close. */
  readonly close?: () => Promise<void>;
}) {
  return Effect.gen(function* () {
    const url = input.url,
      fetchImpl = input.fetch,
      closeTransport = input.close;
    const owner = yield* makeLabSdkOwner(() => ({
      close: closeTransport ?? (async () => undefined),
    }));
    const call = <A>(body: unknown, decode: (value: unknown) => A) =>
      owner
        .invoke(async () => {
          try {
            const response = await fetchImpl(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
              signal: owner.signal,
            });
            if (!response.ok) {
              await response.body?.cancel();
              return Result.fail(
                fail(
                  response.status === 400 || response.status === 401 || response.status === 403
                    ? 'unauthorized'
                    : 'transport'
                )
              );
            }
            if (!response.body) return Result.fail(fail('invalid-response'));
            const bytes = await readBoundedBody(response.body, 128 * 1024);
            if (bytes === undefined) return Result.fail(fail('invalid-response'));
            return Result.try({
              try: () =>
                decode(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))),
              catch: () => fail('invalid-response'),
            });
          } catch (error) {
            return Result.fail(error instanceof LabMailboxError ? error : fail('transport'));
          }
        })
        .pipe(
          Effect.mapError((error) => fail(error.code === 'closed' ? 'closed' : 'transport')),
          Effect.flatMap(Effect.fromResult)
        );
    const remote = {
      status: (slot: Parameters<DistributionMailboxRemote['status']>[0]) =>
        call({ op: 'status', slot }, target),
      list: (
        kind: 'needsEnvelope' | 'awaitingInstallationReport',
        cursor: string | null,
        limit: number
      ) => call({ op: 'list', kind, cursor, limit }, (value) => page(value, target)),
      fetch: (epoch: number, cursor: string | null, limit: number) =>
        call({ op: 'fetch', epoch, cursor, limit }, (value) =>
          page(value, (entry) => {
            const item = entry as { sender: string; frame: string };
            if (!item || typeof item.sender !== 'string' || !/^[0-9a-f]{64}$/.test(item.sender))
              throw fail('invalid-response');
            return { sender: item.sender, frame: frame(item.frame) };
          })
        ),
      put: (id: string, bytes: Uint8Array) => call({ op: 'put', id, bytes: hex(bytes) }, ack),
      read: (id: string) =>
        call({ op: 'read', id }, (value) => (value === null ? null : frame(value))),
      report: (bytes: Uint8Array, publication?: Uint8Array) =>
        call(
          {
            op: 'report',
            bytes: hex(bytes),
            publication: publication === undefined ? null : hex(publication),
          },
          ack
        ),
      repair: (
        slot: Parameters<DistributionMailboxRemote['repair']>[0],
        requestId: string,
        rejectedDigest?: string
      ) => call({ op: 'repair', slot, requestId, rejectedDigest }, ack),
    } satisfies DistributionMailboxRemote & {
      readonly list: (
        kind: 'needsEnvelope' | 'awaitingInstallationReport',
        cursor: string | null,
        limit: number
      ) => Effect.Effect<
        { readonly items: readonly MailboxTarget[]; readonly next: string | null },
        LabMailboxError
      >;
    };
    return Object.freeze(remote);
  });
}
