import { describe, expect, it } from 'vitest';
import {
  BrowserAddressError,
  classifyBrowserHostname,
  formatPreviewTargetUrl,
  parseBrowserAddress,
} from '../src/browser-url';

describe('parseBrowserAddress', () => {
  it.each([
    ['localhost:5173/path?q=1#hash', 'http://localhost:5173/path?q=1#hash'],
    ['127.1:3000', 'http://127.0.0.1:3000/'],
    ['http://[::1]:4000/', 'http://[::1]:4000/'],
  ])('routes loopback %s through managed preview', (input, logicalUrl) => {
    const result = parseBrowserAddress(input);
    expect(result).toMatchObject({
      engine: 'managed-preview',
      targetClass: 'loopback',
      logicalUrl,
    });
    expect(result.target).toBeDefined();
  });

  it.each([
    ['example.com', 'public', 'https://example.com/'],
    ['http://example.com:8080/docs', 'public', 'http://example.com:8080/docs'],
    ['https://8.8.8.8/search', 'public', 'https://8.8.8.8/search'],
  ])('routes %s through public web', (input, targetClass, logicalUrl) => {
    expect(parseBrowserAddress(input)).toEqual({ engine: 'public-web', targetClass, logicalUrl });
  });

  // A LAN address is the user's own local browser reaching the user's own network.
  // Sending it through the agent machine would make that machine a pivot into its
  // LAN, so it must never route to managed preview — only loopback does.
  it.each([
    ['10.12.0.9:8080', 'http://10.12.0.9:8080/'],
    ['172.31.0.1', 'http://172.31.0.1/'],
    ['192.168.1.10', 'http://192.168.1.10/'],
    ['https://[fc00::1]:8443/a', 'https://[fc00::1]:8443/a'],
    ['printer.local', 'http://printer.local/'],
    ['host.docker.internal:9000', 'http://host.docker.internal:9000/'],
  ])(
    'keeps private LAN %s in the local public browser, never managed preview',
    (input, logicalUrl) => {
      expect(parseBrowserAddress(input)).toEqual({
        engine: 'public-web',
        targetClass: 'private-lan',
        logicalUrl,
      });
    }
  );

  it.each([
    'file:///tmp/a',
    'javascript:alert(1)',
    'data:123',
    '//example.com',
    'http://user:secret@example.com',
    'http://0.0.0.0:3000',
    'http://169.254.169.254/latest/meta-data',
    'http://[fe80::1]/',
    'http://example.com\\@127.0.0.1',
    'https://example.com\n',
  ])('rejects %s', (input) => {
    expect(() => parseBrowserAddress(input)).toThrow(BrowserAddressError);
  });

  it('normalizes alternate IPv4 encodings before classification', () => {
    expect(parseBrowserAddress('http://0x7f000001:5173')).toMatchObject({
      engine: 'managed-preview',
      targetClass: 'loopback',
      logicalUrl: 'http://127.0.0.1:5173/',
    });
  });
});

describe('classifyBrowserHostname', () => {
  it('classifies mapped IPv4 addresses using the embedded address', () => {
    expect(classifyBrowserHostname('[::ffff:7f00:1]')).toBe('loopback');
    expect(classifyBrowserHostname('[::ffff:c0a8:101]')).toBe('private-lan');
  });

  it('treats local DNS names as managed targets', () => {
    expect(classifyBrowserHostname('devbox.local')).toBe('private-lan');
    expect(classifyBrowserHostname('host.docker.internal')).toBe('private-lan');
  });

  it('prohibits literal RFC 2544 benchmarking addresses', () => {
    expect(classifyBrowserHostname('198.18.3.75')).toBe('prohibited');
    expect(classifyBrowserHostname('198.19.255.1')).toBe('prohibited');
    expect(() => parseBrowserAddress('http://198.18.3.75/')).toThrow(BrowserAddressError);
  });
});

describe('formatPreviewTargetUrl', () => {
  it('formats an IPv6 target with its relative location', () => {
    expect(
      formatPreviewTargetUrl({
        protocol: 'https',
        host: 'fc00::1',
        port: 8443,
        path: '/settings?tab=team#members',
      })
    ).toBe('https://[fc00::1]:8443/settings?tab=team#members');
  });
});
