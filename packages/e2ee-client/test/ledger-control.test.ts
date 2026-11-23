import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, Effect, Layer, Result } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  sqliteLedgerFeedStore,
  sqliteLedgerPinStore,
  sqliteSubmissionJournal,
} from '@lody/e2ee-core/adapters/node-sqlite';
import {
  commitEpochKey,
  hashRecordBytes,
  prepareLedgerRecord,
  sealHistoryPacket,
  signLedgerRecord,
  signLedgerSnapshot,
  verifyLedger,
} from '@lody/e2ee-core/protocol';
import { Bytes } from '@lody/e2ee-core';
import {
  LedgerFeedSource,
  LedgerLog,
  LedgerLogError,
  LedgerSync,
  WorkspaceScope,
} from '@lody/e2ee-core/services';
import { encodeCbor } from '../../e2ee-core/src/internal/foundation/cbor';
import { disposeEpochKey } from '../../e2ee-core/src/internal/foundation/epoch-key';
import { envelopeFixture } from '../../e2ee-core/test/keys/fixture';
import { personalLedgerControl } from '../src/ledger';
import { verifyPersonalApproval, type PersonalPairingOffer } from '../src/pairing';

const hex = (a: Uint8Array) => Buffer.from(a).toString('hex');
const ok = Result.getOrThrow;

describe('personalLedgerControl suffix readFrom', () => {
  it('synthesizes incremental readFrom over LedgerFeedSource when LedgerLog omits readFrom and forwards injected readFrom', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'e2ee-ledger-control-'));
    const f = envelopeFixture();
    const rotatedKey = ok(Bytes.epochKey(new Uint8Array(32).fill(0x51)));
    try {
      const records: Uint8Array[] = f.records();
      const offer: PersonalPairingOffer = {
        version: 1,
        workspaceId: 'workspace-A',
        genesisHash: hex(f.context.genesis.toBytes()),
        genesisRecordHex: hex(f.genesisRecord),
        endorser: hex(f.owner.raw),
        membershipId: '0a'.repeat(16),
        pairingSessionId: '11'.repeat(16),
      };
      const invitation = {
        workspaceId: offer.workspaceId,
        ...(await Effect.runPromise(
          signLedgerSnapshot({ signer: f.owner.signer, ledger: f.ledger })
        )),
        offset: `opaque/${records.length}`,
      };
      const verified = ok(verifyPersonalApproval(offer, invitation));
      const approval = {
        kind: 'snapshot' as const,
        offer,
        invitation,
        view: verified.view,
      };
      const nextBody = ok(
        encodeCbor([
          verified.view.head.toBytes(),
          f.owner.raw,
          [
            7,
            1,
            ok(commitEpochKey(f.context.genesis, 1, rotatedKey)).toBytes(),
            ok(
              sealHistoryPacket({
                genesis: f.context.genesis,
                epoch: 1,
                currentKey: rotatedKey,
                previousKey: f.secret,
              })
            ),
          ],
        ])
      );
      const nextRecord = await Effect.runPromise(
        signLedgerRecord(ok(prepareLedgerRecord(verified.view, nextBody)), f.owner.signer)
      );

      let fullReads = 0;
      const afterOffsets: string[] = [];
      const ws = Layer.succeed(WorkspaceScope, { genesis: f.context.genesis });
      const stores = Layer.mergeAll(
        ws,
        sqliteLedgerFeedStore({ path: join(dir, 'feed.sqlite'), mode: 'create' }).pipe(
          Layer.provide(ws)
        ),
        sqliteLedgerPinStore({ path: join(dir, 'pins.sqlite'), mode: 'create' }).pipe(
          Layer.provide(ws)
        ),
        sqliteSubmissionJournal({ path: join(dir, 'journal.sqlite') }).pipe(Layer.provide(ws))
      );

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const ctx = yield* Layer.build(
              personalLedgerControl({ approval }).pipe(
                Layer.provide(
                  Layer.mergeAll(
                    stores,
                    Layer.succeed(LedgerFeedSource, {
                      readAfter: (offset) =>
                        Effect.sync(() => {
                          afterOffsets.push(offset);
                          const start = Number(offset.split('/')[1] ?? '0');
                          return {
                            requestOffset: offset,
                            nextOffset: `opaque/${records.length}`,
                            records: records.slice(start),
                            upToDate: true,
                          };
                        }),
                    }),
                    Layer.succeed(LedgerLog, {
                      read: () =>
                        Effect.sync(() => {
                          fullReads++;
                          return {
                            records: records.slice(),
                            checkpoint: {
                              head: hashRecordBytes(records.at(-1)!),
                              length: records.length,
                            },
                          };
                        }),
                      appendCas: () => Effect.fail(new LedgerLogError({})),
                    })
                  )
                )
              )
            );
            const log = Context.get(ctx, LedgerLog);
            const sync = Context.get(ctx, LedgerSync);
            expect(log.readFrom).toBeDefined();

            records.push(nextRecord);
            const suffix = yield* log.readFrom!(f.context.genesis, verified.view);
            expect(fullReads).toBe(0);
            expect(afterOffsets).toEqual([`opaque/${records.length - 1}`]);
            expect(suffix.records.map(hex)).toEqual([hex(nextRecord)]);
            expect(suffix.checkpoint.length).toBe(records.length);
            expect((yield* sync.current()).view.length).toBe(records.length);
          })
        )
      );

      let injectedCalls = 0;
      const allView = ok(
        verifyLedger({
          anchor: f.context.genesis,
          records,
          checkpoint: { head: hashRecordBytes(records.at(-1)!), length: records.length },
        })
      );
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const ctx = yield* Layer.build(
              personalLedgerControl({ approval }).pipe(
                Layer.provide(
                  Layer.mergeAll(
                    ws,
                    sqliteLedgerFeedStore({
                      path: join(dir, 'feed-2.sqlite'),
                      mode: 'create',
                    }).pipe(Layer.provide(ws)),
                    sqliteLedgerPinStore({
                      path: join(dir, 'pins-2.sqlite'),
                      mode: 'create',
                    }).pipe(Layer.provide(ws)),
                    sqliteSubmissionJournal({ path: join(dir, 'journal-2.sqlite') }).pipe(
                      Layer.provide(ws)
                    ),
                    Layer.succeed(LedgerFeedSource, {
                      readAfter: (offset) =>
                        Effect.succeed({
                          requestOffset: offset,
                          nextOffset: offset,
                          records: [],
                          upToDate: true,
                        }),
                    }),
                    Layer.succeed(LedgerLog, {
                      readFrom: (_anchor, base) =>
                        Effect.sync(() => {
                          injectedCalls++;
                          return {
                            records: records.slice(base.length),
                            checkpoint: { head: allView.head, length: records.length },
                          };
                        }),
                      read: () => Effect.fail(new LedgerLogError({})),
                      appendCas: () => Effect.fail(new LedgerLogError({})),
                    })
                  )
                )
              )
            );
            const suffix = yield* Context.get(ctx, LedgerLog).readFrom!(
              f.context.genesis,
              verified.view
            );
            expect(injectedCalls).toBe(1);
            expect(suffix.records.map(hex)).toEqual([hex(nextRecord)]);
          })
        )
      );
    } finally {
      disposeEpochKey(rotatedKey);
      disposeEpochKey(f.secret);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
