import { describe, expect, it } from 'vitest';

import {
  isTextPreviewable,
  passesTextCoarseFilter,
  sniffLooksLikeText,
} from '../src/session-file-text';

const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);

describe('sniffLooksLikeText', () => {
  it('tolerates a multibyte code point truncated by the sniff window', () => {
    // "界" (U+754C) is 0xE7 0x95 0x8C. Cut after the first byte: the truncated
    // partial sequence must be ignored, not treated as invalid UTF-8.
    const full = bytes('ok界');
    const cut = full.subarray(0, full.length - 2); // drop last 2 of the 3-byte char
    expect(sniffLooksLikeText(cut)).toBe(true);
  });

  it('tolerates truncation in the middle of a 4-byte emoji', () => {
    const full = bytes('a🚀'); // 🚀 = 0xF0 0x9F 0x9A 0x80
    expect(sniffLooksLikeText(full.subarray(0, full.length - 1))).toBe(true);
    expect(sniffLooksLikeText(full.subarray(0, full.length - 2))).toBe(true);
    expect(sniffLooksLikeText(full.subarray(0, full.length - 3))).toBe(true);
  });
});

describe('isTextPreviewable', () => {
  it('passes a real text file', () => {
    expect(isTextPreviewable('readme.md', 'text/markdown', bytes('# Title\nbody'))).toBe(true);
  });

  it('passes an extension-less Dockerfile with text content', () => {
    expect(isTextPreviewable('Dockerfile', undefined, bytes('FROM node:20\nRUN echo hi'))).toBe(
      true
    );
  });

  it('rejects a .bin renamed to .txt (sniff blocks it)', () => {
    const binary = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]);
    // Coarse filter passes (.txt) but the NUL byte fails the sniff.
    expect(passesTextCoarseFilter('payload.txt', undefined)).toBe(true);
    expect(isTextPreviewable('payload.txt', undefined, binary)).toBe(false);
  });

  it('rejects a binary file even with text content sniff when coarse filter fails', () => {
    expect(isTextPreviewable('image.png', undefined, bytes('not really a png'))).toBe(false);
  });

  it('treats an empty text file as previewable', () => {
    expect(isTextPreviewable('empty.txt', undefined, new Uint8Array(0))).toBe(true);
  });
});
