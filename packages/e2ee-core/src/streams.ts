import type { StreamsClient } from '@loro-dev/streams-client';
export { createBoundedStreamsFetch } from './streams-fetch';
export type { BoundedStreamsFetchOptions, StreamsRequestLease } from './streams-fetch';
import {
  checkOffset,
  MAX_READ_BYTES,
  MAX_READ_PAGES,
  MAX_READ_RECORDS,
  type ControlReadPage,
  type ControlStream,
} from './client';
import {
  checkHex,
  fromHex,
  toHex,
  ControlLogError,
  decodeRecord,
  invariant,
  MAX_WIRE_BYTES,
} from './wire';
import type { HistoryPublicationRemote } from './history-publisher';
import type { KeyDeliveryRemote } from './key-delivery';
import type { OrgKeyExchange } from './org-key-exchange';
import { MAX_KEY_ENVELOPE_BYTES } from './key-envelope';

export const CONTROL_STREAM_CONTENT_TYPE = 'application/octet-stream';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** One append contains a u32 big-endian byte length followed by the exact canonical wire. */
export function frameControlRecord(wire: string): Uint8Array {
  decodeRecord(wire);
  const bytes = encoder.encode(wire);
  const framed = new Uint8Array(4 + bytes.length);
  new DataView(framed.buffer).setUint32(0, bytes.length, false);
  framed.set(bytes, 4);
  return framed;
}

/** Opt-in SDK boundary; the caller owns URL, credentials, deadlines and stream creation.
 * read() buffers HTTP bodies in SDK 0.7.0: cap response bodies in the supplied transport.
 * No server metadata can replace the caller's independently accepted Org genesis.
 */
export class StreamsControlStream implements ControlStream {
  readonly initialOffset = '-1';

  constructor(private readonly client: Pick<StreamsClient, 'read' | 'appendCas'>) {}

  async readAfter(offset: string): Promise<ControlReadPage> {
    checkOffset(offset);
    const visited = new Set([offset]);
    const records: string[] = [];
    let cursor = offset;
    let pending = new Uint8Array(0);
    let bytesRead = 0;

    for (let count = 0; count < MAX_READ_PAGES; count++) {
      const response = await this.client.read({ offset: cursor });
      if (!response.ok) throw new ControlLogError(`stream-read-${response.result.code}`);
      const page = response.result;
      invariant(page.requestOffset === cursor, 'read-offset-mismatch');
      checkOffset(page.nextOffset);
      invariant(typeof page.upToDate === 'boolean', 'invalid-page');
      invariant(
        page.payload.contentType.split(';')[0]?.trim().toLowerCase() ===
          CONTROL_STREAM_CONTENT_TYPE,
        'wrong-control-content-type'
      );
      const body = page.payload.body;
      bytesRead += body.byteLength;
      invariant(bytesRead <= MAX_READ_BYTES, 'read-too-large');
      if (body.length > 0 || !page.upToDate) {
        invariant(body.length > 0, 'incomplete-read');
        invariant(!visited.has(page.nextOffset), 'invalid-offset');
      } else {
        invariant(page.nextOffset === cursor || !visited.has(page.nextOffset), 'invalid-offset');
      }
      visited.add(page.nextOffset);
      cursor = page.nextOffset;

      const bytes = new Uint8Array(pending.length + body.length);
      bytes.set(pending);
      bytes.set(body, pending.length);
      const view = new DataView(bytes.buffer);
      let start = 0;
      while (bytes.length - start >= 4) {
        const length = view.getUint32(start, false);
        invariant(length > 0 && length <= MAX_WIRE_BYTES, 'invalid-control-frame-size');
        if (bytes.length - start - 4 < length) break;
        invariant(records.length < MAX_READ_RECORDS, 'read-too-large');
        const wire = decoder.decode(bytes.subarray(start + 4, start + 4 + length));
        decodeRecord(wire);
        records.push(wire);
        start += 4 + length;
      }
      pending = bytes.slice(start);
      if (pending.length === 0) {
        // If an HTTP read split a frame, combine reads up to this boundary. Never
        // invent a cursor for a preceding record or persist a partial frame/page.
        return { records, nextOffset: cursor, upToDate: page.upToDate };
      }
      invariant(!page.upToDate, 'incomplete-control-frame');
    }
    throw new ControlLogError('read-too-large');
  }

  async appendCas(offset: string, wire: string): Promise<'accepted' | 'conflict'> {
    checkOffset(offset);
    const response = await this.client.appendCas({
      expectedOffset: offset,
      part: { contentType: CONTROL_STREAM_CONTENT_TYPE, body: frameControlRecord(wire) },
      // No producer means SDK 0.7.0 will not retry uncertain network writes.
      // The durable outbox owns retries, always with identical bytes and offset.
    });
    if (!response.ok) throw new ControlLogError(`stream-append-${response.result.code}`);
    if (response.result.kind === 'mismatch') {
      invariant(response.result.expectedOffset === offset, 'cas-offset-mismatch');
      checkOffset(response.result.currentOffset);
      return 'conflict';
    }
    invariant(response.result.kind === 'ok', 'invalid-cas-result');
    checkOffset(response.result.value.nextOffset);
    // Even an accepted/duplicate ACK is historical evidence only. The driver must read back.
    return 'accepted';
  }
}

/** Separate precreated binary stream, never the control/CRDT stream. Opaque ciphertext
 * only; HistoryPublisher authenticates its contents. Each operation scans to the tail.
 * Caller must bound HTTP bodies/deadlines before SDK 0.7.0 buffers them. */
