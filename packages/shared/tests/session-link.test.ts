import { describe, expect, it } from 'vitest';
import { buildSessionLink, parseSessionLink, resolveSessionLinkId } from '../src/session-link';
import { normalizeSessionLinksForExport } from '../src/session-link-export';

describe('session resource links', () => {
  it.each([
    ['See session://abc.', 'See lody://session/abc?workspace=ws.'],
    ['**session://abc**', '**lody://session/abc?workspace=ws**'],
    ['_session://abc_', '_lody://session/abc?workspace=ws_'],
    ['session://abc，后续', 'lody://session/abc?workspace=ws，后续'],
    ['https://example.test/session://abc', 'https://example.test/session://abc'],
    ['No links or only https://example.test', 'No links or only https://example.test'],
  ])('normalizes prose without absorbing Markdown delimiters: %s', (source, expected) => {
    expect(normalizeSessionLinksForExport(source, 'ws')).toBe(expected);
  });
  it('exports portable links without rebinding explicit workspaces or changing code', () => {
    const source = [
      '[@Old](session://Child_A)',
      '[Other](lody-oss://session/B?workspace=foreign)',
      '`session://inline` and ``session://double``',
      '`multiline\nsession://example`',
      '> ```md\n> [Example](session://quoted)\n> ```',
      '<!-- session://comment -->',
      '[External](https://example.test/?next=session://keep)',
      '```md',
      '[Example](session://example)',
      '```',
      '    session://indented',
      'session://invalid/path',
    ].join('\n');
    expect(normalizeSessionLinksForExport(source, 'ws_1')).toBe(
      source
        .replace('session://Child_A', 'lody://session/Child_A?workspace=ws_1')
        .replace('lody-oss://', 'lody://')
    );
    expect(normalizeSessionLinksForExport('[Old](session://A)')).toBe('[Old](lody://session/A)');
  });
  it('round trips an exact workspace and child target without changing ID case', () => {
    const target = { sessionId: 'Root_A', workspaceId: 'lw_One', tabSessionId: 'Child_B' };
    expect(buildSessionLink(target)).toBe('lody://session/Root_A?workspace=lw_One&tab=Child_B');
    expect(parseSessionLink(buildSessionLink(target))).toEqual(target);
  });

  it.each(['lody', 'lody-oss', 'ai.lody.nightly'])(
    'reads %s resources and emits the common scheme',
    (scheme) => {
      const target = parseSessionLink(`${scheme}://session/Ab_c?workspace=ws_1`);
      expect(target).toEqual({ sessionId: 'Ab_c', workspaceId: 'ws_1' });
      expect(buildSessionLink(target!)).toBe('lody://session/Ab_c?workspace=ws_1');
    }
  );

  it('retains legacy references and enforces the MCP workspace boundary', () => {
    expect(parseSessionLink('session://Ab_c/')).toEqual({ sessionId: 'Ab_c' });
    expect(resolveSessionLinkId('session://Ab_c', 'ws_1')).toBe('Ab_c');
    expect(resolveSessionLinkId('lody://session/Ab_c?workspace=ws_1', 'ws_1')).toBe('Ab_c');
    expect(() => resolveSessionLinkId('lody://session/Ab_c?workspace=ws_2', 'ws_1')).toThrow(
      'different workspace'
    );
    expect(() => resolveSessionLinkId('lody://session/root?tab=child', 'ws_1')).toThrow(
      'child session ID'
    );
  });

  it.each([
    'lody://session/a/../b',
    'lody://session/a%2fb',
    'lody://session/a%252fb',
    'lody://session/id?workspace=a&workspace=b',
    'lody://session/id?workspace=',
    'lody://session/id?workspace=a+space',
    'lody://session/id?command=delete',
    'lody://user@session/id',
    'lody://session:12/id',
    'lody://session/id#token=secret',
    'https://session/id',
    'lody://auth/callback',
    'lody://session/id\\other',
    'prefix lody://session/id',
    `lody://session/${'a'.repeat(8192)}`,
  ])('rejects malformed or non-resource input: %s', (url) => {
    expect(parseSessionLink(url)).toBeNull();
  });
});
