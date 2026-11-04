import { describe, it, expect } from 'vitest';
import { redactProxyUrl, sanitizeUrlForLogging } from './log-sanitize';

describe('sanitizeUrlForLogging', () => {
  it('redacts common sensitive query params', () => {
    const raw = 'wss://example.com/ws/workspaces/abc?token=secret&machineId=xyz';
    expect(sanitizeUrlForLogging(raw)).toBe(
      'wss://example.com/ws/workspaces/abc?token=REDACTED&machineId=xyz'
    );
  });

  it('removes basic auth credentials', () => {
    const raw = 'https://user:pass@example.com/path?token=secret';
    expect(sanitizeUrlForLogging(raw)).toBe('https://example.com/path?token=REDACTED');
  });
});

describe('redactProxyUrl', () => {
  it('redacts credentials in proxy URLs', () => {
    const raw = 'http://user:pass@proxy.example.com:8080';
    expect(redactProxyUrl(raw)).toBe('http://[redacted]@proxy.example.com:8080');
  });
});
