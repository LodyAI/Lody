/**
 * Loro / Durable Streams adapters for the backend ledger ports.
 *
 * The ledger is one append-only control stream of u32be-framed signed records;
 * {@link streamsLedgerLog} implements {@link LedgerLog} (full-audit read +
 * offset CAS append) and {@link streamsLedgerFeedSource} implements
 * {@link LedgerFeedSource} (paged reads). Both take the released
 * `@durable-streams/client` 0.9 shape structurally, so the caller owns the SDK,
 * its URL, auth and timeouts. {@link streamsDocumentBinding} protects document
 * updates and snapshots for `@loro-dev/streams-crdt`. Details: `./README.md`.
 *
 * @module
 */
export {
  makeStreamsLedgerLog,
  streamsLedgerLog,
  type LedgerSubmissionStream,
  type StreamsLedgerLogOptions,
} from './ledger-log';
export {
  makeLedgerStreamReader,
  streamsLedgerFeedSource,
  type LedgerStreamReader,
} from './ledger-feed-source';
export {
  makeStreamsUpdateBinding,
  streamsDocumentBinding,
  type StreamsDocumentBindingOptions,
} from './document-binding';
export { makeRealtimeContentBinding } from './realtime-binding';
