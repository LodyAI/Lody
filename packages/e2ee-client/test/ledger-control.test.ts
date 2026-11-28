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

async function setupLedgerControlFixture(workspaceId: string) {
  const dir = await mkdtemp(join(tmpdir(), 'e2ee-ledger-control-'));
  const f = envelopeFixture();
  const rotatedKey = ok(Bytes.epochKey(new Uint8Array(32).fill(0x51)));
  const records: Uint8Array[] = f.records();
  const initialOffset = `opaque/${records.length}`;
  const offer: PersonalPairingOffer = {
    version: 1,
    workspaceId,
    genesisHash: hex(f.context.genesis.toBytes()),
    genesisRecordHex: hex(f.genesisRecord),
    endorser: hex(f.owner.raw),
    membershipId: '0a'.repeat(16),
    pairingSessionId: '11'.repeat(16),
  };
  const invitation = {
    workspaceId: offer.workspaceId,
    ...(await Effect.runPromise(signLedgerSnapshot({ signer: f.owner.signer, ledger: f.ledger }))),
    offset: initialOffset,
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
  const ws = Layer.succeed(WorkspaceScope, { genesis: f.context.genesis });
  const stores = (suffix: string) =>
    Layer.mergeAll(
      ws,
      sqliteLedgerFeedStore({ path: join(dir, `feed-${suffix}.sqlite`), mode: 'create' }).pipe(
        Layer.provide(ws)
      ),
      sqliteLedgerPinStore({ path: join(dir, `pins-${suffix}.sqlite`), mode: 'create' }).pipe(
        Layer.provide(ws)
      ),
      sqliteSubmissionJournal({ path: join(dir, `journal-${suffix}.sqlite`) }).pipe(
        Layer.provide(ws)
      )
    );
  const cleanup = async () => {
    disposeEpochKey(rotatedKey);
    disposeEpochKey(f.secret);
    await rm(dir, { recursive: true, force: true });
  };
  return { f, records, initialOffset, verified, approval, nextRecord, stores, cleanup };
}

describe('personalLedgerControl suffix readFrom', () => {
  it('synthesizes incremental readFrom over LedgerFeedSource when LedgerLog omits readFrom and respects preferFeedSuffix', async () => {
    const fx = await setupLedgerControlFixture('workspace-A');
    try {
      let fullReads = 0;
      const afterOffsets: string[] = [];
      const feedSource = Layer.succeed(LedgerFeedSource, {
        readAfter: (offset) =>
          Effect.sync(() => {
            afterOffsets.push(offset);
            const start = Number(offset.split('/')[1] ?? '0');
            return {
              requestOffset: offset,
              nextOffset: `opaque/${fx.records.length}`,
              records: fx.records.slice(start),
              upToDate: true,
            };
          }),
      });

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const ctx = yield* Layer.build(
              personalLedgerControl({ approval: fx.approval }).pipe(
                Layer.provide(
                  Layer.mergeAll(
                    fx.stores('1'),
                    feedSource,
                    Layer.succeed(LedgerLog, {
                      read: () =>
                        Effect.sync(() => {
                          fullReads++;
                          return {
                            records: fx.records.slice(),
                            checkpoint: {
                              head: hashRecordBytes(fx.records.at(-1)!),
                              length: fx.records.length,
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

            fx.records.push(fx.nextRecord);
            const suffix = yield* log.readFrom!(fx.f.context.genesis, fx.verified.view);
            expect(fullReads).toBe(0);
            expect(afterOffsets).toEqual([fx.initialOffset]);
            expect(suffix.records.map(hex)).toEqual([hex(fx.nextRecord)]);
            expect(suffix.checkpoint.length).toBe(fx.records.length);
            expect((yield* sync.current()).view.length).toBe(fx.records.length);
          })
        )
      );

      const allView = ok(
        verifyLedger({
          anchor: fx.f.context.genesis,
          records: fx.records,
          checkpoint: { head: hashRecordBytes(fx.records.at(-1)!), length: fx.records.length },
        })
      );
      for (const preferFeedSuffix of [false, true]) {
        let injectedCalls = 0;
        afterOffsets.length = 0;
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const ctx = yield* Layer.build(
                personalLedgerControl({ approval: fx.approval, preferFeedSuffix }).pipe(
                  Layer.provide(
                    Layer.mergeAll(
                      fx.stores(preferFeedSuffix ? '3' : '2'),
                      feedSource,
                      Layer.succeed(LedgerLog, {
                        readFrom: (_anchor, base) =>
                          Effect.sync(() => {
                            injectedCalls++;
                            return {
                              records: fx.records.slice(base.length),
                              checkpoint: { head: allView.head, length: fx.records.length },
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
                fx.f.context.genesis,
                fx.verified.view
              );
              expect(suffix.records.map(hex)).toEqual([hex(fx.nextRecord)]);
              expect(injectedCalls).toBe(preferFeedSuffix ? 0 : 1);
              expect(afterOffsets).toEqual(preferFeedSuffix ? [fx.initialOffset] : []);
            })
          )
        );
      }
    } finally {
      await fx.cleanup();
    }
  });
});
