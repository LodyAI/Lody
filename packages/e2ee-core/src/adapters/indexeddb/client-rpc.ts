import { Effect, Layer, Schema } from 'effect';
import { ClientRpcOriginalStore, type ClientRpcOriginal } from '../../services/client-rpc';
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
import type { IndexedDbClientKeyStoreOptions } from './client-key-stores';

/** Scoped immutable RPC ciphertext storage; distinct from pairing, key-delivery and execution journals. */
export type IndexedDbClientRpcStoreOptions = Omit<IndexedDbClientKeyStoreOptions, 'maxTasks'>;
const MAX_FRAME = 1024 * 1024;
// A retained request can contain the existing multi-frame feature bundle.
const MAX_ORIGINAL = 32 * 1024 * 1024;
const Record = Schema.Struct({
  target: Schema.String,
  signer: Schema.String,
  frame: Schema.Uint8Array,
});
const RequestRow = Schema.Struct({
  version: Schema.Literal(1),
  binding: BindingSchema,
  direction: Schema.Literals(['sent', 'received']),
  key: Schema.String,
  record: Record,
});
const ResponseRow = Schema.Struct({
  version: Schema.Literal(1),
  binding: BindingSchema,
  key: Schema.String,
  sequence: Schema.Int,
  frame: Schema.Uint8Array,
});
const validKey = (key: string) => typeof key === 'string' && key.length > 0 && key.length <= 4096;
/** First-winner requests and atomic response batches in the stable client database. No signature, approval or network work occurs here. */
export const indexedDbClientRpcOriginals = (input: IndexedDbClientRpcStoreOptions) => {
  const options = { ...input, binding: { ...input.binding } };
  return Layer.effect(
    ClientRpcOriginalStore,
    Effect.gen(function* () {
      const identity = yield* DeviceIdentity;
      const binding = yield* Effect.try({
        try: () => bindingRaw(options.binding),
        catch: () => failure('ClientRpcOriginalStore', 'corrupt'),
      });
      if (!identity.signer.publicKey.equals(options.binding.device))
        return yield* failure('ClientRpcOriginalStore', 'corrupt');
      const db = yield* openClientDatabase({
        databaseName: options.databaseName,
        mode: options.mode,
        accountId: binding.accountId,
        workspaceId: binding.workspaceId,
      });
      if (!sameScope(binding, db.bound)) return yield* failure('ClientRpcOriginalStore', 'corrupt');
      const owner = bindingId(binding),
        bad = () => failure('ClientRpcOriginalStore', 'corrupt');
      const record = (value: unknown): ClientRpcOriginal =>
        decode('ClientRpcOriginalStore', () => {
          const parsed = Schema.decodeUnknownSync(Record, { onExcessProperty: 'error' })(value);
          if (
            !parsed.target.length ||
            parsed.target.length > 256 ||
            !/^[0-9a-f]{64}$/.test(parsed.signer) ||
            !boundedBytes(parsed.frame, MAX_ORIGINAL)
          )
            throw bad();
          return { ...parsed, frame: new Uint8Array(parsed.frame) };
        });
      const request = (value: unknown, direction: 'sent' | 'received', key: string) =>
        decode('ClientRpcOriginalStore', () => {
          const row = Schema.decodeUnknownSync(RequestRow, { onExcessProperty: 'error' })(value);
          if (!sameBinding(row.binding, binding) || row.direction !== direction || row.key !== key)
            throw bad();
          return { ...row, record: record(row.record) };
        });
      const response = (value: unknown, key: string, sequence: number) =>
        decode('ClientRpcOriginalStore', () => {
          const row = Schema.decodeUnknownSync(ResponseRow, { onExcessProperty: 'error' })(value);
          if (
            !sameBinding(row.binding, binding) ||
            row.key !== key ||
            row.sequence !== sequence ||
            !boundedBytes(row.frame, MAX_FRAME)
          )
            throw bad();
          return { ...row, frame: new Uint8Array(row.frame) };
        });
      const requestKey = (direction: string, key: string) => [
        owner,
        'rpc-original',
        direction,
        key,
      ];
      const responseKey = (key: string, sequence: number) => [owner, 'rpc-response', key, sequence];
      const frame = (value: Uint8Array) => {
        if (!boundedBytes(value, MAX_FRAME)) throw bad();
        return new Uint8Array(value);
      };
      const check = (key: string, sequence = 0) => {
        if (!validKey(key) || !safeInt(sequence, 0, 127)) throw bad();
      };
      const writePage = (
        tx: Transaction,
        key: string,
        sequence: number,
        bytes: Uint8Array,
        done: () => void
      ) => {
        const slot = responseKey(key, sequence);
        tx.request(tx.store('data').get(slot), (value) => {
          if (value !== undefined) {
            if (!equal(response(value, key, sequence).frame, bytes))
              throw failure('ClientRpcOriginalStore', 'conflict');
            done();
            return;
          }
          writeRow(
            tx,
            'data',
            slot,
            { version: 1 as const, binding, key, sequence, frame: bytes },
            (x) => response(x, key, sequence),
            done
          );
        });
      };
      return ClientRpcOriginalStore.of({
        read: (direction, key) =>
          attempt('ClientRpcOriginalStore', () => {
            check(key);
            if (!['sent', 'received'].includes(direction)) throw bad();
            return db.run('ClientRpcOriginalStore', ['data'], 'readonly', (tx, done) =>
              tx.request(tx.store('data').get(requestKey(direction, key)), (value) =>
                done(
                  value === undefined ? undefined : record(request(value, direction, key).record)
                )
              )
            );
          }),
        retain: (direction, key, inputRecord) =>
          attempt('ClientRpcOriginalStore', () => {
            check(key);
            if (
              !['sent', 'received'].includes(direction) ||
              !boundedBytes(inputRecord.frame, MAX_ORIGINAL)
            )
              throw bad();
            const original = record(inputRecord);
            return db.run('ClientRpcOriginalStore', ['data'], 'readwrite', (tx, done) =>
              tx.request(tx.store('data').get(requestKey(direction, key)), (value) => {
                if (value !== undefined) {
                  const saved = record(request(value, direction, key).record);
                  if (direction === 'received' && !equal(saved, original))
                    throw failure('ClientRpcOriginalStore', 'conflict');
                  done(saved);
                  return;
                }
                writeRow(
                  tx,
                  'data',
                  requestKey(direction, key),
                  { version: 1 as const, binding, direction, key, record: original },
                  (x) => request(x, direction, key),
                  (saved) => done(record(saved.record))
                );
              })
            );
          }),
        readResponse: (key, sequence) =>
          attempt('ClientRpcOriginalStore', () => {
            check(key, sequence);
            return db.run('ClientRpcOriginalStore', ['data'], 'readonly', (tx, done) =>
              tx.request(tx.store('data').get(responseKey(key, sequence)), (value) =>
                done(value === undefined ? undefined : response(value, key, sequence).frame)
              )
            );
          }),
        retainResponse: (key, sequence, bytes) =>
          attempt('ClientRpcOriginalStore', () => {
            check(key, sequence);
            const body = frame(bytes);
            return db.run<void>('ClientRpcOriginalStore', ['data'], 'readwrite', (tx, done) =>
              writePage(tx, key, sequence, body, () => done(undefined))
            );
          }),
        retainResponsePages: (key, frames) =>
          attempt('ClientRpcOriginalStore', () => {
            check(key);
            if (
              !Array.isArray(frames) ||
              !frames.length ||
              frames.length > 128 ||
              frames.some((x) => !boundedBytes(x, MAX_FRAME)) ||
              frames.reduce((sum, x) => sum + x.length, 0) > 32 * 1024 * 1024
            )
              throw bad();
            const pages = frames.map(frame);
            return db.run<void>('ClientRpcOriginalStore', ['data'], 'readwrite', (tx, done) => {
              const next = (sequence: number): void => {
                if (sequence === pages.length) {
                  done(undefined);
                  return;
                }
                writePage(tx, key, sequence, pages[sequence], () => next(sequence + 1));
              };
              next(0);
            });
          }),
        close: db.close,
      });
    })
  );
};