export class StreamsHistoryRemote implements HistoryPublicationRemote {
  constructor(private readonly client: Pick<StreamsClient, 'read' | 'appendCas'>) {}

  private async scan(): Promise<{ offset: string; frames: Map<string, Uint8Array> }> {
    let offset = '-1';
    let pending = new Uint8Array(0);
    let total = 0;
    let count = 0;
    const visited = new Set([offset]);
    const frames = new Map<string, Uint8Array>();
    for (let pageNumber = 0; pageNumber < MAX_READ_PAGES; pageNumber++) {
      const response = await this.client.read({ offset });
      if (!response.ok) throw new ControlLogError(`history-read-${response.result.code}`);
      const page = response.result;
      invariant(page.requestOffset === offset, 'read-offset-mismatch');
      checkOffset(page.nextOffset);
      invariant(typeof page.upToDate === 'boolean', 'invalid-page');
      invariant(
        page.payload.contentType.split(';')[0]?.trim().toLowerCase() ===
          CONTROL_STREAM_CONTENT_TYPE,
        'wrong-history-content-type'
      );
      const body = page.payload.body;
      total += body.length;
      invariant(total <= MAX_READ_BYTES, 'read-too-large');
      if (body.length === 0) {
        invariant(page.upToDate && pending.length === 0, 'incomplete-history-read');
        invariant(page.nextOffset === offset || offset === '-1', 'invalid-offset');
        return { offset: page.nextOffset, frames };
      }
      invariant(!visited.has(page.nextOffset), 'invalid-offset');
      visited.add(page.nextOffset);
      offset = page.nextOffset;
      const bytes = new Uint8Array(pending.length + body.length);
      bytes.set(pending);
      bytes.set(body, pending.length);
      let start = 0;
      const view = new DataView(bytes.buffer);
      while (bytes.length - start >= 4) {
        const length = view.getUint32(start, false);
        invariant(length > 16 && length <= 16 + 4234, 'invalid-history-frame-size');
        if (bytes.length - start < 4 + length) break;
        invariant(++count <= MAX_READ_RECORDS, 'read-too-large');
        const id = toHex(bytes.subarray(start + 4, start + 20));
        const frame = bytes.slice(start + 20, start + 4 + length);
        const old = frames.get(id);
        invariant(old === undefined || toHex(old) === toHex(frame), 'history-frame-conflict');
        frames.set(id, frame);
        start += 4 + length;
      }
      pending = bytes.slice(start);
      if (page.upToDate) {
        invariant(pending.length === 0, 'incomplete-history-frame');
        return { offset, frames };
      }
    }
    throw new ControlLogError('read-too-large');
  }

  async read(operationId: string): Promise<Uint8Array | null> {
    checkHex(operationId, 16);
    return (await this.scan()).frames.get(operationId) ?? null;
  }

  async put(
    operationId: string,
    frame: Uint8Array,
    beforeAppend?: () => Promise<() => void>
  ): Promise<void> {
    checkHex(operationId, 16);
    invariant(
      frame instanceof Uint8Array && frame.length > 0 && frame.length <= 4234,
      'invalid-epoch-history'
    );
    const copy = new Uint8Array(frame);
    const snapshot = await this.scan();
    const old = snapshot.frames.get(operationId);
    if (old !== undefined) {
      invariant(toHex(old) === toHex(copy), 'history-frame-conflict');
      return;
    }
    const body = new Uint8Array(20 + copy.length);
    new DataView(body.buffer).setUint32(0, 16 + copy.length, false);
    body.set(fromHex(operationId), 4);
    body.set(copy, 20);
    // A key-delivery caller reauthorizes after the potentially slow scan.
    const check = await beforeAppend?.();
    check?.();
    const response = await this.client.appendCas({
      expectedOffset: snapshot.offset,
      part: { contentType: CONTROL_STREAM_CONTENT_TYPE, body },
    });
    if (!response.ok) throw new ControlLogError(`history-append-${response.result.code}`);
    invariant(response.result.kind === 'ok', 'history-cas-conflict');
    checkOffset(response.result.value.nextOffset);
    // ACK is not availability. HistoryPublisher always performs another read.
  }
}

/** Use a dedicated precreated key-delivery stream, never a control/CRDT/history stream.
 * Reuses bounded ciphertext framing/CAS; credentials and SDK buffering limits stay caller-owned. */
export class StreamsKeyDeliveryRemote implements KeyDeliveryRemote {
  private readonly remote: StreamsHistoryRemote;
  constructor(
    client: Pick<StreamsClient, 'read' | 'appendCas'>,
    private readonly exchange: OrgKeyExchange
  ) {
    this.remote = new StreamsHistoryRemote(client);
  }
  async put(id: string, frame: Uint8Array): Promise<void> {
    checkHex(id, 16);
    invariant(
      frame instanceof Uint8Array && frame.length <= MAX_KEY_ENVELOPE_BYTES,
      'invalid-key-envelope'
    );
    const bytes = new Uint8Array(frame);
    (await this.exchange.authorizeDispatch(bytes))();
    await this.remote.put(id, bytes, () => this.exchange.authorizeDispatch(bytes));
  }
  /** Still unverified ciphertext. Receiver must authenticate before saving/installing. */
  async read(id: string): Promise<Uint8Array | null> {
    const bytes = await this.remote.read(id);
    invariant(bytes === null || bytes.length <= MAX_KEY_ENVELOPE_BYTES, 'invalid-key-envelope');
    return bytes;
  }
}
