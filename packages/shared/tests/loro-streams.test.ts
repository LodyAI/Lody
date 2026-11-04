import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LORO_STREAMS_BASE_URL,
  DEFAULT_LORO_STREAMS_PRESENCE_BASE_URL,
  DEFAULT_LORO_STREAMS_PROXY_HOST_SUFFIX,
  LEGACY_LORO_STREAMS_BASE_URL,
  LORO_STREAMS_REMOTE_CURSOR_HISTORICAL_ALIAS_BASE_URLS,
  LORO_STREAMS_LARGE_POST_SHARD_MIN_BYTES,
  getLoroStreamsRemoteCursorUrlAliases,
  getLoroStreamsBaseUrl,
  getLoroStreamsPresenceBaseUrl,
  getLoroStreamsShardUrls,
  normalizeLoroStreamsShardHostSuffix,
  type SessionId,
  type WorkspaceId,
} from '../src';

const workspaceId = 'workspace-1' as WorkspaceId;
const sessionId = 'session-1' as SessionId;

describe('loro streams helpers', () => {
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
