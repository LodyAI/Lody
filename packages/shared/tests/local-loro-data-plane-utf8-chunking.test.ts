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
import { createJsonLineSplitter } from '../src/local-loro-data-plane';

const PATH = '01_CH3.5.5_软件研究_申报资料/CH3.5.5.1_软件描述文档.md';

describe('local data-plane UTF-8 chunk decoding', () => {
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
});
