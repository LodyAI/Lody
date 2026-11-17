import { describe, expect, it } from 'vitest';
import { isToolCommandEcho } from '../src/components/ai-gui/tool-call-command';
import { detectToolCallJsonText } from '../src/lib/tool-call-json-text';

describe('tool-call-command', () => {
  describe('isToolCommandEcho', () => {
    it('matches a linked path echo without hiding a different command or result', () => {
      const command = 'grep READY /tmp/build-check.log | tail -5';
      const linked = 'grep READY [/tmp/build-check.log](file:///tmp/build-check.log) | tail -5';
      expect(isToolCommandEcho(linked, [command])).toBe(true);
      expect(isToolCommandEcho(`${linked}\nBuild failed`, [command])).toBe(false);
      expect(isToolCommandEcho(linked, ['grep FAILED /tmp/build-check.log | tail -5'])).toBe(false);
    });
  });
});

describe('tool-call-json-text', () => {
  describe('detectToolCallJsonText', () => {
    it('never re-serializes: integer lexemes beyond 2^53 keep their exact digits', () => {
      // JSON.parse rounds these to ...776000 / ...000120 (sic); re-stringifying
      // would display an identifier the upstream tool never received.
      const text = '{"id":9223372036854775807,"snowflake":1737000000000000123}';
      expect(detectToolCallJsonText(text)).toBe(text);
    });
  });
});
