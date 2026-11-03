import { describe, expect, it } from 'vitest';

import { detectToolCallJsonText } from '../src/lib/tool-call-json-text';

describe('detectToolCallJsonText', () => {
  it('never re-serializes: integer lexemes beyond 2^53 keep their exact digits', () => {
    // JSON.parse rounds these to ...776000 / ...000120 (sic); re-stringifying
    // would display an identifier the upstream tool never received.
    const text = '{"id":9223372036854775807,"snowflake":1737000000000000123}';
    expect(detectToolCallJsonText(text)).toBe(text);
  });
});
