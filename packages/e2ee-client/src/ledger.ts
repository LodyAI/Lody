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
  requireLedgerContinuation,
} from '@lody/e2ee-core/protocol';
import {
  LedgerFeedStore,
  LedgerFeedSource,
  LedgerSync,
  LedgerLog,
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
          const original = approval.originalOrigin,
            receipt = original.invitation;
          if (receipt.workspaceId !== approval.offer.workspaceId || receipt.length > full.length)
            return yield* fail('conflict');
          const records = approval.pages
            .flatMap((page) => page.recordsHex)
            .slice(0, receipt.length)
            .map(fromHex);
          const prefix = yield* verifyLedgerEffect({
            anchor: genesis,
            records,
            checkpoint: { head: receipt.head, length: receipt.length },
          });
          // Historical manager qualification comes from freshly replayed signed history, never from the old cached label or lost KEK.
          const trust = yield* Effect.fromResult(
            snapshotTrustFromView(prefix, original.endorser, receipt.headSignature)
          );
          originView = prefix;
          origin = {
            kind: 'snapshot',
            snapshot: { bytes: new Uint8Array(receipt.snapshot), offset: receipt.offset, trust },
          };
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
          budget: { maxRecords: 16384, maxBytes: 32 * 1024 * 1024 },
        }).pipe(
          Layer.provide(
            Layer.merge(
              Layer.succeed(WorkspaceScope, { genesis }),
              Layer.succeed(LedgerFeedStore, store)
            )
          )
        )
      );
      const feed = Context.get(services, LedgerFeed);
      const refresh = Effect.fnUntraced(function* () {
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
          const length =
            state.view.length +
            page.records.length -
            (state.bootstrap && page.records.length ? 1 : 0);
          const head = page.records.length ? hashRecordBytes(page.records.at(-1)) : state.view.head;
          const next = yield* feed.accept(page, { head, length });
          if (page.upToDate) return next;
        }
        return yield* new LedgerFeedError({ code: 'read-too-large' });
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
        Context.add(LedgerLog, { read: readLog, appendCas: append })
      );
    })
  );
