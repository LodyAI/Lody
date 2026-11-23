import { Effect, Layer, Schema } from 'effect';
import { sha256 } from '@noble/hashes/sha2.js';
import { ClientApprovalEvidenceStore } from '../../services/client-approval-evidence';
import { DeviceIdentity } from '../../services/workspace';
import {
  openClientDatabase,
  bindingRaw,
  bindingId,
  sameBinding,
  sameScope,
  BindingSchema,
  boundedBytes,
  safeInt,
  attempt,
  decode,
  writeRow,
  equal,
} from './client-database';
import { failure, type Transaction } from './database';
import type { IndexedDbClientRpcStoreOptions } from './client-rpc';
const MAX_PAGE = 2 * 1024 * 1024,
  MAX_TOTAL = 72 * 1024 * 1024;
const Meta = Schema.Struct({
  version: Schema.Literal(1),
  binding: BindingSchema,
  session: Schema.String,
  count: Schema.Int,
  size: Schema.Int,
  digests: Schema.Array(Schema.Uint8Array),
});
const Page = Schema.Struct({
  version: Schema.Literal(1),
  binding: BindingSchema,
  session: Schema.String,
  index: Schema.Int,
  body: Schema.Uint8Array,
});
/** Immutable paged public approval evidence, scoped to one client incarnation. No authorization, secret material, crypto/network awaits or implicit reset occurs in these transactions. */
export const indexedDbClientApprovalEvidence = (input: IndexedDbClientRpcStoreOptions) => {
  const options = { ...input, binding: { ...input.binding } };
  return Layer.effect(
    ClientApprovalEvidenceStore,
    Effect.gen(function* () {
      const identity = yield* DeviceIdentity;
      const binding = yield* Effect.try({
        try: () => bindingRaw(options.binding),
        catch: () => failure('ClientApprovalEvidenceStore', 'corrupt'),
      });
      if (!identity.signer.publicKey.equals(options.binding.device))
        return yield* failure('ClientApprovalEvidenceStore', 'corrupt');
      const db = yield* openClientDatabase({
        databaseName: options.databaseName,
        mode: options.mode,
        accountId: binding.accountId,
        workspaceId: binding.workspaceId,
      });
      if (!sameScope(binding, db.bound))
        return yield* failure('ClientApprovalEvidenceStore', 'corrupt');
      const owner = bindingId(binding),
        bad = () => failure('ClientApprovalEvidenceStore', 'corrupt');
      const checkSession = (session: string) => {
        if (!/^[0-9a-f]{32}$/.test(session)) throw bad();
      };
      const metaKey = (session: string) => [owner, 'approval-evidence-meta', session];
      const pageKey = (session: string, index: number) => [
        owner,
        'approval-evidence-page',
        session,
        index,
      ];
      const range = (session: string) =>
        IDBKeyRange.bound(
          [owner, 'approval-evidence-page', session],
          [owner, 'approval-evidence-page', session, []]
        );
      const meta = (value: unknown, session: string) =>
        decode('ClientApprovalEvidenceStore', () => {
          const row = Schema.decodeUnknownSync(Meta, { onExcessProperty: 'error' })(value);
          if (
            !sameBinding(row.binding, binding) ||
            row.session !== session ||
            !safeInt(row.count, 1, 256) ||
            !safeInt(row.size, 1, MAX_TOTAL) ||
            row.digests.length !== row.count ||
            row.digests.some((hash) => !boundedBytes(hash, 32, 32))
          )
            throw bad();
          return row;
        });
      const page = (value: unknown, session: string, index: number) =>
        decode('ClientApprovalEvidenceStore', () => {
          const row = Schema.decodeUnknownSync(Page, { onExcessProperty: 'error' })(value);
          if (
            !sameBinding(row.binding, binding) ||
            row.session !== session ||
            row.index !== index ||
            !boundedBytes(row.body, MAX_PAGE)
          )
            throw bad();
          return row;
        });
      type Read = { meta: typeof Meta.Type; pages: Uint8Array[] } | null;
      const read = (tx: Transaction, session: string, done: (value: Read) => void) =>
        tx.request(tx.store('data').get(metaKey(session)), (value) => {
          if (value === undefined) {
            tx.request(tx.store('data').count(range(session)), (count) => {
              if (count !== 0) throw bad();
              done(null);
            });
            return;
          }
          const summary = meta(value, session),
            pages: Uint8Array[] = [];
          let size = 0;
          const cursor = tx.store('data').openCursor(range(session));
          tx.request(cursor, (item) => {
            if (!item) {
              if (pages.length !== summary.count || size !== summary.size) throw bad();
              done({ meta: summary, pages });
              return;
            }
            const index = pages.length;
            if (index >= summary.count || !equal(item.primaryKey, pageKey(session, index)))
              throw bad();
            const row = page(item.value, session, index);
            size += row.body.length;
            if (size > summary.size || size > MAX_TOTAL) throw bad();
            pages.push(new Uint8Array(row.body));
            item.continue();
          });
        });
      const validate = (value: Read) =>
        Effect.try({
          try: () => {
            if (!value) return null;
            if (value.pages.some((body, i) => !equal(sha256(body), value.meta.digests[i])))
              throw bad();
            return value.pages;
          },
          catch: () => bad(),
        });
      return ClientApprovalEvidenceStore.of({
        load: (session) =>
          attempt('ClientApprovalEvidenceStore', () => {
            checkSession(session);
            return db
              .run<Read>('ClientApprovalEvidenceStore', ['data'], 'readonly', (tx, done) =>
                read(tx, session, done)
              )
              .pipe(Effect.flatMap(validate));
          }),
        retain: (session, inputPages) =>
          attempt('ClientApprovalEvidenceStore', () => {
            checkSession(session);
            if (
              !Array.isArray(inputPages) ||
              !inputPages.length ||
              inputPages.length > 256 ||
              inputPages.some((body) => !boundedBytes(body, MAX_PAGE))
            )
              throw bad();
            const size = inputPages.reduce((sum, body) => sum + body.length, 0);
            if (size > MAX_TOTAL) throw failure('ClientApprovalEvidenceStore', 'capacity');
            const pages = inputPages.map((body) => new Uint8Array(body)),
              digests = pages.map((body) => sha256(body));
            return db.run<Uint8Array[]>(
              'ClientApprovalEvidenceStore',
              ['data'],
              'readwrite',
              (tx, done) =>
                read(tx, session, (previous) => {
                  if (previous) {
                    if (
                      !equal(
                        previous.meta.digests,
                        previous.pages.map((body) => sha256(body))
                      )
                    )
                      throw bad();
                    if (!equal(previous.pages, pages))
                      throw failure('ClientApprovalEvidenceStore', 'conflict');
                    done(previous.pages);
                    return;
                  }
                  const next = (index: number): void => {
                    if (index === pages.length) {
                      writeRow(
                        tx,
                        'data',
                        metaKey(session),
                        {
                          version: 1 as const,
                          binding,
                          session,
                          count: pages.length,
                          size,
                          digests,
                        },
                        (x) => meta(x, session),
                        () => done(pages.map((body) => new Uint8Array(body)))
                      );
                      return;
                    }
                    writeRow(
                      tx,
                      'data',
                      pageKey(session, index),
                      { version: 1 as const, binding, session, index, body: pages[index] },
                      (x) => page(x, session, index),
                      () => next(index + 1)
                    );
                  };
                  next(0);
                })
            );
          }),
      });
    })
  );
};
