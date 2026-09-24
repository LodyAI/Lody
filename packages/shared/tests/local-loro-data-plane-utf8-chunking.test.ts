/**
 * Regression test: the local data-plane framing must decode UTF-8 across socket
 * chunk boundaries.
 *
 * Both ends of the data plane used to call `chunk.toString('utf8')` on every
 * socket chunk. A chunk boundary lands at an arbitrary byte offset, so a
 * multi-byte character split across two chunks decoded to U+FFFD on both sides.
 * Flock bundles carry file paths as literal UTF-8 JSON, so a mangled path became
 * a NEW LWW key in the receiver's replica — a garbled `@file` row that no later
 * republish could overwrite.
 *
 * The split offsets here are exact, not random: every byte position inside one
 * CJK character is exercised, so the test cannot pass by landing on a boundary.
 */
import { describe, expect, it } from 'vitest';
import { createJsonLineSplitter, createUtf8StreamDecoder } from '../src/local-loro-data-plane';

const PATH = '01_CH3.5.5_软件研究_申报资料/CH3.5.5.1_软件描述文档.md';

describe('local data-plane UTF-8 chunk decoding', () => {
  it('decodes a character split across chunks', () => {
    const bytes = new TextEncoder().encode('软件描述文档');
    // '软' is 3 bytes: split after its first and after its second byte.
    for (const offset of [1, 2]) {
      const decode = createUtf8StreamDecoder();
      const decoded = decode(bytes.subarray(0, offset)) + decode(bytes.subarray(offset));
      expect(decoded).toBe('软件描述文档');
    }
  });

  it('reassembles a flock bundle frame split at every byte offset', () => {
    const frame = `${JSON.stringify({ kind: 'flock-json', entries: { [PATH]: { kind: 'file' } } })}\n`;
    const bytes = new TextEncoder().encode(frame);

    for (let offset = 1; offset < bytes.byteLength; offset += 1) {
      const lines: string[] = [];
      const splitLines = createJsonLineSplitter({ onLine: (line) => lines.push(line) });
      splitLines(bytes.subarray(0, offset));
      splitLines(bytes.subarray(offset));

      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0] as string) as { entries: Record<string, unknown> };
      expect(Object.keys(parsed.entries)).toEqual([PATH]);
      expect(lines[0]).not.toContain('\uFFFD');
    }
  });

  it('still accepts already-decoded string chunks', () => {
    const lines: string[] = [];
    const splitLines = createJsonLineSplitter({ onLine: (line) => lines.push(line) });
    splitLines('{"a":1}\n{"b":');
    splitLines('2}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('reassembles a large frame from small byte chunks without emitting a partial line', () => {
    const frame = JSON.stringify({ data: 'x'.repeat(1_100_000) });
    const bytes = new TextEncoder().encode(frame);
    const lines: string[] = [];
    const splitLines = createJsonLineSplitter({ onLine: (line) => lines.push(line) });
    for (let offset = 0; offset < bytes.length; offset += 64) {
      splitLines(bytes.subarray(offset, offset + 64));
    }
    expect(lines).toEqual([]);
    splitLines('\n{"next":true}\n');
    expect(lines).toEqual([frame, '{"next":true}']);
  });

  it('trims complete lines before checking the cap but caps untrimmed partial lines', () => {
    const events: string[] = [];
    const splitLines = createJsonLineSplitter({
      maxBufferBytes: 4,
      onLine: (line) => events.push(line),
      onOverflow: () => events.push('overflow'),
    });
    splitLines(' 12');
    splitLines('34 \r\n\t \n');
    splitLines('1234');
    splitLines('');
    splitLines('\n');
    splitLines('     ');
    splitLines('discarded');
    splitLines('\n12345\n12\n3');
    splitLines('4\n');
    expect(events).toEqual(['1234', '1234', 'overflow', 'overflow', '12', '34']);
  });

  it('counts decoded characters across multibyte chunk boundaries for the cap', () => {
    const events: string[] = [];
    const splitLines = createJsonLineSplitter({
      maxBufferBytes: 4,
      onLine: (line) => events.push(line),
      onOverflow: () => events.push('overflow'),
    });
    const bytes = new TextEncoder().encode('软😀件\n软😀件多\n好\n');
    for (const byte of bytes) {
      splitLines(Uint8Array.of(byte));
    }
    expect(events).toEqual(['软😀件', 'overflow', '好']);
  });

  it('retains unprocessed lines and a partial tail when a callback throws', () => {
    const lines: string[] = [];
    const splitLines = createJsonLineSplitter({
      onLine: (line) => {
        lines.push(line);
        if (line === 'first') {
          throw new Error('callback failed');
        }
      },
    });
    splitLines('fir');
    expect(() => splitLines('st\nsecond\nthi')).toThrow('callback failed');
    splitLines('rd\n');
    expect(lines).toEqual(['first', 'second', 'third']);
  });
});
