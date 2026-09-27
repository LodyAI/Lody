import { describe, expect, it } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import { StreamsCrdt, createLoroDocAdapter } from '@loro-dev/streams-crdt/loro';

import { compressStreamsSnapshot, decompressStreamsSnapshot, streamsSnapshotCodec } from '../src';

describe('streams snapshot codec', () => {
  it('round trips zstd-compressed snapshots', async () => {
    const snapshot = new TextEncoder().encode('hello snapshot');

    const compressed = await compressStreamsSnapshot(snapshot);
    const decompressed = await decompressStreamsSnapshot(compressed);

    expect(Array.from(compressed)).not.toEqual(Array.from(snapshot));
    expect(Array.from(decompressed)).toEqual(Array.from(snapshot));
  });

  it('keeps legacy uncompressed snapshots readable', async () => {
    const snapshot = new Uint8Array([1, 2, 3, 4, 5]);

    const decompressed = await decompressStreamsSnapshot(snapshot);

    expect(decompressed).toBe(snapshot);
  });

  it('exports a codec object that matches the helper functions', async () => {
    const snapshot = new TextEncoder().encode('codec object');

    const compressed = await streamsSnapshotCodec.compress(snapshot);
    const decompressed = await streamsSnapshotCodec.decompress(compressed);

    expect(Array.from(decompressed)).toEqual(Array.from(snapshot));
  });
});

describe('Streams bootstrap with the Lody snapshot codec', () => {
  it.each([false, true])(
    'imports a real document snapshot (compressed=%s) at its continuation offset',
    async (compressed) => {
      const author = new LoroDoc();
      author.getMap('state').set('value', 'restored');
      author.commit();
      const snapshot = author.export({ mode: 'snapshot' });
      const body = compressed ? await streamsSnapshotCodec.compress(snapshot) : snapshot;
      const replica = new LoroDoc();
      const transport = new StreamsCrdt({
        streamUrl: 'https://streams.example.com/v1/streams/snapshot-test',
        adapter: createLoroDocAdapter(replica),
        snapshotCodec: streamsSnapshotCodec,
        fetch: async (input) => {
          expect(String(input)).toContain('/bootstrap');
          const bytes = Buffer.concat([
            Buffer.from('--snapshot-boundary\r\nContent-Type: application/octet-stream\r\n\r\n'),
            body,
            Buffer.from('\r\n--snapshot-boundary--\r\n'),
          ]);
          return new Response(bytes, {
            headers: {
              'Content-Type': 'multipart/mixed; boundary=snapshot-boundary',
              'Stream-Snapshot-Offset': '123',
              'Stream-Next-Offset': '123',
              'Stream-Up-To-Date': 'true',
            },
          });
        },
      });
      try {
        const result = await transport.catchup();
        expect(result.ok).toBe(true);
        expect(replica.toJSON()).toEqual(author.toJSON());
      } finally {
        await transport.close();
        replica.free();
        author.free();
      }
    }
  );
});
