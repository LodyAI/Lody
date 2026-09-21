import { describe, expect, it } from 'vitest';
import { normalizeFrameHex, normalizeMultipartBody } from '../src/multipart';

function ascii(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.byteLength; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

describe('multipart transport normalize', () => {
  it('rewrites only delimiter boundary tokens', () => {
    const body = ascii(
      '--rr-bootstrap-abc123\r\nContent-Type: application/octet-stream\r\n\r\nsecret-payload\r\n--rr-bootstrap-abc123--\r\n'
    );
    const normalized = new TextDecoder().decode(normalizeMultipartBody(body));
    expect(normalized).toContain('--rr-bootstrap-*');
    expect(normalized).not.toContain('rr-bootstrap-abc123');
    expect(normalized).toContain('secret-payload');
  });

  it('does not erase boundary-like text inside the protected payload', () => {
    const body = ascii(
      '--rr-bootstrap-abc123\r\n\r\npayload rr-bootstrap-abc123 still here\r\n--rr-bootstrap-abc123--\r\n'
    );
    const normalized = new TextDecoder().decode(normalizeMultipartBody(body));
    expect(normalized).toContain('payload rr-bootstrap-abc123 still here');
    expect(normalized.startsWith('--rr-bootstrap-*')).toBe(true);
  });

  it('leaves illegal bodies unchanged so they cannot become valid', () => {
    const illegal = ascii('not-multipart rr-bootstrap-abc123 trailing');
    expect(Buffer.from(normalizeMultipartBody(illegal)).equals(Buffer.from(illegal))).toBe(true);
    expect(normalizeFrameHex('zz')).toBe('zz');
  });

  it('compares two different random boundaries as equal after normalize', () => {
    const left = ascii('--rr-bootstrap-one\r\n\r\nPAY\r\n--rr-bootstrap-one--\r\n');
    const right = ascii('--rr-bootstrap-two\r\n\r\nPAY\r\n--rr-bootstrap-two--\r\n');
    expect(normalizeFrameHex(Buffer.from(left).toString('hex'))).toBe(
      normalizeFrameHex(Buffer.from(right).toString('hex'))
    );
    const tampered = ascii('--rr-bootstrap-two\r\n\r\nPXX\r\n--rr-bootstrap-two--\r\n');
    expect(normalizeFrameHex(Buffer.from(left).toString('hex'))).not.toBe(
      normalizeFrameHex(Buffer.from(tampered).toString('hex'))
    );
    expect(
      fromHex(normalizeFrameHex(Buffer.from(left).toString('hex'))).byteLength
    ).toBeGreaterThan(8);
  });
});
