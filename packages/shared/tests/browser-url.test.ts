import { describe, expect, it } from 'vitest';
import {
  BrowserAddressError,
  classifyBrowserHostname,
  classifyResolvedBrowserAddress,
  formatPreviewTargetUrl,
  parseBrowserAddress,
} from '../src/browser-url';

describe('parseBrowserAddress', () => {
  it.each([
    ['localhost:5173/path?q=1#hash', 'loopback', 'http://localhost:5173/path?q=1#hash'],
    ['127.1:3000', 'loopback', 'http://127.0.0.1:3000/'],
    ['10.12.0.9:8080', 'private-lan', 'http://10.12.0.9:8080/'],
    ['172.31.0.1', 'private-lan', 'http://172.31.0.1/'],
    ['192.168.1.10', 'private-lan', 'http://192.168.1.10/'],
    ['https://[fc00::1]:8443/a', 'private-lan', 'https://[fc00::1]:8443/a'],
  ])('routes %s through managed preview', (input, targetClass, logicalUrl) => {
    const result = parseBrowserAddress(input);
    expect(result).toMatchObject({
      engine: 'managed-preview',
      targetClass,
      logicalUrl,
    });
    expect(result.target).toBeDefined();
  });

  it.each([
    ['example.com', 'https://example.com/'],
    ['http://example.com:8080/docs', 'http://example.com:8080/docs'],
    ['https://8.8.8.8/search', 'https://8.8.8.8/search'],
  ])('routes %s through public web', (input, logicalUrl) => {
    expect(parseBrowserAddress(input)).toEqual({
      engine: 'public-web',
      targetClass: 'public',
      logicalUrl,
    });
  });

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

describe('classifyResolvedBrowserAddress', () => {
  it.each(['198.18.0.1', '198.18.3.75', '198.19.255.254', '[::ffff:c612:34b]'])(
    'prohibits %s, which a fake-IP proxy answer and a hostile DNS record share',
    (address) => {
      expect(classifyResolvedBrowserAddress(address)).toBe('prohibited');
    }
  );

  it.each([
    ['127.0.0.1', 'loopback'],
    ['10.0.0.8', 'private-lan'],
    ['[::ffff:c0a8:101]', 'private-lan'],
    ['169.254.169.254', 'prohibited'],
    ['198.17.255.255', 'public'],
    ['198.20.0.0', 'public'],
    ['198.51.100.7', 'prohibited'],
    ['[fe80::1]', 'prohibited'],
  ])('classifies resolved %s as %s', (address, targetClass) => {
    expect(classifyResolvedBrowserAddress(address)).toBe(targetClass);
  });

  it('gives a resolver answer no exemption a typed hostname would not get', () => {
    for (const address of ['198.18.3.75', '127.0.0.1', '10.0.0.8', '93.184.216.34']) {
      expect(classifyResolvedBrowserAddress(address)).toBe(classifyBrowserHostname(address));
    }
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
