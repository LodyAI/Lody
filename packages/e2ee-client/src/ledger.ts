import { Context, Effect, Layer, Result } from 'effect';
import {
  LedgerFeed,
  LedgerFeedError,
  type LedgerFeedOrigin,
  type WorkspaceInvitationSnapshot,
  type LedgerView,
} from '@lody/e2ee-core';
import {
  Bytes,
  hashRecordBytes,
  snapshotTrustFromView,
  verifyLedgerEffect,
  verifyLedgerSnapshot,
  requireLedgerContinuation,
} from '@lody/e2ee-core/protocol';
import {
  LedgerFeedStore,
  LedgerFeedSource,
  LedgerSync,
  LedgerLog,
  LedgerLogError,
  LedgerPinStore,
  SubmissionJournal,
  WorkspaceScope,
} from '@lody/e2ee-core/services';
import { verifyPersonalApproval, verifyPersonalOffer } from './pairing';
import { verifyPersonalHistory } from './admission';
import { fromHex } from './bytes';
import { fail } from './errors';
import type { PersonalApproval } from './platform';

/** First signed snapshot original, retained separately from later identity approvals. It is untrusted until qualified on each open. */
export interface PersonalLedgerOrigin {
  readonly invitation: WorkspaceInvitationSnapshot;
  readonly endorser: Bytes.SigningPublicKey;
}

