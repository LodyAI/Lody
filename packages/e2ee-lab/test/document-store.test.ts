import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Effect, Exit, Result, Scope } from 'effect';
import { expect, it } from 'vitest';
import { makeLabDocumentStore, type LabSealedWrite } from '../src/platform/document-sqlite';

const original = (): LabSealedWrite => ({
  plaintextDigest: createHash('sha256').update('synthetic unacknowledged local edit').digest('hex'),
  context: JSON.stringify(['loro-streams-crdt-payload-protection', 2, 'update_batch', null]),
  aad: new Uint8Array([10, 11]),
  header: new Uint8Array([12, 13]),
  sealed: new Uint8Array([14, 15, 16]),
});
const config = (path: string) => ({
  path,
  genesis: '01'.repeat(32),
  resource: 'synthetic-document',
  model: 'loro' as const,
  streamUrl: 'http://localhost/synthetic-document',
});

it('retains exact unacknowledged sealed originals across close/open and clears only on confirmation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lab-document-writes-'));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const child = yield* Effect.acquireRelease(Scope.make(), (scope) =>
            Scope.close(scope, Exit.void)
          );
          const first = yield* makeLabDocumentStore({
            ...config(join(root, 'document.sqlite')),
            mode: 'create',
          }).pipe(Effect.provideService(Scope.Scope, child));
          const row = original();
          const retained = original();
          Result.getOrThrow(first.sealedWrites.save(row));
          Result.getOrThrow(first.sealedWrites.save(original()));
          row.aad.fill(90);
          row.header.fill(91);
          row.sealed.fill(92);
          expect(Result.getOrThrow(first.sealedWrites.load())).toEqual([retained]);
          expect(
            Result.isFailure(first.sealedWrites.save({ ...retained, sealed: new Uint8Array([99]) }))
          ).toBe(true);
          expect(Result.getOrThrow(first.sealedWrites.load())).toEqual([retained]);
          const borrowed = Result.getOrThrow(first.sealedWrites.load())[0]!;
          borrowed.header.fill(88);
          expect(Result.getOrThrow(first.sealedWrites.load())).toEqual([retained]);
          yield* Scope.close(child, Exit.void);
          expect(first.sealedWrites.load()).toMatchObject({
            _tag: 'Failure',
            failure: { code: 'closed' },
          });
          expect(first.sealedWrites.save(original())).toMatchObject({
            _tag: 'Failure',
            failure: { code: 'closed' },
          });
          expect(first.sealedWrites.clear()).toMatchObject({
            _tag: 'Failure',
            failure: { code: 'closed' },
          });
          const second = yield* makeLabDocumentStore({
            ...config(join(root, 'document.sqlite')),
            mode: 'open',
          });
          expect(Result.getOrThrow(second.sealedWrites.load())).toEqual([retained]);
          Result.getOrThrow(second.sealedWrites.clear());
          expect(Result.getOrThrow(second.sealedWrites.load())).toEqual([]);
        })
      )
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const reopened = yield* makeLabDocumentStore({
            ...config(join(root, 'document.sqlite')),
            mode: 'open',
          });
          expect(Result.getOrThrow(reopened.sealedWrites.load())).toEqual([]);
        })
      )
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('does not dispatch a phantom sealed original when its insert fails and retains originals if confirmation cannot commit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lab-document-write-fault-'));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const path = join(root, 'document.sqlite');
          const store = yield* makeLabDocumentStore({ ...config(path), mode: 'create' });
          const native = new Database(path);
          try {
            native.exec(
              'CREATE TRIGGER deny_write BEFORE INSERT ON lab_document_writes BEGIN SELECT RAISE(IGNORE);END'
            );
            expect(Result.isFailure(store.sealedWrites.save(original()))).toBe(true);
            expect(Result.getOrThrow(store.sealedWrites.load())).toEqual([]);
            native.exec('DROP TRIGGER deny_write');
            Result.getOrThrow(store.sealedWrites.save(original()));
            native.exec(
              "CREATE TRIGGER deny_clear BEFORE DELETE ON lab_document_writes BEGIN SELECT RAISE(ABORT,'synthetic failed acknowledgement');END"
            );
            expect(Result.isFailure(store.sealedWrites.clear())).toBe(true);
            expect(Result.getOrThrow(store.sealedWrites.load())).toEqual([original()]);
            native.exec('DROP TRIGGER deny_clear');
            Result.getOrThrow(store.sealedWrites.clear());
            expect(Result.getOrThrow(store.sealedWrites.load())).toEqual([]);
          } finally {
            native.close();
          }
        })
      )
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
