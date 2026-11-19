import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { streamsSnapshotCodec } from '@lody/shared/streams-snapshot-codec';
import { describe, expect, it } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import { StreamsCrdt, createLoroDocAdapter } from '@loro-dev/streams-crdt/loro';

import {
  DEFAULT_LORO_STREAMS_BASE_URL,
  DEFAULT_LORO_STREAMS_PRESENCE_BASE_URL,
  DEFAULT_LORO_STREAMS_PROXY_HOST_SUFFIX,
  LEGACY_LORO_STREAMS_BASE_URL,
  LORO_STREAMS_REMOTE_CURSOR_HISTORICAL_ALIAS_BASE_URLS,
  LORO_STREAMS_LARGE_POST_SHARD_MIN_BYTES,
  getLoroStreamsRemoteCursorUrlAliases,
  getLoroStreamsBaseUrl,
  isLoroStreamsWebSocketEnabled,
  loroStreamsWebSocketOptions,
  getLoroStreamsPresenceBaseUrl,
  getLoroStreamsShardUrls,
  normalizeLoroStreamsShardHostSuffix,
  type SessionId,
  type WorkspaceId,
} from '../src';

const workspaceId = 'workspace-1' as WorkspaceId;
const sessionId = 'session-1' as SessionId;

describe('loro streams helpers', () => {
  it.each([undefined, '', 'false', '0', 'TRUE', 'yes', true])(
    'keeps WS disabled for non opt-in environment %s',
    (value) => {
      expect(
        loroStreamsWebSocketOptions(
          isLoroStreamsWebSocketEnabled(undefined, value),
          'https://gateway.test',
          'workspace'
        )
      ).toEqual({});
    }
  );
  it.each(['1', 'true'])(
    'accepts explicit WS environment %s, with explicit false taking precedence',
    (value) => {
      expect(isLoroStreamsWebSocketEnabled(undefined, value)).toBe(true);
      expect(isLoroStreamsWebSocketEnabled(false, value)).toBe(false);
      expect(isLoroStreamsWebSocketEnabled(true, '0')).toBe(true);
    }
  );
  it('lets a Convex isolate bundle and execute protocol helpers without loading snapshot compression', async () => {
    const result = await build({
      stdin: {
        contents:
          'import { getServerNow } from "@lody/shared"; globalThis.clockResult = getServerNow();',
        resolveDir: fileURLToPath(new URL('..', import.meta.url)),
      },
      bundle: true,
      platform: 'browser',
      format: 'iife',
      write: false,
      logLevel: 'silent',
    });
    const context = {
      Date: class extends Date {
        static now() {
          return 123456;
        }
      },
      clockResult: 0,
    };
    runInNewContext(result.outputFiles[0]!.text, context);
    expect(context.clockResult).toBe(123456);
  });
  it('requires an injected base url and normalizes it', () => {
    expect(DEFAULT_LORO_STREAMS_BASE_URL).toBe('https://streams.invalid');
    expect(() => getLoroStreamsBaseUrl(undefined)).toThrow(/must be provided/);
    expect(getLoroStreamsBaseUrl('https://streams.example.com///')).toBe(
      'https://streams.example.com'
    );
  });

  it('routes presence traffic to the dedicated compatibility host only for the sentinel proxy', () => {
    expect(DEFAULT_LORO_STREAMS_PRESENCE_BASE_URL).toBe('https://presence.streams.invalid');
    expect(() => getLoroStreamsPresenceBaseUrl(undefined)).toThrow(/must be provided/);
    expect(getLoroStreamsPresenceBaseUrl(`${DEFAULT_LORO_STREAMS_BASE_URL}/`)).toBe(
      DEFAULT_LORO_STREAMS_PRESENCE_BASE_URL
    );
    expect(getLoroStreamsPresenceBaseUrl(LEGACY_LORO_STREAMS_BASE_URL)).toBe(
      LEGACY_LORO_STREAMS_BASE_URL
    );
    expect(getLoroStreamsPresenceBaseUrl('http://127.0.0.1:8787///')).toBe('http://127.0.0.1:8787');
  });

  it('does not shard presence for non-default proxies even with a shard id', () => {
    expect(getLoroStreamsPresenceBaseUrl(LEGACY_LORO_STREAMS_BASE_URL, 'a')).toBe(
      LEGACY_LORO_STREAMS_BASE_URL
    );
    expect(getLoroStreamsPresenceBaseUrl('http://127.0.0.1:8787///', 'a')).toBe(
      'http://127.0.0.1:8787'
    );
  });

  it('builds remote cursor URL aliases for gateway compatibility', () => {
    const previousProxyBaseUrl = LORO_STREAMS_REMOTE_CURSOR_HISTORICAL_ALIAS_BASE_URLS[0];
    expect(
      getLoroStreamsRemoteCursorUrlAliases(
        `${DEFAULT_LORO_STREAMS_BASE_URL}/ds/lody/workspace:meta`
      )
    ).toEqual([
      `${previousProxyBaseUrl}/ds/lody/workspace:meta`,
      `${LEGACY_LORO_STREAMS_BASE_URL}/ds/lody/workspace:meta`,
    ]);
    expect(
      getLoroStreamsRemoteCursorUrlAliases(`${previousProxyBaseUrl}/ds/lody/workspace:meta`)
    ).toEqual([
      `${DEFAULT_LORO_STREAMS_BASE_URL}/ds/lody/workspace:meta`,
      `${LEGACY_LORO_STREAMS_BASE_URL}/ds/lody/workspace:meta`,
    ]);
    expect(
      getLoroStreamsRemoteCursorUrlAliases(`${LEGACY_LORO_STREAMS_BASE_URL}/ds/lody/workspace:meta`)
    ).toEqual([
      `${DEFAULT_LORO_STREAMS_BASE_URL}/ds/lody/workspace:meta`,
      `${previousProxyBaseUrl}/ds/lody/workspace:meta`,
    ]);
  });

  it('builds shard URLs only for the default proxy origin', () => {
    const shardUrls = getLoroStreamsShardUrls(DEFAULT_LORO_STREAMS_BASE_URL);
    expect(shardUrls?.bootstrap).toHaveLength(3);
    expect(shardUrls?.bootstrap?.[0]).toBe(
      `https://control-a.${DEFAULT_LORO_STREAMS_PROXY_HOST_SUFFIX}`
    );
    expect(shardUrls?.bootstrap?.[2]).toBe(
      `https://control-c.${DEFAULT_LORO_STREAMS_PROXY_HOST_SUFFIX}`
    );
    expect(shardUrls?.catchup?.[0]).toBe(
      `https://control-a.${DEFAULT_LORO_STREAMS_PROXY_HOST_SUFFIX}`
    );
    expect(shardUrls?.largePost?.[0]).toBe(
      `https://write-a.${DEFAULT_LORO_STREAMS_PROXY_HOST_SUFFIX}`
    );
    expect(shardUrls?.largePost?.[3]).toBe(
      `https://write-d.${DEFAULT_LORO_STREAMS_PROXY_HOST_SUFFIX}`
    );
    expect(shardUrls?.other).toHaveLength(2);
    expect(shardUrls?.other?.[0]).toBe(`https://api-a.${DEFAULT_LORO_STREAMS_PROXY_HOST_SUFFIX}`);
    expect(shardUrls?.other?.[1]).toBe(`https://api-b.${DEFAULT_LORO_STREAMS_PROXY_HOST_SUFFIX}`);
    expect(shardUrls?.largePostMinBytes).toBe(LORO_STREAMS_LARGE_POST_SHARD_MIN_BYTES);
    expect(getLoroStreamsShardUrls(LEGACY_LORO_STREAMS_BASE_URL)).toBeUndefined();
    expect(getLoroStreamsShardUrls('http://127.0.0.1:8787')).toBeUndefined();
  });

  it('shards presence for any gateway when a runtime topology suffix is injected', () => {
    expect(
      getLoroStreamsPresenceBaseUrl('https://api.streams.example.com', '07', 'streams.example.com')
    ).toBe('https://presence-07.streams.example.com');
    expect(
      getLoroStreamsPresenceBaseUrl(
        'https://api.streams.example.com',
        undefined,
        'streams.example.com'
      )
    ).toBe('https://presence.streams.example.com');
    // Unknown shard ids still fall back to the canonical presence host.
    expect(
      getLoroStreamsPresenceBaseUrl('https://api.streams.example.com', 'zz', 'streams.example.com')
    ).toBe('https://presence.streams.example.com');
    // The injected topology also applies to the sentinel origin.
    expect(
      getLoroStreamsPresenceBaseUrl(DEFAULT_LORO_STREAMS_BASE_URL, '01', 'streams.example.com')
    ).toBe('https://presence-01.streams.example.com');
  });

  it('rejects malformed topology suffixes instead of steering traffic to stray origins', () => {
    for (const invalid of [
      'https://streams.example.com',
      'streams.example.com/path',
      'streams.example.com:8443',
      'single-label',
      ' ',
      '',
    ]) {
      expect(getLoroStreamsPresenceBaseUrl('https://api.streams.example.com', '01', invalid)).toBe(
        'https://api.streams.example.com'
      );
      expect(getLoroStreamsShardUrls('https://api.streams.example.com', invalid)).toBeUndefined();
    }
    expect(normalizeLoroStreamsShardHostSuffix(' Streams.Example.COM ')).toBe(
      'streams.example.com'
    );
  });

  it('builds shard URLs for any gateway when a runtime topology suffix is injected', () => {
    const shardUrls = getLoroStreamsShardUrls(
      'https://api.streams.example.com',
      'streams.example.com'
    );
    expect(shardUrls?.bootstrap?.[0]).toBe('https://control-a.streams.example.com');
    expect(shardUrls?.largePost?.[3]).toBe('https://write-d.streams.example.com');
    expect(shardUrls?.other?.[1]).toBe('https://api-b.streams.example.com');
    expect(shardUrls?.largePostMinBytes).toBe(LORO_STREAMS_LARGE_POST_SHARD_MIN_BYTES);
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
