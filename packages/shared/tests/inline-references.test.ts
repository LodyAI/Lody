import { describe, expect, it } from 'vitest';
import {
  encodeBrowserPageReference,
  parseBrowserPageReference,
  parseReferenceUrl,
  getUrlReferenceKind,
} from '../src/inline-references';

describe('inline reference destinations', () => {
  it.each([
    'javascript:alert(1)',
    'file:///etc/passwd',
    'https://user:secret@example.com',
    'https://example.com/\nnext',
    'https://',
  ])('rejects %s', (url) => {
    expect(parseReferenceUrl(url)).toBeNull();
  });
  it('preserves paths, query parameters, and fragments', () => {
    const url = 'https://example.com/a%2Fb?q=x%26y&tab=2#section';
    expect(parseReferenceUrl(url)?.href).toBe(url);
  });
  it('specializes only repository roots', () => {
    expect(getUrlReferenceKind('https://github.com/LodyAI/Lody')).toBe('github_repo');
    for (const url of [
      'https://github.com/LodyAI/Lody/issues/1',
      'https://github.com/LodyAI/Lody#readme',
      'https://github.com/settings/profile',
      'https://github.com/orgs/acme',
      'https://github.com.evil.test/LodyAI/Lody',
    ]) {
      expect(getUrlReferenceKind(url)).toBe('url');
    }
  });
  it('freezes logical browser identity while discarding transport credentials', () => {
    const target = encodeBrowserPageReference({
      version: 1,
      machineId: 'machine',
      sessionId: 'session',
      title: 'Original page',
      url: 'http://localhost:3000/docs?tab=one&__lody_preview_token=secret&__lody_local_preview_session=secret#section',
    });
    expect(target).not.toContain('secret');
    expect(parseBrowserPageReference(target!)).toEqual({
      version: 1,
      machineId: 'machine',
      sessionId: 'session',
      title: 'Original page',
      url: 'http://localhost:3000/docs?tab=one#section',
    });
  });
  it('preserves signed query octets when removing transport parameters', () => {
    const target = encodeBrowserPageReference({
      version: 1,
      machineId: 'm',
      sessionId: 's',
      url: 'https://example.com/?q=a%20b&sig=~&__lody_preview_token=secret#part',
    });
    expect(parseBrowserPageReference(target!)?.url).toBe('https://example.com/?q=a%20b&sig=~#part');
  });
  it.each([
    'null',
    '[]',
    '{}',
    '{',
    '{"version":2,"machineId":"m","sessionId":"s","url":"https://example.com"}',
    '{"version":1,"machineId":"","sessionId":"s","url":"https://example.com"}',
  ])('rejects malformed browser target %s', (target) => {
    expect(parseBrowserPageReference(target)).toBeNull();
  });
});
