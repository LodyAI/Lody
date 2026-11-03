import { describe, expect, it } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import { StreamsCrdt, createLoroDocAdapter } from '@loro-dev/streams-crdt/loro';

import { streamsSnapshotCodec } from '../src';

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