/** Requalify the unchanged snapshot from its independently replayed signed prefix. */
export const qualifyPersonalLedgerOrigin = Effect.fnUntraced(function* (
  approval: Extract<PersonalApproval, { kind: 'history' }>
) {
  const original = approval.originalOrigin;
  if (!original) return yield* fail('invalid-input');
  const receipt = original.invitation;
  if (receipt.workspaceId !== approval.offer.workspaceId || receipt.length > approval.view.length)
    return yield* fail('history-conflict');
  const prefix = yield* verifyLedgerEffect({
    anchor: approval.view.genesis,
    records: approval.pages
      .flatMap((page) => page.recordsHex)
      .slice(0, receipt.length)
      .map(fromHex),
    checkpoint: { head: receipt.head, length: receipt.length },
  });
  const trust = yield* Effect.fromResult(
    snapshotTrustFromView(prefix, original.endorser, receipt.headSignature)
  );
  const view = yield* Effect.fromResult(
    verifyLedgerSnapshot({ snapshot: receipt.snapshot, trust })
  );
  return {
    view,
    snapshot: { bytes: new Uint8Array(receipt.snapshot), offset: receipt.offset, trust },
  };
});
/** Feed and submission composition over injected ports, preserving a single origin and rollback pin across local identity replacement. */
export const personalLedgerControl = (input: { readonly approval: PersonalApproval }) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const approval = input.approval,
        genesis = (yield* WorkspaceScope).genesis;
      if (!genesis.equals(approval.view.genesis)) return yield* fail('scope-mismatch');
      const store = yield* LedgerFeedStore,
        source = yield* LedgerFeedSource,
        pins = yield* LedgerPinStore,
        submissions = yield* SubmissionJournal,
        log = yield* LedgerLog;
      const readAfter = source.readAfter.bind(source),
        readLog = log.read.bind(log),
        injectedReadFrom = log.readFrom?.bind(log),
        append = log.appendCas.bind(log);
      let origin: LedgerFeedOrigin, originView: LedgerView;
      if (approval.kind === 'snapshot') {
        const verified = yield* Effect.fromResult(
          verifyPersonalApproval(approval.offer, approval.invitation)
        );
        yield* Effect.fromResult(requireLedgerContinuation(verified.view, approval.view));
        origin = { kind: 'snapshot', snapshot: verified.snapshot };
        originView = verified.view;
      } else {
        const full = yield* verifyPersonalHistory(approval.offer, approval.pages);
        yield* Effect.fromResult(requireLedgerContinuation(full, approval.view));
        if (approval.originalOrigin) {
          const qualified = yield* qualifyPersonalLedgerOrigin(approval);
          originView = qualified.view;
          origin = { kind: 'snapshot', snapshot: qualified.snapshot };
        } else {
          origin = { kind: 'genesis', record: fromHex(approval.offer.genesisRecordHex) };
          originView = yield* Effect.fromResult(verifyPersonalOffer(approval.offer));
        }
      }
      const tail = yield* store.tail();
      const expected = tail
        ? { head: Result.getOrThrow(Bytes.recordHash(tail.head)), length: tail.count }
        : { head: originView.head, length: originView.length };
      const services = yield* Layer.build(
        LedgerFeed.layer({
          origin,
          expected,
          // Counts the suffix after the verified origin, not the absolute ledger sequence.
          budget: { maxRecords: 16384, maxBytes: 32 * 1024 * 1024 },
        }).pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(WorkspaceScope, { genesis }),
              Layer.succeed(LedgerFeedStore, store),
              Layer.succeed(LedgerFeedSource, source),
              Layer.succeed(LedgerPinStore, pins)
            )
          )
        )
      );
      const feed = Context.get(services, LedgerFeed);
      const advanceFeed = Effect.fnUntraced(function* () {
        const suffix: Uint8Array[] = [];
        let total = 0,
          count = 0;
        for (let pageIndex = 0; pageIndex < 256; pageIndex++) {
          const state = yield* feed.current(),
            page = yield* readAfter(state.offset);
          if (!Array.isArray(page.records) || page.records.length > 64)
            return yield* new LedgerFeedError({ code: 'read-too-large' });
          for (const record of page.records) {
            if (!(record instanceof Uint8Array))
              return yield* new LedgerFeedError({ code: 'invalid-frame' });
            total += record.length;
            count++;
          }
          if (count > 16384 || total > 32 * 1024 * 1024)
            return yield* new LedgerFeedError({ code: 'read-too-large' });
          const added =
            state.bootstrap && page.records.length ? page.records.slice(1) : page.records;
          const length = state.view.length + added.length;
          const head = page.records.length ? hashRecordBytes(page.records.at(-1)) : state.view.head;
          const next = yield* feed.accept(page, { head, length });
          for (const record of added) suffix.push(new Uint8Array(record));
          if (page.upToDate) return { next, suffix };
        }
        return yield* new LedgerFeedError({ code: 'read-too-large' });
      });
      const refresh = Effect.fnUntraced(function* () {
        return (yield* advanceFeed()).next;
      });
      const readSuffix = Effect.fnUntraced(function* (anchor: Bytes.GenesisHash, base: LedgerView) {
        if (!anchor.equals(genesis)) return yield* new LedgerLogError({});
        const start = yield* feed
          .current()
          .pipe(Effect.mapError((cause) => new LedgerLogError({ cause })));
        if (start.view.length !== base.length || !start.view.head.equals(base.head)) {
          const full = yield* readLog(anchor);
          if (full.records.length < base.length || full.checkpoint.length < base.length)
            return yield* new LedgerLogError({});
          return {
            records: full.records.slice(base.length),
            checkpoint: full.checkpoint,
          };
        }
        const { next, suffix } = yield* advanceFeed().pipe(
          Effect.mapError((cause) => new LedgerLogError({ cause }))
        );
        return {
          records: suffix,
          checkpoint: { head: next.view.head, length: next.view.length },
        };
      });
      const current = Effect.fnUntraced(function* () {
        const state = yield* feed.current();
        yield* Effect.fromResult(requireLedgerContinuation(approval.view, state.view));
        return state;
      });
      if (approval.kind === 'history') {
        const local = yield* feed.current();
        if (local.view.length < approval.view.length) {
          // A missing suffix requires I/O; a conflicting local prefix never does.
          yield* Effect.fromResult(requireLedgerContinuation(local.view, approval.view));
          yield* refresh();
        }
        // Re-verified persisted state can satisfy an already installed approval offline.
        yield* current();
      }
      return Context.make(LedgerSync, { current, refresh }).pipe(
        Context.add(LedgerPinStore, pins),
        Context.add(SubmissionJournal, submissions),
        Context.add(LedgerLog, {
          read: readLog,
          readFrom: injectedReadFrom ?? readSuffix,
          appendCas: append,
        })
      );
    })
  );
